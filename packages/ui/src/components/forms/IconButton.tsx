import { clsx } from 'clsx'
import type { ButtonHTMLAttributes, Ref } from 'react'
import styles from './IconButton.module.css'

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Accessible name (also the tooltip). Required: icon buttons have no text. */
  label: string
  /** Height in px (and width unless `width` is set). */
  size?: number
  width?: number
  radius?: 'sm' | 'md'
  /** 'muted' icons turn foreground on hover; 'default' are always foreground. */
  tone?: 'muted' | 'default'
  /** No hover background (icon inside a field). */
  bare?: boolean
  /** Toggle state; sets aria-pressed. */
  active?: boolean
  ref?: Ref<HTMLButtonElement>
}

export function IconButton({
  label,
  size = 28,
  width,
  radius = 'md',
  tone = 'muted',
  bare = false,
  active,
  className,
  style,
  type = 'button',
  title,
  ref,
  ...rest
}: IconButtonProps) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={title ?? label}
      aria-pressed={active}
      className={clsx(
        styles.iconButton,
        radius === 'sm' && styles.radiusSm,
        tone === 'default' && styles.toneDefault,
        bare && styles.bare,
        className,
      )}
      style={{ width: width ?? size, height: size, ...style }}
      {...rest}
    />
  )
}
