import { clsx } from 'clsx'
import type { ButtonHTMLAttributes, Ref } from 'react'
import styles from './Switch.module.css'

export interface SwitchProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'onChange' | 'value' | 'role' | 'type'
> {
  checked: boolean
  onCheckedChange?: (checked: boolean) => void
  /** Accessible name when no visible label points at the switch (aria-labelledby). */
  label?: string
  ref?: Ref<HTMLButtonElement>
}

/**
 * On/off switch (artboard 34, "MCP server"): 28 × 16 track, 12 px knob. On = foreground track
 * with a background-coloured knob on the right (the checked-checkbox rule, so it inverts in
 * dark); off = --color-track with a --color-thumb knob on the left. Space/Enter toggle it.
 */
export function Switch({
  checked,
  onCheckedChange,
  label,
  className,
  onClick,
  disabled,
  ref,
  ...rest
}: SwitchProps) {
  return (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={clsx(styles.root, checked && styles.on, className)}
      onClick={(e) => {
        onClick?.(e)
        if (!e.defaultPrevented) onCheckedChange?.(!checked)
      }}
      {...rest}
    >
      <span className={styles.knob} aria-hidden="true" />
    </button>
  )
}
