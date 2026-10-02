import { clsx } from 'clsx'
import type { HTMLAttributes, ReactNode } from 'react'
import styles from './Badge.module.css'

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: 'muted' | 'outline' | 'input' | 'selection' | 'count'
}

export function Badge({ variant = 'muted', className, ...rest }: BadgeProps) {
  return <span className={clsx(styles.badge, styles[variant], className)} {...rest} />
}

export type DotTone = 'success' | 'neutral' | 'accent' | 'danger'

export interface StatusDotProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: DotTone
  /** Diameter in px (6 everywhere in the artboards). */
  size?: number
}

/** Small status dot: "Active now" (green), "Not connected" (gray), "Learn" (blue). */
export function StatusDot({
  tone = 'neutral',
  size = 6,
  className,
  style,
  ...rest
}: StatusDotProps) {
  return (
    <span
      aria-hidden="true"
      className={clsx(styles.dot, styles[tone], className)}
      style={{ width: size, height: size, ...style }}
      {...rest}
    />
  )
}

export interface StatusProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: DotTone
  children: ReactNode
}

/** Dot + label ("● Not connected" in the MCP section, 04). */
export function Status({ tone = 'neutral', className, children, ...rest }: StatusProps) {
  return (
    <span className={clsx(styles.status, className)} {...rest}>
      <StatusDot tone={tone} />
      {children}
    </span>
  )
}
