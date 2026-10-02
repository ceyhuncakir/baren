import { clsx } from 'clsx'
import { Fragment, useState, type InputHTMLAttributes, type Ref } from 'react'
import { useStableCallback } from '../../lib/hooks'
import { nextCode, sanitizeCode } from '../../lib/text'
import styles from './CodeInput.module.css'

export interface CodeInputProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'value' | 'onChange' | 'size' | 'maxLength'
> {
  value: string
  onChange: (value: string) => void
  /** Fired when the cells become a complete code (the last cell typed, or a new code pasted). */
  onComplete?: (value: string) => void
  length?: number
  /** Dash after every `groupSize` cells (default 3: six cells read 3 + 3). 0 disables. */
  groupSize?: number
  /** Accept letters too (device codes). */
  alphanumeric?: boolean
  invalid?: boolean
  /** Static specimens only: draw the focused state without taking focus. */
  showFocus?: boolean
  ref?: Ref<HTMLInputElement>
}

/**
 * One-time code entry (artboard 20). A single transparent input covers the cells, so
 * typing, backspace, paste and OS autofill (`autocomplete="one-time-code"`) just work.
 */
export function CodeInput({
  value,
  onChange,
  onComplete,
  length = 6,
  groupSize = 3,
  alphanumeric = false,
  invalid = false,
  showFocus = false,
  disabled,
  className,
  onFocus,
  onBlur,
  ref,
  ...rest
}: CodeInputProps) {
  const [focused, setFocused] = useState(false)
  const complete = useStableCallback(onComplete)
  const code = sanitizeCode(value, length, alphanumeric)
  const active = focused || showFocus ? Math.min(code.length, length - 1) : -1

  return (
    <div
      className={clsx(
        styles.root,
        invalid && styles.invalid,
        disabled && styles.disabled,
        className,
      )}
    >
      {Array.from({ length }, (_, i) => (
        <Fragment key={i}>
          {groupSize > 0 && i > 0 && i % groupSize === 0 && (
            <span className={styles.dash} aria-hidden="true" />
          )}
          <span
            className={styles.cell}
            data-active={i === active ? '' : undefined}
            aria-hidden="true"
          >
            {code[i] ??
              (i === active && code.length < length ? <span className={styles.caret} /> : null)}
          </span>
        </Fragment>
      ))}
      <input
        ref={ref}
        className={styles.input}
        value={code}
        disabled={disabled}
        inputMode={alphanumeric ? 'text' : 'numeric'}
        autoComplete="one-time-code"
        autoCapitalize={alphanumeric ? 'characters' : 'off'}
        spellCheck={false}
        // Room for separators ("482 719") and for a new code pasted after a complete one.
        maxLength={2 * length + 4}
        aria-invalid={invalid || undefined}
        onChange={(e) => {
          const next = nextCode(e.currentTarget.value, code, length, alphanumeric)
          onChange(next)
          if (next.length === length && next !== code) complete(next)
        }}
        onFocus={(e) => {
          setFocused(true)
          const el = e.currentTarget
          // Keep the caret at the end so typing always appends.
          requestAnimationFrame(() => el.setSelectionRange(el.value.length, el.value.length))
          onFocus?.(e)
        }}
        onBlur={(e) => {
          setFocused(false)
          onBlur?.(e)
        }}
        {...rest}
      />
    </div>
  )
}
