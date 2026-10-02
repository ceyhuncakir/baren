import { clsx } from 'clsx'
import { useSyncExternalStore, type HTMLAttributes, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { XIcon } from '../../icons/icons'
import styles from './Toast.module.css'

export interface ToastProps extends HTMLAttributes<HTMLDivElement> {
  icon?: ReactNode
  actionLabel?: string
  onAction?: () => void
  onClose?: () => void
}

/** A single toast (presentational). */
export function Toast({
  icon,
  actionLabel,
  onAction,
  onClose,
  className,
  children,
  ...rest
}: ToastProps) {
  return (
    <div role="status" className={clsx(styles.toast, className)} {...rest}>
      {icon !== undefined && <span className={styles.icon}>{icon}</span>}
      <span className={styles.message}>{children}</span>
      {actionLabel && (
        <button type="button" className={styles.action} onClick={onAction}>
          {actionLabel}
        </button>
      )}
      {onClose && (
        <button type="button" className={styles.close} aria-label="Dismiss" onClick={onClose}>
          <XIcon size={12} strokeWidth={2} />
        </button>
      )}
    </div>
  )
}

/* ---- Tiny global toast store (no React state outside the Toaster) ---------------- */

export interface ToastOptions {
  icon?: ReactNode
  actionLabel?: string
  onAction?: () => void
  /** ms; 0 keeps it until dismissed. Default 4000. */
  duration?: number
}

interface ToastItem extends ToastOptions {
  id: number
  message: ReactNode
}

let items: ReadonlyArray<ToastItem> = []
let nextId = 1
const listeners = new Set<() => void>()
const timers = new Map<number, ReturnType<typeof setTimeout>>()

function emit() {
  for (const l of listeners) l()
}

export function dismissToast(id: number): void {
  const t = timers.get(id)
  if (t) clearTimeout(t)
  timers.delete(id)
  if (!items.some((i) => i.id === id)) return
  items = items.filter((i) => i.id !== id)
  emit()
}

/** Shows a toast; returns its id. At most 3 are visible (oldest dropped). */
export function toast(message: ReactNode, options: ToastOptions = {}): number {
  const id = nextId++
  items = [...items, { id, message, ...options }].slice(-3)
  const duration = options.duration ?? 4000
  if (duration > 0)
    timers.set(
      id,
      setTimeout(() => dismissToast(id), duration),
    )
  emit()
  return id
}

function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

const getSnapshot = () => items
const EMPTY: ReadonlyArray<ToastItem> = []
const getServerSnapshot = () => EMPTY

/** Mount once near the app root. */
export function Toaster() {
  const list = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  if (typeof document === 'undefined' || list.length === 0) return null
  return createPortal(
    <div className={styles.viewport} aria-live="polite">
      {list.map((t) => (
        <Toast
          key={t.id}
          icon={t.icon}
          actionLabel={t.actionLabel}
          onAction={() => {
            t.onAction?.()
            dismissToast(t.id)
          }}
          onClose={() => dismissToast(t.id)}
        >
          {t.message}
        </Toast>
      ))}
    </div>,
    document.body,
  )
}
