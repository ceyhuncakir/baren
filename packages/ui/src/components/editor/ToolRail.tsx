import { clsx } from 'clsx'
import { memo, type ButtonHTMLAttributes, type HTMLAttributes, type Ref } from 'react'
import styles from './ToolRail.module.css'

export function ToolRail({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      role="toolbar"
      aria-orientation="vertical"
      className={clsx(styles.rail, className)}
      {...rest}
    />
  )
}

export interface ToolButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Accessible name ("Rectangle"). */
  label: string
  /** Shown in the tooltip ("R"). */
  shortcut?: string
  active?: boolean
  ref?: Ref<HTMLButtonElement>
}

/** 32px tool; the icon (16px, stroke 1.75) is the child. Memoized: the rail rerenders often. */
export const ToolButton = memo(function ToolButton({
  label,
  shortcut,
  active = false,
  className,
  type = 'button',
  title,
  ref,
  ...rest
}: ToolButtonProps) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      aria-pressed={active}
      aria-keyshortcuts={shortcut}
      title={title ?? (shortcut ? `${label} (${shortcut})` : label)}
      className={clsx(styles.tool, className)}
      {...rest}
    />
  )
})

export function ToolDivider({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div role="separator" className={clsx(styles.divider, className)} {...rest} />
}
