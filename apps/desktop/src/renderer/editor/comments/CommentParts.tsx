/**
 * Pieces shared by the pins, the thread card and the Comments list: an author's avatar (people in
 * their colour, agents as the agent medallion), a message's text with its @mentions highlighted,
 * and the comment text field (Enter posts, Shift+Enter starts a new line, Escape cancels; `@`
 * suggests people and agents to mention).
 */
import { Avatar, Button, avatarColorFor, type AvatarSize } from '@baren/ui'
import type { CommentAuthor, CommentMention } from '@baren/schema'
import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import {
  activeMentionQuery,
  filterCandidates,
  insertMention,
  keptMentions,
  mentionSegments,
} from './mentions'
import css from './Comments.module.css'

export function CommentAvatar({ author, size }: { author: CommentAuthor; size: AvatarSize }) {
  if (author.kind === 'agent') return <Avatar variant="agent" name={author.name} size={size} />
  return <Avatar name={author.name} color={avatarColorFor(author.id)} size={size} />
}

/** A message's text with the people it mentions highlighted (you more strongly). */
export function MessageText({
  body,
  mentions,
  me,
}: {
  body: string
  mentions: readonly CommentMention[]
  me: CommentAuthor
}) {
  const segments = useMemo(() => mentionSegments(body, mentions), [body, mentions])
  return (
    <div className={css.text}>
      {segments.map((seg, i) =>
        seg.mention ? (
          <span
            key={i}
            className={seg.mention.id === me.id ? css.mentionMe : css.mention}
            title={seg.mention.kind === 'agent' ? `${seg.mention.name} (agent)` : seg.mention.name}
          >
            {seg.text}
          </span>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </div>
  )
}

export interface CommentInputProps {
  placeholder: string
  submitLabel: string
  initial?: string
  /** The mentions of the text being edited. */
  initialMentions?: readonly CommentMention[]
  /** People and agents `@` can mention (none: no suggestions). */
  candidates?: readonly CommentMention[]
  autoFocus?: boolean
  /** Shown left of the button ("Enter to post"). */
  hint?: string
  /** The trimmed text and the mentions still in it. */
  onSubmit(text: string, mentions: CommentMention[]): boolean | void
  onCancel?(): void
  /** The text changed (e.g. a draft that must not be lost on an outside click). */
  onTextChange?(text: string): void
}

/** Grows with its text up to the CSS max height. */
export function CommentInput({
  placeholder,
  submitLabel,
  initial = '',
  initialMentions = [],
  candidates = [],
  autoFocus = false,
  hint,
  onSubmit,
  onCancel,
  onTextChange,
}: CommentInputProps) {
  const [text, setText] = useState(initial)
  const [mentions, setMentions] = useState<CommentMention[]>(() => [...initialMentions])
  /** The `@query` at the caret (null: no suggestions open). */
  const [query, setQuery] = useState<{ start: number; query: string } | null>(null)
  const [active, setActive] = useState(0)
  const ref = useRef<HTMLTextAreaElement>(null)
  const listId = useId()
  const empty = text.trim() === ''
  const suggestions = query ? filterCandidates(candidates, query.query) : []
  const suggesting = suggestions.length > 0

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight + 2}px`
  }, [text])

  useLayoutEffect(() => {
    if (!autoFocus) return
    const id = requestAnimationFrame(() => {
      const el = ref.current
      el?.focus({ preventScroll: true })
      el?.setSelectionRange(el.value.length, el.value.length)
    })
    return () => cancelAnimationFrame(id)
  }, [autoFocus])

  const submit = () => {
    if (empty) return
    const trimmed = text.trim()
    // A failed post (the thread was deleted meanwhile…) keeps the text.
    if (onSubmit(trimmed, keptMentions(trimmed, mentions)) === false) return
    setText('')
    setMentions([])
    setQuery(null)
    onTextChange?.('')
  }

  /** Follow the caret: open, narrow or close the suggestions. */
  const track = (el: HTMLTextAreaElement) => {
    const next =
      el.selectionStart === el.selectionEnd ? activeMentionQuery(el.value, el.selectionStart) : null
    setQuery((prev) => {
      if (next?.query !== prev?.query || next?.start !== prev?.start) setActive(0)
      return next
    })
  }

  const pick = (mention: CommentMention) => {
    const el = ref.current
    if (!el || !query) return
    const next = insertMention(text, query.start, el.selectionStart, mention.name)
    setText(next.text)
    onTextChange?.(next.text)
    setMentions((list) => (list.some((m) => m.id === mention.id) ? list : [...list, mention]))
    setQuery(null)
    requestAnimationFrame(() => {
      el.focus({ preventScroll: true })
      el.setSelectionRange(next.caret, next.caret)
    })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return
    if (suggesting) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const step = e.key === 'ArrowDown' ? 1 : -1
        setActive((i) => (i + step + suggestions.length) % suggestions.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        pick(suggestions[Math.min(active, suggestions.length - 1)] as CommentMention)
        return
      }
      if (e.key === 'Escape') {
        // Close the suggestions only: the comment stays open.
        e.preventDefault()
        e.stopPropagation()
        setQuery(null)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onCancel?.()
    }
  }

  return (
    <>
      <div className={css.inputWrap}>
        <textarea
          ref={ref}
          className={css.input}
          value={text}
          rows={1}
          placeholder={placeholder}
          aria-label={placeholder}
          maxLength={10_000}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={suggesting}
          aria-controls={suggesting ? listId : undefined}
          aria-activedescendant={suggesting ? `${listId}-${active}` : undefined}
          onChange={(e) => {
            setText(e.currentTarget.value)
            onTextChange?.(e.currentTarget.value)
            track(e.currentTarget)
          }}
          onSelect={(e) => track(e.currentTarget)}
          onBlur={() => setQuery(null)}
          onKeyDown={onKeyDown}
        />
        {suggesting && (
          <div id={listId} className={css.suggestions} role="listbox" aria-label="Mention">
            {suggestions.map((c, i) => (
              <div
                key={c.id}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                className={css.suggestion}
                // Keep the focus (and the caret) in the text field.
                onMouseDown={(e) => {
                  e.preventDefault()
                  pick(c)
                }}
                onMouseMove={() => setActive(i)}
              >
                <CommentAvatar author={c} size={18} />
                <span className={css.suggestionName}>{c.name}</span>
                {c.kind === 'agent' && <span className={css.agentTag}>agent</span>}
              </div>
            ))}
          </div>
        )}
      </div>
      <div className={css.composerRow}>
        <span className={css.hint}>{hint}</span>
        {onCancel && initial !== '' && (
          <Button variant="ghost" size={26} onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button variant="primary" size={26} disabled={empty} onClick={submit}>
          {submitLabel}
        </Button>
      </div>
    </>
  )
}
