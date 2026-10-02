/**
 * Modal dialog (invite members, rename, confirmations). @baren/ui has no modal yet, so
 * this lives with the screens and reuses the popover's surface tokens. Focus moves into the
 * dialog, Tab cycles inside it, Escape or a click on the backdrop closes it, and focus
 * returns to where it was.
 */
import { IconButton, useStableCallback, XIcon } from '@baren/ui'
import { clsx } from 'clsx'
import { useEffect, useId, useRef, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import css from './Dialog.module.css'

const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

export interface DialogProps {
  open: boolean
  onClose: () => void
  title: ReactNode
  description?: ReactNode
  /** Footer actions (right-aligned). */
  footer?: ReactNode
  /** Wraps the body in a form; Enter submits. */
  onSubmit?: () => void
  width?: number
  className?: string
  children?: ReactNode
}

export function Dialog(props: DialogProps) {
  if (!props.open || typeof document === 'undefined') return null
  return createPortal(<OpenDialog {...props} />, document.body)
}

function OpenDialog({
  onClose,
  title,
  description,
  footer,
  onSubmit,
  width = 400,
  className,
  children,
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const descriptionId = useId()
  const close = useStableCallback(onClose)

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const panel = panelRef.current
    if (panel && !panel.contains(document.activeElement)) {
      const auto = panel.querySelector<HTMLElement>('[autofocus], [data-autofocus]')
      const first = auto ?? panel.querySelector<HTMLElement>(FOCUSABLE)
      ;(first ?? panel).focus({ preventScroll: true })
    }
    return () => {
      if (previous?.isConnected) previous.focus({ preventScroll: true })
    }
  }, [])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && !e.defaultPrevented) {
      e.preventDefault()
      e.stopPropagation()
      close()
      return
    }
    if (e.key !== 'Tab') return
    const panel = panelRef.current
    if (!panel) return
    const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE))
    const first = items[0]
    const last = items[items.length - 1]
    if (!first || !last) return
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  const body = (
    <>
      <div className={css.header}>
        <h2 id={titleId} className={css.title}>
          {title}
        </h2>
        <IconButton label="Close" size={24} radius="sm" onClick={onClose}>
          <XIcon size={14} strokeWidth={2} />
        </IconButton>
      </div>
      {description !== undefined && (
        <p id={descriptionId} className={css.description}>
          {description}
        </p>
      )}
      {children !== undefined && <div className={css.body}>{children}</div>}
      {footer !== undefined && <div className={css.footer}>{footer}</div>}
    </>
  )

  return (
    <div
      className={css.backdrop}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description !== undefined ? descriptionId : undefined}
        tabIndex={-1}
        className={clsx(css.panel, className)}
        style={{ width }}
        onKeyDown={onKeyDown}
      >
        {onSubmit ? (
          <form
            className={css.form}
            noValidate
            onSubmit={(e: FormEvent) => {
              e.preventDefault()
              onSubmit()
            }}
          >
            {body}
          </form>
        ) : (
          body
        )}
      </div>
    </div>
  )
}
