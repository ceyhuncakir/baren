import { clsx } from 'clsx'
import type { HTMLAttributes, ReactNode } from 'react'
import { scorePassword, STRENGTH_LABELS, type StrengthScore } from '../../lib/password'
import styles from './Misc.module.css'

/** Keyboard key cap (04: "Press [A] to draw an artboard"). */
export function Kbd({ className, ...rest }: HTMLAttributes<HTMLElement>) {
  return <kbd className={clsx(styles.kbd, className)} {...rest} />
}

export interface DividerProps extends HTMLAttributes<HTMLDivElement> {
  orientation?: 'horizontal' | 'vertical'
  /** Centered label between two lines ("or with email", 18/19). */
  label?: ReactNode
}

export function Divider({ orientation = 'horizontal', label, className, ...rest }: DividerProps) {
  if (label !== undefined) {
    return (
      <div role="separator" className={clsx(styles.labeled, className)} {...rest}>
        {label}
      </div>
    )
  }
  return (
    <div
      role="separator"
      aria-orientation={orientation}
      className={clsx(styles.divider, orientation === 'vertical' && styles.vertical, className)}
      {...rest}
    />
  )
}

export interface PasswordStrengthProps extends HTMLAttributes<HTMLDivElement> {
  /** Either pass the password (scored with `scorePassword`) or a precomputed score. */
  password?: string
  score?: StrengthScore
  /** Overrides the label ("Good"). */
  label?: ReactNode
}

const LEVEL_CLASS = ['', styles.level1, styles.level2, styles.level3, styles.level4] as const

/** Four bars + label under the password field (artboard 19). */
export function PasswordStrength({
  password,
  score,
  label,
  className,
  ...rest
}: PasswordStrengthProps) {
  const s: StrengthScore = score ?? scorePassword(password ?? '')
  const text = label ?? STRENGTH_LABELS[s]
  return (
    <div className={clsx(styles.strength, LEVEL_CLASS[s], className)} {...rest}>
      <div className={styles.strengthBars} aria-hidden="true">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className={styles.strengthBar} data-filled={i <= s ? '' : undefined} />
        ))}
      </div>
      {text !== '' && (
        <div className={styles.strengthLabel} aria-live="polite">
          {text}
        </div>
      )}
    </div>
  )
}
