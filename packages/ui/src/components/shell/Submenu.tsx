import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { FloatingLayer } from '../../lib/floating'
import { placeSubmenu, toBox, type Size } from '../../lib/position'
import { Menu, MenuItem } from './Menu'

const OPEN_DELAY_MS = 90
const CLOSE_DELAY_MS = 160

export interface SubmenuProps {
  label: ReactNode
  /** Submenu panel width ("Copy as": 200). */
  width?: number
  disabled?: boolean
  icon?: ReactNode
  children: ReactNode
}

/**
 * A menu item that opens a nested menu to its right (artboard 15, "Copy as"). Opens on
 * hover after a short delay, on click, or with ArrowRight/Enter; ArrowLeft/Escape close
 * it and return focus to the trigger. Placement: `placeSubmenu` (4px overlap, first item
 * level with the trigger, flips left at the viewport edge).
 */
export function Submenu({ label, width = 200, disabled = false, icon, children }: SubmenuProps) {
  const [open, setOpen] = useState(false)
  const [keyboardOpened, setKeyboardOpened] = useState(false)
  const triggerRef = useRef<HTMLDivElement>(null)
  const openTimer = useRef<number | undefined>(undefined)
  const closeTimer = useRef<number | undefined>(undefined)

  const clearTimers = useCallback(() => {
    window.clearTimeout(openTimer.current)
    window.clearTimeout(closeTimer.current)
  }, [])

  const openNow = useCallback(
    (viaKeyboard: boolean) => {
      if (disabled) return
      clearTimers()
      setKeyboardOpened(viaKeyboard)
      setOpen(true)
    },
    [clearTimers, disabled],
  )

  const closeNow = useCallback(
    (focusTrigger: boolean) => {
      clearTimers()
      setOpen(false)
      if (focusTrigger) triggerRef.current?.focus({ preventScroll: true })
    },
    [clearTimers],
  )

  useEffect(() => clearTimers, [clearTimers])

  // Close when another item of the parent menu takes the highlight.
  useEffect(() => {
    if (!open) return
    const menu = triggerRef.current?.closest<HTMLElement>('[role="menu"]')
    if (!menu) return
    const onFocusIn = (e: FocusEvent) => {
      if (e.target === triggerRef.current) {
        window.clearTimeout(closeTimer.current)
        return
      }
      window.clearTimeout(closeTimer.current)
      closeTimer.current = window.setTimeout(() => setOpen(false), CLOSE_DELAY_MS)
    }
    menu.addEventListener('focusin', onFocusIn)
    return () => menu.removeEventListener('focusin', onFocusIn)
  }, [open])

  const position = (size: Size, viewport: Size) => {
    const trigger = triggerRef.current
    const parent = trigger?.closest<HTMLElement>('[role="menu"]')
    if (!trigger || !parent) return { x: 0, y: 0 }
    return placeSubmenu(
      toBox(trigger.getBoundingClientRect()),
      toBox(parent.getBoundingClientRect()),
      size,
      viewport,
    )
  }

  return (
    <>
      <MenuItem
        ref={triggerRef}
        submenu
        icon={icon}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        data-open={open ? '' : undefined}
        onPointerEnter={() => {
          if (disabled || open) return
          window.clearTimeout(openTimer.current)
          openTimer.current = window.setTimeout(() => openNow(false), OPEN_DELAY_MS)
        }}
        onPointerLeave={() => window.clearTimeout(openTimer.current)}
        onClick={() => openNow(false)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight' || e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            e.stopPropagation()
            openNow(true)
          }
        }}
      >
        {label}
      </MenuItem>
      <FloatingLayer
        open={open}
        position={position}
        onPointerEnter={() => window.clearTimeout(closeTimer.current)}
      >
        <Menu
          width={width}
          autoFocus={keyboardOpened ? 'first' : 'none'}
          onEscape={() => closeNow(true)}
          onArrowLeft={() => closeNow(true)}
        >
          {children}
        </Menu>
      </FloatingLayer>
    </>
  )
}
