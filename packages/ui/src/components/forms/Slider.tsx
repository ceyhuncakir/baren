import { clsx } from 'clsx'
import {
  useEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type HTMLAttributes,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'
import { useStableCallback } from '../../lib/hooks'
import { clamp, ratioFromValue, valueFromRatio } from '../../lib/number'
import { rafThrottle } from '../../lib/raf'
import styles from './Slider.module.css'

const THUMB = 14

export interface SliderProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  'onChange' | 'defaultValue'
> {
  value: number
  min?: number
  max?: number
  step?: number
  /** Called at most once per animation frame while dragging. */
  onChange: (value: number) => void
  /** Called once when a drag or key press ends (commit to the document here). */
  onChangeEnd?: (value: number) => void
  disabled?: boolean
  'aria-label'?: string
}

/**
 * Pointer + keyboard slider. During a drag the thumb is moved by writing a CSS variable
 * directly, so it tracks the pointer in the same frame even if the parent re-renders late.
 */
export function Slider({
  value,
  min = 0,
  max = 100,
  step = 1,
  onChange,
  onChangeEnd,
  disabled = false,
  className,
  style,
  'aria-label': ariaLabel,
  ...rest
}: SliderProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const dragValue = useRef<number | null>(null)
  const emit = useStableCallback(onChange)
  const emitEnd = useStableCallback(onChangeEnd)
  const throttled = useMemo(() => rafThrottle((v: number) => emit(v)), [emit])
  useEffect(() => () => throttled.cancel(), [throttled])

  const setVisual = (v: number) => {
    rootRef.current?.style.setProperty('--ratio', String(ratioFromValue(v, min, max)))
  }

  const valueAt = (clientX: number): number => {
    const track = trackRef.current
    if (!track) return value
    const rect = track.getBoundingClientRect()
    const usable = Math.max(1, rect.width - THUMB)
    return valueFromRatio((clientX - rect.left - THUMB / 2) / usable, min, max, step)
  }

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (disabled || e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    rootRef.current?.querySelector<HTMLElement>('[role="slider"]')?.focus({ preventScroll: true })
    const v = valueAt(e.clientX)
    dragValue.current = v
    setVisual(v)
    throttled(v)
  }

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (dragValue.current === null) return
    const v = valueAt(e.clientX)
    if (v === dragValue.current) return
    dragValue.current = v
    setVisual(v)
    throttled(v)
  }

  const endDrag = () => {
    if (dragValue.current === null) return
    throttled.flush()
    emitEnd(dragValue.current)
    dragValue.current = null
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const big = Math.max(step, (max - min) / 10)
    let next: number | null = null
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp')
      next = value + (e.shiftKey ? step * 10 : step)
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown')
      next = value - (e.shiftKey ? step * 10 : step)
    else if (e.key === 'PageUp') next = value + big
    else if (e.key === 'PageDown') next = value - big
    else if (e.key === 'Home') next = min
    else if (e.key === 'End') next = max
    if (next === null) return
    e.preventDefault()
    const v = valueFromRatio(ratioFromValue(clamp(next, min, max), min, max), min, max, step)
    emit(v)
    emitEnd(v)
  }

  const ratio = ratioFromValue(value, min, max)
  return (
    <div
      ref={rootRef}
      className={clsx(styles.slider, disabled && styles.disabled, className)}
      style={{ '--ratio': ratio, ...style } as CSSProperties}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      {...rest}
    >
      <div ref={trackRef} className={styles.track}>
        <div
          role="slider"
          tabIndex={disabled ? -1 : 0}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={value}
          aria-disabled={disabled || undefined}
          aria-label={ariaLabel}
          className={styles.thumb}
          onKeyDown={onKeyDown}
        />
      </div>
    </div>
  )
}
