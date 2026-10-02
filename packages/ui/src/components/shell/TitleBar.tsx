import { clsx } from 'clsx'
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode, Ref } from 'react'
import { MinusIcon, RestoreIcon, SquareIcon, XIcon } from '../../icons/icons'
import styles from './TitleBar.module.css'

export interface TitleBarProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  /** Centered window title ("Recents", "Team › Members", file name). */
  title: ReactNode
  /** Left slot, usually `<MenuBar>`. */
  menu?: ReactNode
  /** Right slot, usually `<WindowControls>` on Linux/Windows. */
  controls?: ReactNode
  ref?: Ref<HTMLElement>
}

/**
 * The frameless window's title bar. The whole bar is a drag region (`-webkit-app-region`);
 * the menu and the window controls are excluded so they stay clickable.
 */
export function TitleBar({ title, menu, controls, className, ref, ...rest }: TitleBarProps) {
  return (
    <header ref={ref} className={clsx(styles.titleBar, className)} {...rest}>
      <div className={styles.side}>{menu}</div>
      <div className={styles.title}>{title}</div>
      <div className={clsx(styles.side, styles.end)}>{controls}</div>
    </header>
  )
}

export interface MenuBarItemProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  ref?: Ref<HTMLButtonElement>
}

/** One top-level entry of the HTML menu bar ("File"). Highlighted while its menu is open. */
export function MenuBarItem({ className, ref, type = 'button', ...rest }: MenuBarItemProps) {
  return <button ref={ref} type={type} className={clsx(styles.menuBarItem, className)} {...rest} />
}

export interface WindowControlsProps extends HTMLAttributes<HTMLDivElement> {
  maximized?: boolean
  onMinimize?: () => void
  onToggleMaximize?: () => void
  onClose?: () => void
}

/** Minimize / maximize-restore / close, as drawn in every artboard (Linux layout). */
export function WindowControls({
  maximized = false,
  onMinimize,
  onToggleMaximize,
  onClose,
  className,
  ...rest
}: WindowControlsProps) {
  return (
    <div className={clsx(styles.controls, className)} {...rest}>
      <button type="button" className={styles.control} aria-label="Minimize" onClick={onMinimize}>
        <MinusIcon size={14} strokeWidth={1.75} />
      </button>
      <button
        type="button"
        className={styles.control}
        aria-label={maximized ? 'Restore' : 'Maximize'}
        onClick={onToggleMaximize}
      >
        {maximized ? (
          <RestoreIcon size={12} strokeWidth={2} />
        ) : (
          <SquareIcon size={12} strokeWidth={2} />
        )}
      </button>
      <button
        type="button"
        className={clsx(styles.control, styles.close)}
        aria-label="Close"
        onClick={onClose}
      >
        <XIcon size={14} strokeWidth={1.75} />
      </button>
    </div>
  )
}
