import { clsx } from 'clsx'
import type { ReactNode } from 'react'
import css from './FormError.module.css'

/** Form-level error line (server errors that belong to no single field). */
export function FormError({ children, className }: { children: ReactNode; className?: string }) {
  if (children === null || children === undefined || children === false || children === '')
    return null
  return (
    <p role="alert" className={clsx(css.error, className)}>
      {children}
    </p>
  )
}
