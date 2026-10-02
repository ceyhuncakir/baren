import { clsx } from 'clsx'
import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react'
import { Spinner } from './Spinner'
import styles from './Button.module.css'

export type ButtonVariant =
  'primary' | 'secondary' | 'outline' | 'ghost' | 'destructive' | 'raised' | 'link' | 'link-muted'

export type ButtonSize = 26 | 28 | 30 | 32 | 40

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** Default: 12px for 26/28, 13px otherwise. Sidebar card buttons and "Invite" use 12. */
  textSize?: 12 | 13
  leadingIcon?: ReactNode
  trailingIcon?: ReactNode
  fullWidth?: boolean
  /** Keeps the size, hides the label and shows a spinner. */
  loading?: boolean
  /** Visually pressed (e.g. Share while its popover is open). */
  pressed?: boolean
  ref?: Ref<HTMLButtonElement>
}

const VARIANT_CLASS: Record<ButtonVariant, string | undefined> = {
  primary: styles.primary,
  secondary: styles.secondary,
  outline: styles.outline,
  ghost: styles.ghost,
  destructive: styles.destructive,
  raised: styles.raised,
  link: styles.link,
  'link-muted': styles.linkMuted,
}

const SIZE_CLASS: Record<ButtonSize, string | undefined> = {
  26: styles.s26,
  28: styles.s28,
  30: styles.s30,
  32: styles.s32,
  40: styles.s40,
}

export function Button({
  variant = 'primary',
  size = 30,
  textSize,
  leadingIcon,
  trailingIcon,
  fullWidth = false,
  loading = false,
  pressed = false,
  className,
  children,
  disabled,
  type = 'button',
  ref,
  ...rest
}: ButtonProps) {
  const text = textSize ?? (size <= 28 ? 12 : 13)
  const isLink = variant === 'link' || variant === 'link-muted'
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled}
      aria-busy={loading || undefined}
      data-pressed={pressed ? '' : undefined}
      className={clsx(
        styles.button,
        !isLink && SIZE_CLASS[size],
        VARIANT_CLASS[variant],
        text === 12 ? styles.text12 : styles.text13,
        leadingIcon !== undefined && styles.leading,
        fullWidth && styles.fullWidth,
        loading && styles.loading,
        className,
      )}
      {...rest}
    >
      {leadingIcon !== undefined && <span className={styles.icon}>{leadingIcon}</span>}
      {children}
      {trailingIcon !== undefined && <span className={styles.icon}>{trailingIcon}</span>}
      {loading && (
        <span className={styles.spinnerOverlay}>
          <Spinner size={14} tone={variant === 'primary' ? 'inverse' : 'default'} />
        </span>
      )}
    </button>
  )
}
