import { clsx } from 'clsx'
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react'
import { CheckIcon, ChevronRightIcon } from '../../icons/icons'
import type { DismissReason } from '../../lib/floating'
import { useMergedRefs } from '../../lib/refs'
import { nextEnabledIndex, rovingKeyFor } from '../../lib/roving'
import styles from './Menu.module.css'

export interface MenuContextValue {
  /** Closes the whole menu tree (menu bar menu, dropdown or context menu). */
  close: (reason?: DismissReason) => void
}

export const MenuContext = createContext<MenuContextValue | null>(null)

const ITEM_SELECTOR = '[data-menu-item]'

function menuItems(menu: HTMLElement): HTMLElement[] {
  return Array.from(menu.querySelectorAll<HTMLElement>(ITEM_SELECTOR))
}

function isDisabled(el: HTMLElement | undefined): boolean {
  return !el || el.getAttribute('aria-disabled') === 'true'
}

function focusItem(el: HTMLElement | undefined): void {
  el?.focus({ preventScroll: true })
}

function isTextInput(target: EventTarget): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
}

export interface MenuProps extends Omit<HTMLAttributes<HTMLDivElement>, 'autoFocus'> {
  /** Widths in the designs: File/Edit 248, View 300, Window 200, Help 220, context 244, submenu 200. */
  width?: number | string
  /**
   * Initial focus. 'menu' focuses the panel (pointer open, nothing highlighted), 'first'
   * highlights the first enabled item (keyboard open).
   */
  autoFocus?: 'menu' | 'first' | 'none'
  onEscape?: () => void
  onArrowLeft?: () => void
  onArrowRight?: () => void
  ref?: Ref<HTMLDivElement>
}

/**
 * The menu panel. Highlight follows DOM focus (hover focuses the item), so moving through
 * a menu never re-renders React.
 */
export function Menu({
  width,
  autoFocus = 'none',
  onEscape,
  onArrowLeft,
  onArrowRight,
  className,
  style,
  children,
  onKeyDown,
  ref,
  ...rest
}: MenuProps) {
  const localRef = useRef<HTMLDivElement>(null)
  const mergedRef = useMergedRefs(localRef, ref)
  const ctx = useContext(MenuContext)

  // useEffect (not layout): the floating layer becomes visible in its own layout effect,
  // and hidden elements cannot take focus.
  useEffect(() => {
    const menu = localRef.current
    if (!menu || autoFocus === 'none') return
    if (autoFocus === 'first') {
      const items = menuItems(menu)
      const idx = nextEnabledIndex(-1, items.length, 'first', (i) => isDisabled(items[i]))
      if (idx >= 0) return focusItem(items[idx])
    }
    menu.focus({ preventScroll: true })
  }, [autoFocus])

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(e)
    if (e.defaultPrevented) return
    const menu = localRef.current
    if (!menu) return
    const inInput = isTextInput(e.target)

    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (onEscape) onEscape()
      else ctx?.close('escape')
      return
    }
    if (e.key === 'ArrowLeft' && !inInput) {
      if (onArrowLeft) {
        e.preventDefault()
        onArrowLeft()
      }
      return
    }
    if (e.key === 'ArrowRight' && !inInput) {
      if (onArrowRight) {
        e.preventDefault()
        onArrowRight()
      }
      return
    }
    if ((e.key === 'Enter' || e.key === ' ') && !inInput) {
      const active = document.activeElement
      if (active instanceof HTMLElement && active.matches(ITEM_SELECTOR) && menu.contains(active)) {
        e.preventDefault()
        active.click()
      }
      return
    }
    if (inInput && (e.key === 'Home' || e.key === 'End')) return
    const action = rovingKeyFor(e.key, 'vertical')
    if (!action) return
    e.preventDefault()
    const items = menuItems(menu)
    const current = items.indexOf(document.activeElement as HTMLElement)
    const next = nextEnabledIndex(current, items.length, action, (i) => isDisabled(items[i]))
    focusItem(items[next])
  }

  return (
    <div
      ref={mergedRef}
      role="menu"
      tabIndex={-1}
      className={clsx(styles.menu, className)}
      style={width !== undefined ? { width, ...style } : style}
      onKeyDown={handleKeyDown}
      onContextMenu={(e) => e.preventDefault()}
      {...rest}
    >
      {children}
    </div>
  )
}

export interface MenuItemProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onSelect'> {
  /** Shown right-aligned in muted text ("Ctrl+Shift+N"). */
  shortcut?: ReactNode
  disabled?: boolean
  /** When defined the row gets the 14px check column (zoom menu toggles). */
  checked?: boolean
  destructive?: boolean
  /** Content of the 18px leading column (team marks, plus icon). */
  icon?: ReactNode
  /** Replaces the shortcut, e.g. a check mark after the current team. */
  trailing?: ReactNode
  /** Pad the label to line up with checkable rows. */
  inset?: boolean
  /** Muted label (e.g. "Create team"). */
  muted?: boolean
  /** Renders the submenu chevron (used by Submenu). */
  submenu?: boolean
  /** Keep the menu open after selection (toggles). */
  keepOpen?: boolean
  onSelect?: () => void
  ref?: Ref<HTMLDivElement>
}

export function MenuItem({
  shortcut,
  disabled = false,
  checked,
  destructive = false,
  icon,
  trailing,
  inset = false,
  muted = false,
  submenu = false,
  keepOpen = false,
  onSelect,
  className,
  children,
  onClick,
  onPointerMove,
  onPointerLeave,
  ref,
  ...rest
}: MenuItemProps) {
  const ctx = useContext(MenuContext)
  const checkable = checked !== undefined

  return (
    <div
      ref={ref}
      role={checkable ? 'menuitemcheckbox' : 'menuitem'}
      aria-checked={checkable ? checked : undefined}
      aria-disabled={disabled || undefined}
      tabIndex={-1}
      data-menu-item=""
      className={clsx(
        styles.item,
        checkable && styles.checkable,
        icon !== undefined && styles.withIcon,
        inset && !checkable && styles.inset,
        submenu && styles.submenuTrigger,
        disabled && styles.disabled,
        destructive && styles.destructive,
        muted && styles.muted,
        className,
      )}
      onClick={(e) => {
        onClick?.(e)
        if (disabled || e.defaultPrevented) return
        onSelect?.()
        if (!keepOpen && !submenu) ctx?.close('select')
      }}
      onPointerMove={(e) => {
        onPointerMove?.(e)
        const el = e.currentTarget
        if (disabled) {
          const menu = el.closest<HTMLElement>('[role="menu"]')
          if (document.activeElement !== menu) menu?.focus({ preventScroll: true })
        } else if (document.activeElement !== el) {
          el.focus({ preventScroll: true })
        }
      }}
      onPointerLeave={(e) => {
        onPointerLeave?.(e)
        const el = e.currentTarget
        if (document.activeElement === el && !el.hasAttribute('data-open')) {
          el.closest<HTMLElement>('[role="menu"]')?.focus({ preventScroll: true })
        }
      }}
      {...rest}
    >
      {checkable && (
        <span className={styles.checkSlot}>
          {checked && <CheckIcon size={12} strokeWidth={2.5} />}
        </span>
      )}
      {icon !== undefined && <span className={styles.iconSlot}>{icon}</span>}
      <span className={styles.label}>{children}</span>
      {trailing !== undefined ? (
        <span className={styles.trailing}>{trailing}</span>
      ) : shortcut !== undefined ? (
        <span className={styles.shortcut}>{shortcut}</span>
      ) : null}
      {submenu && <ChevronRightIcon size={12} strokeWidth={2.25} className={styles.chevron} />}
    </div>
  )
}

export function MenuSeparator({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div role="separator" className={clsx(styles.separator, className)} {...rest} />
}

/** Small group heading inside a menu ("Teams" in the account menu). */
export function MenuLabel({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div role="presentation" className={clsx(styles.groupLabel, className)} {...rest} />
}

export interface MenuInputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Right-aligned hint ("Enter"). */
  hint?: ReactNode
  ref?: Ref<HTMLInputElement>
}

/** Editable row at the top of the zoom menu (artboard 16). */
export function MenuInput({ hint, className, ref, ...rest }: MenuInputProps) {
  return (
    <div className={styles.inputRow}>
      <label className={styles.inputBox}>
        <input ref={ref} className={clsx(styles.input, className)} spellCheck={false} {...rest} />
        {hint !== undefined && <span className={styles.inputHint}>{hint}</span>}
      </label>
    </div>
  )
}

export interface MenuHeaderProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  avatar?: ReactNode
  title: ReactNode
  subtitle?: ReactNode
}

/** Non-interactive identity header (account menu, 17). */
export function MenuHeader({ avatar, title, subtitle, className, ...rest }: MenuHeaderProps) {
  return (
    <div role="presentation" className={clsx(styles.header, className)} {...rest}>
      {avatar}
      <div className={styles.headerText}>
        <div className={styles.headerTitle}>{title}</div>
        {subtitle !== undefined && <div className={styles.headerSubtitle}>{subtitle}</div>}
      </div>
    </div>
  )
}

export interface MenuControlRowProps extends HTMLAttributes<HTMLDivElement> {
  label: ReactNode
  /** The control on the right (e.g. a Segmented theme switch). */
  control: ReactNode
}

/** Label + inline control inside a menu ("Theme  Light · Dark · System", 17). */
export function MenuControlRow({ label, control, className, ...rest }: MenuControlRowProps) {
  return (
    <div role="presentation" className={clsx(styles.controlRow, className)} {...rest}>
      <span className={styles.label}>{label}</span>
      {control}
    </div>
  )
}
