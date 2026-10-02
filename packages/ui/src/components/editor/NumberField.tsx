import { clsx } from 'clsx'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type HTMLAttributes,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type Ref,
} from 'react'
import { ChevronDownIcon } from '../../icons/icons'
import { useStableCallback } from '../../lib/hooks'
import { formatNumber, nudge, parseNumberInput, scrubValue } from '../../lib/number'
import { rafThrottle } from '../../lib/raf'
import { fieldClass } from './Inspector'
import styles from './Inspector.module.css'

export interface NumberChangeMeta {
  /** false while scrubbing (preview), true on commit (Enter, blur, arrow key, drag end). */
  final: boolean
}

export interface NumberFieldProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  'onChange' | 'prefix'
> {
  /** null shows "Mixed" (multi-selection with different values). */
  value: number | null
  onChange: (value: number, meta: NumberChangeMeta) => void
  /** Scrub handle: label letter ("X", "W") or an 11px icon. */
  prefix?: ReactNode
  prefixStrong?: boolean
  /** Unit appended to the display ("°", "%"). */
  unit?: string
  min?: number
  max?: number
  step?: number
  precision?: number
  /** Dropdown chevron (W/H "Fit", gap presets). */
  chevron?: boolean
  onChevronClick?: () => void
  size?: 26 | 28
  width?: number
  disabled?: boolean
  placeholder?: string
  'aria-label'?: string
  inputRef?: Ref<HTMLInputElement>
}

/**
 * Inspector number input. Drag the prefix horizontally to scrub (Shift ×10, Alt ÷10),
 * ArrowUp/Down to nudge, type values with units or simple math ("96/2", "+10").
 * Scrub updates are coalesced to one per frame and reported with `final: false`; the
 * gesture end reports `final: true` so the editor commits to Loro once.
 */
export function NumberField({
  value,
  onChange,
  prefix,
  prefixStrong = false,
  unit = '',
  min,
  max,
  step = 1,
  precision = 2,
  chevron = false,
  onChevronClick,
  size = 26,
  width,
  disabled = false,
  placeholder = 'Mixed',
  className,
  style,
  'aria-label': ariaLabel,
  inputRef,
  ...rest
}: NumberFieldProps) {
  const [draft, setDraft] = useState<string | null>(null)
  const constraints = useMemo(() => ({ min, max, precision }), [min, max, precision])
  const emit = useStableCallback(onChange)
  const preview = useMemo(() => rafThrottle((v: number) => emit(v, { final: false })), [emit])
  useEffect(() => () => preview.cancel(), [preview])
  const scrub = useRef<{ startX: number; start: number; last: number; pointerId: number } | null>(
    null,
  )

  const display = value === null ? '' : formatNumber(value, unit, precision)
  const current = value ?? 0

  const commit = (text: string) => {
    const parsed = parseNumberInput(text, current, unit, constraints)
    setDraft(null)
    if (parsed !== null && parsed !== value) emit(parsed, { final: true })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commit(e.currentTarget.value)
      e.currentTarget.select()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setDraft(null)
      e.currentTarget.blur()
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      const base = parseNumberInput(e.currentTarget.value, current, unit, constraints) ?? current
      const next = nudge(base, e.key === 'ArrowUp' ? 1 : -1, step, e, constraints)
      setDraft(formatNumber(next, unit, precision))
      emit(next, { final: true })
      const input = e.currentTarget
      requestAnimationFrame(() => input.select())
    }
  }

  const onScrubDown = (e: PointerEvent<HTMLSpanElement>) => {
    if (disabled || e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    scrub.current = { startX: e.clientX, start: current, last: current, pointerId: e.pointerId }
    document.documentElement.style.cursor = 'ew-resize'
  }

  const onScrubMove = (e: PointerEvent<HTMLSpanElement>) => {
    const s = scrub.current
    if (!s) return
    const next = scrubValue(s.start, e.clientX - s.startX, step, e, constraints)
    if (next === s.last) return
    s.last = next
    preview(next)
  }

  const onScrubEnd = () => {
    const s = scrub.current
    if (!s) return
    scrub.current = null
    document.documentElement.style.cursor = ''
    preview.cancel()
    if (s.last !== s.start) emit(s.last, { final: true })
  }

  return (
    <div
      className={clsx(fieldClass({ chevron, size, width }), className)}
      style={width !== undefined ? { width, ...style } : style}
      data-disabled={disabled ? '' : undefined}
      {...rest}
    >
      {prefix !== undefined && (
        <span
          className={clsx(
            styles.prefix,
            prefixStrong && styles.prefixStrong,
            !disabled && styles.scrub,
          )}
          aria-hidden="true"
          onPointerDown={onScrubDown}
          onPointerMove={onScrubMove}
          onPointerUp={onScrubEnd}
          onPointerCancel={onScrubEnd}
          onLostPointerCapture={onScrubEnd}
        >
          {prefix}
        </span>
      )}
      <input
        ref={inputRef}
        className={styles.input}
        value={draft ?? display}
        placeholder={value === null ? placeholder : undefined}
        disabled={disabled}
        inputMode="decimal"
        spellCheck={false}
        aria-label={ariaLabel}
        onChange={(e) => setDraft(e.currentTarget.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={(e) => {
          if (draft !== null) commit(e.currentTarget.value)
        }}
        onKeyDown={onKeyDown}
      />
      {chevron && (
        <button
          type="button"
          tabIndex={-1}
          aria-label="Presets"
          className={styles.chevron}
          style={{ display: 'flex' }}
          onClick={onChevronClick}
        >
          <ChevronDownIcon size={10} strokeWidth={2.5} />
        </button>
      )}
    </div>
  )
}
