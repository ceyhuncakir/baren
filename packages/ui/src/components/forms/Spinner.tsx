import { clsx } from 'clsx'
import type { SVGProps } from 'react'
import styles from './Misc.module.css'

export interface SpinnerProps extends Omit<SVGProps<SVGSVGElement>, 'ref'> {
  size?: number
  /** 'inverse' draws a white arc for primary (brand) buttons. */
  tone?: 'default' | 'inverse'
  label?: string
}

/** Ring spinner from artboard 21 ("Waiting for you to sign in…"). */
export function Spinner({ size = 16, tone = 'default', label, className, ...rest }: SpinnerProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      strokeWidth={2.5}
      strokeLinecap="round"
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={clsx(styles.spinner, tone === 'inverse' && styles.spinnerInverse, className)}
      {...rest}
    >
      <circle cx="12" cy="12" r="9" className={styles.spinnerTrack} />
      <path d="M21 12a9 9 0 0 0-9-9" className={styles.spinnerArc} />
    </svg>
  )
}
