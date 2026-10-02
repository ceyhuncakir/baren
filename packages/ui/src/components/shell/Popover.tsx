import { clsx } from 'clsx'
import { useEffect, useRef, type HTMLAttributes, type ReactNode, type RefObject } from 'react'
import { XIcon } from '../../icons/icons'
import { FloatingLayer } from '../../lib/floating'
import { useStableCallback } from '../../lib/hooks'
import { placeAnchored, toBox, type Placement, type Size } from '../../lib/position'
import { IconButton } from '../forms/IconButton'
import styles from './Popover.module.css'

export interface PopoverProps extends Omit<HTMLAttributes<HTMLDivElement>, 'role'> {
  open: boolean
  onOpenChange: (open: boolean) => void
  anchorRef: RefObject<HTMLElement | null>
  placement?: Placement
  offset?: number
  alignOffset?: number
  /** Share popover: 360. */
  width?: number
  role?: 'dialog' | 'region'
  children: ReactNode
}

/**
 * Anchored non-menu panel (share popover, artboard 08). Focus moves into the panel when it
 * opens (unless content autofocuses); Escape closes and returns focus to the anchor.
 */
export function Popover({
  open,
  onOpenChange,
  anchorRef,
  placement = 'bottom-end',
  offset = 8,
  alignOffset = 0,
  width = 360,
  role = 'dialog',
  className,
  style,
  children,
  onKeyDown,
  ...rest
}: PopoverProps) {
  const setOpen = useStableCallback(onOpenChange)
  const position = (size: Size, viewport: Size) => {
    const anchor = anchorRef.current
    if (!anchor) return { x: 0, y: 0 }
    return placeAnchored(toBox(anchor.getBoundingClientRect()), size, viewport, {
      placement,
      offset,
      alignOffset,
    })
  }
  return (
    <FloatingLayer
      open={open}
      position={position}
      anchorRef={anchorRef}
      onDismiss={() => setOpen(false)}
    >
      <PopoverPanel
        focusOnMount
        role={role}
        className={className}
        style={{ width, ...style }}
        onKeyDown={(e) => {
          onKeyDown?.(e)
          if (e.defaultPrevented || e.key !== 'Escape') return
          e.preventDefault()
          e.stopPropagation()
          setOpen(false)
          anchorRef.current?.focus({ preventScroll: true })
        }}
        {...rest}
      >
        {children}
      </PopoverPanel>
    </FloatingLayer>
  )
}

export interface PopoverPanelProps extends HTMLAttributes<HTMLDivElement> {
  /** Move focus into the panel on mount (unless something inside already has it). */
  focusOnMount?: boolean
}

/** The panel surface on its own (also used for static specimens). */
export function PopoverPanel({ focusOnMount = false, className, ...rest }: PopoverPanelProps) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (focusOnMount && el && !el.contains(document.activeElement))
      el.focus({ preventScroll: true })
  }, [focusOnMount])
  return <div ref={ref} tabIndex={-1} className={clsx(styles.popover, className)} {...rest} />
}

export interface PopoverHeaderProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  title: ReactNode
  onClose?: () => void
}

/** "Share baren  ×" header row. */
export function PopoverHeader({ title, onClose, className, ...rest }: PopoverHeaderProps) {
  return (
    <div className={clsx(styles.header, className)} {...rest}>
      <div className={styles.title}>{title}</div>
      {onClose && (
        <IconButton label="Close" size={24} radius="sm" onClick={onClose}>
          <XIcon size={14} strokeWidth={2} />
        </IconButton>
      )}
    </div>
  )
}

/** Surface-colored footer ("Export · Copy link"). */
export function PopoverFooter({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={clsx(styles.footer, className)} {...rest} />
}
