import type { Cursor, LoroDoc, LoroText } from 'loro-crdt'
import { setText, setTextAt, transact, type ComponentResolver } from '@baren/schema'
import { ORIGIN, deleteNodes } from '../doc/ops.ts'
import { readText, textContainer } from '../doc/read.ts'
import type { History } from '../doc/history.ts'

/** Reads and writes a text node: real ids through LoroText, instance content as overrides. */
export interface TextIO {
  read(id: string): string
  write(id: string, text: string): void
  container(id: string): LoroText | null
}

/** Text access for `doc` (virtual ids go through `resolver` and `setTextAt`). */
export function textIO(doc: LoroDoc, resolver: () => ComponentResolver): TextIO {
  return {
    read: (id) => (id.includes('/') ? (resolver().resolveNode(id)?.text ?? '') : readText(doc, id)),
    write: (id, text) => {
      if (id.includes('/')) setTextAt(doc, id, text, { origin: ORIGIN.text, resolver: resolver() })
      else transact(doc, () => setText(doc, id, text), { origin: ORIGIN.text })
    },
    container: (id) => (id.includes('/') ? null : textContainer(doc, id)),
  }
}

/** Character offsets of the current DOM selection inside `el`, or null if it is elsewhere. */
export function selectionOffsets(el: HTMLElement): { start: number; end: number } | null {
  const sel = el.ownerDocument.getSelection()
  if (!sel || sel.rangeCount === 0) return null
  const range = sel.getRangeAt(0)
  if (!el.contains(range.startContainer) || !el.contains(range.endContainer)) return null
  const pre = el.ownerDocument.createRange()
  pre.selectNodeContents(el)
  pre.setEnd(range.startContainer, range.startOffset)
  const start = pre.toString().length
  pre.setEnd(range.endContainer, range.endOffset)
  const end = pre.toString().length
  return { start, end }
}

/** Place the caret (or a selection) at character offsets inside `el`. */
export function setSelectionOffsets(el: HTMLElement, start: number, end: number = start): void {
  const doc = el.ownerDocument
  const sel = doc.getSelection()
  if (!sel) return
  const locate = (offset: number): [Node, number] => {
    const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    let remaining = offset
    let last: Text | null = null
    for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
      if (remaining <= n.data.length) return [n, remaining]
      remaining -= n.data.length
      last = n
    }
    return last ? [last, last.data.length] : [el, el.childNodes.length]
  }
  const [sn, so] = locate(start)
  const [en, eo] = locate(end)
  const range = doc.createRange()
  range.setStart(sn, so)
  range.setEnd(en, eo)
  sel.removeAllRanges()
  sel.addRange(range)
}

export interface TextEditHost {
  doc: LoroDoc
  history: History | null
  /** Text access (default: the node's LoroText). */
  io?: TextIO
  undo(): void
  redo(): void
  /** Called once when the session ends (after an empty, newly created node was deleted). */
  onEnd(id: string): void
}

export type CaretPlacement =
  { kind: 'point'; clientX: number; clientY: number } | { kind: 'end' } | { kind: 'all' }

/**
 * In-place text editing bound to the node's LoroText: the node's own element
 * becomes `contenteditable="plaintext-only"`; every input is diffed into Loro
 * (minimal ops via `setText`), remote edits are applied back with the caret
 * kept in place through a Loro cursor. One editing session is one undo step.
 */
export class TextEditSession {
  private composing = false
  private cursor: Cursor | null = null
  private ended = false

  constructor(
    private readonly host: TextEditHost,
    readonly id: string,
    readonly el: HTMLElement,
    private readonly created: boolean,
  ) {}

  start(caret: CaretPlacement): void {
    const { el } = this
    el.setAttribute('contenteditable', 'plaintext-only')
    el.spellcheck = false
    el.classList.add('ic-editing')
    el.addEventListener('input', this.onInput)
    el.addEventListener('compositionstart', this.onCompositionStart)
    el.addEventListener('compositionend', this.onCompositionEnd)
    el.addEventListener('keydown', this.onKeyDown)
    el.ownerDocument.addEventListener('selectionchange', this.onSelectionChange)
    this.host.history?.groupStart()
    el.focus({ preventScroll: true })
    this.placeCaret(caret)
    this.saveCaret()
  }

  private placeCaret(caret: CaretPlacement): void {
    const text = this.el.textContent ?? ''
    if (caret.kind === 'all') {
      setSelectionOffsets(this.el, 0, text.length)
      return
    }
    if (caret.kind === 'point') {
      const doc = this.el.ownerDocument
      const pos = doc.caretPositionFromPoint?.(caret.clientX, caret.clientY)
      if (pos && this.el.contains(pos.offsetNode)) {
        const sel = doc.getSelection()
        const range = doc.createRange()
        range.setStart(pos.offsetNode, pos.offset)
        range.collapse(true)
        sel?.removeAllRanges()
        sel?.addRange(range)
        return
      }
    }
    setSelectionOffsets(this.el, text.length)
  }

  private readonly onInput = (): void => {
    if (this.composing) return
    this.commit()
    this.syncSentinel()
  }

  private readonly onCompositionStart = (): void => {
    this.composing = true
  }

  private readonly onCompositionEnd = (): void => {
    this.composing = false
    this.commit()
  }

  private readonly onSelectionChange = (): void => {
    if (!this.composing) this.saveCaret()
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    const mod = e.ctrlKey || e.metaKey
    if (e.key === 'Escape' || (e.key === 'Enter' && mod)) {
      e.preventDefault()
      e.stopPropagation()
      this.end()
      return
    }
    if (mod && !e.altKey && (e.key === 'z' || e.key === 'Z' || e.key === 'y')) {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'y' || e.shiftKey) this.host.redo()
      else this.host.undo()
      this.host.history?.groupStart()
      return
    }
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault()
      e.stopPropagation()
      this.insertText('\n')
      return
    }
    // Keep canvas shortcuts (Delete, arrows, tool keys) away from the canvas.
    e.stopPropagation()
  }

  /** Replace the current selection with `s` (used for line breaks). */
  insertText(s: string): void {
    const text = this.el.textContent ?? ''
    const sel = selectionOffsets(this.el) ?? { start: text.length, end: text.length }
    this.el.textContent = text.slice(0, sel.start) + s + text.slice(sel.end)
    this.syncSentinel()
    setSelectionOffsets(this.el, sel.start + s.length)
    this.commit()
  }

  /**
   * A trailing "\n" creates no line box in pre-wrap text, so the caret could
   * not sit on the new empty line. While editing, a trailing <br> sentinel
   * provides that line (textContent ignores it).
   */
  private syncSentinel(): void {
    const { el } = this
    const last = el.lastChild
    const needs = (el.textContent ?? '').endsWith('\n')
    const has = last instanceof HTMLBRElement
    if (needs && !has) el.appendChild(el.ownerDocument.createElement('br'))
    else if (!needs && has && el.childNodes.length > 1) last.remove()
  }

  private read(): string {
    return this.host.io ? this.host.io.read(this.id) : readText(this.host.doc, this.id)
  }

  private commit(): void {
    const text = this.el.textContent ?? ''
    if (text !== this.read()) {
      if (this.host.io) this.host.io.write(this.id, text)
      else
        transact(this.host.doc, () => setText(this.host.doc, this.id, text), {
          origin: ORIGIN.text,
        })
    }
    this.saveCaret()
  }

  private saveCaret(): void {
    const off = selectionOffsets(this.el)
    if (!off) return
    const text = this.host.io
      ? this.host.io.container(this.id)
      : textContainer(this.host.doc, this.id)
    try {
      this.cursor = text?.getCursor(off.start) ?? null
    } catch {
      this.cursor = null
    }
  }

  /** Apply a text change that did not come from this session (remote edit, undo). */
  applyExternal(text: string): void {
    if ((this.el.textContent ?? '') === text) return
    let pos: number | null = null
    if (this.cursor) {
      try {
        pos = this.host.doc.getCursorPos(this.cursor)?.offset ?? null
      } catch {
        pos = null
      }
    }
    this.el.textContent = text
    this.syncSentinel()
    if (pos !== null && this.el.ownerDocument.activeElement === this.el)
      setSelectionOffsets(this.el, Math.min(pos, text.length))
  }

  get isEnded(): boolean {
    return this.ended
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    const { el } = this
    if (!this.composing) this.commit()
    el.removeEventListener('input', this.onInput)
    el.removeEventListener('compositionstart', this.onCompositionStart)
    el.removeEventListener('compositionend', this.onCompositionEnd)
    el.removeEventListener('keydown', this.onKeyDown)
    el.ownerDocument.removeEventListener('selectionchange', this.onSelectionChange)
    el.removeAttribute('contenteditable')
    el.classList.remove('ic-editing')
    // Back to canonical rendering (drops the caret sentinel and any browser-inserted nodes).
    const finalText = this.read()
    if (el.childNodes.length !== 1 || el.textContent !== finalText) el.textContent = finalText
    if (el.ownerDocument.activeElement === el) el.blur()
    el.ownerDocument.getSelection()?.removeAllRanges()
    // A new text node left empty is removed inside the same undo group as its creation.
    if (this.created && this.read() === '') deleteNodes(this.host.doc, [this.id])
    this.host.history?.groupEnd()
    this.host.onEnd(this.id)
  }
}
