/**
 * Pieces shared by the pins, the thread card and the Comments list: an author's avatar (people in
 * their colour, agents as the agent medallion) and the comment text field (Enter posts,
 * Shift+Enter starts a new line, Escape cancels).
 */
import { Avatar, Button, avatarColorFor, type AvatarSize } from '@baren/ui'
import type { CommentAuthor } from '@baren/schema'
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import css from './Comments.module.css'

export function CommentAvatar({ author, size }: { author: CommentAuthor; size: AvatarSize }) {
  if (author.kind === 'agent') return <Avatar variant="agent" name={author.name} size={size} />
  return <Avatar name={author.name} color={avatarColorFor(author.id)} size={size} />
}

export interface CommentInputProps {
  placeholder: string
  submitLabel: string
  initial?: string
  autoFocus?: boolean
  /** Shown left of the button ("Enter to post"). */
  hint?: string
  onSubmit(text: string): boolean | void
  onCancel?(): void
  /** The text changed (e.g. a draft that must not be lost on an outside click). */
  onTextChange?(text: string): void
}

/** Grows with its text up to the CSS max height. */
export function CommentInput({
  placeholder,
  submitLabel,
  initial = '',
  autoFocus = false,
  hint,
  onSubmit,
  onCancel,
  onTextChange,
}: CommentInputProps) {
  const [text, setText] = useState(initial)
  const ref = useRef<HTMLTextAreaElement>(null)
  const empty = text.trim() === ''

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
    // A failed post (the thread was deleted meanwhile…) keeps the text.
    if (onSubmit(text.trim()) === false) return
    setText('')
    onTextChange?.('')
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return
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
      <textarea
        ref={ref}
        className={css.input}
        value={text}
        rows={1}
        placeholder={placeholder}
        aria-label={placeholder}
        maxLength={10_000}
        onChange={(e) => {
          setText(e.currentTarget.value)
          onTextChange?.(e.currentTarget.value)
        }}
        onKeyDown={onKeyDown}
      />
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
