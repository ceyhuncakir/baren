import { clsx } from 'clsx'
import { useRef, type HTMLAttributes, type KeyboardEvent, type ReactNode } from 'react'
import { nextEnabledIndex, rovingKeyFor } from '../../lib/roving'
import styles from './Segmented.module.css'

export interface SegmentedOption<V extends string = string> {
  value: V
  label?: string
  icon?: ReactNode
  /** Required for icon-only options. */
  'aria-label'?: string
  disabled?: boolean
}

export interface SegmentedProps<V extends string = string> extends Omit<
  HTMLAttributes<HTMLDivElement>,
  'onChange'
> {
  options: ReadonlyArray<SegmentedOption<V>>
  value: V
  onChange: (value: V) => void
  variant?: 'muted' | 'surface' | 'input'
  /** Item height: 24 (mode switch, view toggle) or 22 (theme switch, inspector). */
  size?: 22 | 24
  textSize?: 11 | 12
  /** Stretch items to fill the width (mode switch, flex direction). */
  fullWidth?: boolean
  /** Fixed item width for icon toggles (view toggle 26, fill type 26). */
  itemWidth?: number
}

/**
 * Single-choice segmented control (radiogroup semantics, roving tabindex, arrow keys
 * select). Selected labels reserve their medium-weight width, so nothing shifts.
 */
export function Segmented<V extends string = string>({
  options,
  value,
  onChange,
  variant = 'muted',
  size = 24,
  textSize = 12,
  fullWidth = false,
  itemWidth,
  className,
  ...rest
}: SegmentedProps<V>) {
  const rootRef = useRef<HTMLDivElement>(null)
  const iconOnly = options.every((o) => o.label === undefined)

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const action = rovingKeyFor(e.key, 'horizontal')
    if (!action) return
    e.preventDefault()
    const current = options.findIndex((o) => o.value === value)
    const next = nextEnabledIndex(current, options.length, action, (i) => !!options[i]?.disabled)
    const opt = options[next]
    if (!opt) return
    onChange(opt.value)
    rootRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus()
  }

  return (
    <div
      ref={rootRef}
      role="radiogroup"
      className={clsx(
        styles.root,
        variant === 'surface' && styles.surface,
        variant === 'input' && styles.input,
        size === 22 && styles.h22,
        textSize === 11 && styles.text11,
        iconOnly && styles.iconOnly,
        fullWidth && styles.fullWidth,
        className,
      )}
      onKeyDown={onKeyDown}
      {...rest}
    >
      {options.map((o) => {
        const selected = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={o['aria-label']}
            title={o.label === undefined ? o['aria-label'] : undefined}
            tabIndex={selected ? 0 : -1}
            disabled={o.disabled}
            className={styles.item}
            style={itemWidth !== undefined ? { width: itemWidth, flex: 'none' } : undefined}
            onClick={() => !selected && onChange(o.value)}
          >
            {o.icon}
            {o.label !== undefined && (
              <span className={styles.label} data-text={o.label}>
                {o.label}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
