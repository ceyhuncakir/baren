import { clsx } from 'clsx'
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type HTMLAttributes,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'
import { hsvToRgb, hueToCss, type Hsva } from '../../lib/color'
import { useStableCallback } from '../../lib/hooks'
import { clamp } from '../../lib/number'
import { rafThrottle } from '../../lib/raf'
import styles from './ColorPicker.module.css'

const HANDLE = 14

type Target = 'area' | 'hue' | 'alpha'

export interface ColorPickerProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onChange'> {
  /** Controlled HSVA (keeps hue stable through grays; convert with hexToHsva/hsvaToHex). */
  value: Hsva
  /** At most once per animation frame while dragging. */
  onChange: (value: Hsva) => void
  /** Once per gesture end (commit to the document here). */
  onChangeEnd?: (value: Hsva) => void
  showAlpha?: boolean
}

function vars(c: Hsva): Record<string, string> {
  const { r, g, b } = hsvToRgb(c.h, c.s, c.v)
  const rgb = `${Math.round(r)} ${Math.round(g)} ${Math.round(b)}`
  return {
    '--h-ratio': String(c.h / 360),
    '--s': String(c.s),
    '--v': String(c.v),
    '--a': String(c.a),
    '--hue-color': hueToCss(c.h),
    '--color-current': `rgb(${rgb})`,
    '--opaque-color': `rgb(${rgb})`,
    '--color-current-alpha': `rgb(${rgb} / ${c.a})`,
  }
}

/**
 * Saturation/value square + hue bar (+ alpha bar), artboard 07. Dragging writes CSS
 * variables straight to the DOM so handles track the pointer every frame; `onChange` is
 * coalesced to one call per frame.
 */
export function ColorPicker({
  value,
  onChange,
  onChangeEnd,
  showAlpha = true,
  className,
  style,
  ...rest
}: ColorPickerProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const current = useRef(value)
  const drag = useRef<Target | null>(null)
  const emit = useStableCallback(onChange)
  const emitEnd = useStableCallback(onChangeEnd)
  const throttled = useMemo(() => rafThrottle((c: Hsva) => emit(c)), [emit])
  useEffect(() => () => throttled.cancel(), [throttled])

  // Follow external changes when not dragging.
  useLayoutEffect(() => {
    if (drag.current === null) current.current = value
  }, [value])

  const apply = (next: Hsva) => {
    current.current = next
    const el = rootRef.current
    if (el) for (const [k, v] of Object.entries(vars(next))) el.style.setProperty(k, v)
    throttled(next)
  }

  const fromPointer = (target: Target, e: PointerEvent<HTMLDivElement>): Hsva => {
    const rect = e.currentTarget.getBoundingClientRect()
    const c = current.current
    if (target === 'area') {
      const s = clamp((e.clientX - rect.left) / rect.width, 0, 1)
      const v = 1 - clamp((e.clientY - rect.top) / rect.height, 0, 1)
      return { ...c, s, v }
    }
    const ratio = clamp(
      (e.clientX - rect.left - HANDLE / 2) / Math.max(1, rect.width - HANDLE),
      0,
      1,
    )
    return target === 'hue' ? { ...c, h: ratio * 360 } : { ...c, a: Math.round(ratio * 100) / 100 }
  }

  const handlers = (target: Target) => ({
    onPointerDown: (e: PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return
      e.preventDefault()
      e.currentTarget.setPointerCapture(e.pointerId)
      e.currentTarget.querySelector<HTMLElement>('[role="slider"]')?.focus({ preventScroll: true })
      drag.current = target
      apply(fromPointer(target, e))
    },
    onPointerMove: (e: PointerEvent<HTMLDivElement>) => {
      if (drag.current !== target) return
      apply(fromPointer(target, e))
    },
    onPointerUp: () => end(target),
    onPointerCancel: () => end(target),
    onLostPointerCapture: () => end(target),
  })

  const end = (target: Target) => {
    if (drag.current !== target) return
    drag.current = null
    throttled.flush()
    emitEnd(current.current)
  }

  const onKey = (target: Target) => (e: KeyboardEvent<HTMLDivElement>) => {
    const c = current.current
    const big = e.shiftKey ? 10 : 1
    let next: Hsva | null = null
    if (target === 'area') {
      if (e.key === 'ArrowLeft') next = { ...c, s: clamp(c.s - 0.01 * big, 0, 1) }
      else if (e.key === 'ArrowRight') next = { ...c, s: clamp(c.s + 0.01 * big, 0, 1) }
      else if (e.key === 'ArrowUp') next = { ...c, v: clamp(c.v + 0.01 * big, 0, 1) }
      else if (e.key === 'ArrowDown') next = { ...c, v: clamp(c.v - 0.01 * big, 0, 1) }
    } else if (target === 'hue') {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown')
        next = { ...c, h: clamp(c.h - big, 0, 360) }
      else if (e.key === 'ArrowRight' || e.key === 'ArrowUp')
        next = { ...c, h: clamp(c.h + big, 0, 360) }
    } else {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown')
        next = { ...c, a: clamp(c.a - 0.01 * big, 0, 1) }
      else if (e.key === 'ArrowRight' || e.key === 'ArrowUp')
        next = { ...c, a: clamp(c.a + 0.01 * big, 0, 1) }
    }
    if (!next) return
    e.preventDefault()
    current.current = next
    emit(next)
    emitEnd(next)
  }

  return (
    <div
      ref={rootRef}
      className={clsx(styles.picker, className)}
      style={{ ...(vars(value) as CSSProperties), ...style }}
      {...rest}
    >
      <div className={styles.area} {...handlers('area')}>
        <div
          role="slider"
          tabIndex={0}
          aria-label="Saturation and brightness"
          aria-valuetext={`Saturation ${Math.round(value.s * 100)}%, brightness ${Math.round(value.v * 100)}%`}
          className={styles.areaHandle}
          onKeyDown={onKey('area')}
        />
      </div>
      <div className={clsx(styles.bar, styles.hue)} {...handlers('hue')}>
        <div
          role="slider"
          tabIndex={0}
          aria-label="Hue"
          aria-valuemin={0}
          aria-valuemax={360}
          aria-valuenow={Math.round(value.h)}
          className={clsx(styles.barHandle, styles.hueHandle)}
          onKeyDown={onKey('hue')}
        />
      </div>
      {showAlpha && (
        <div className={clsx(styles.bar, styles.alpha)} {...handlers('alpha')}>
          <div
            role="slider"
            tabIndex={0}
            aria-label="Opacity"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(value.a * 100)}
            className={clsx(styles.barHandle, styles.alphaHandle)}
            onKeyDown={onKey('alpha')}
          />
        </div>
      )}
    </div>
  )
}
