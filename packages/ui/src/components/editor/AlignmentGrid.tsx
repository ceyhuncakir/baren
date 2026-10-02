import { clsx } from 'clsx'
import { memo, useRef, type KeyboardEvent } from 'react'
import styles from './AlignmentGrid.module.css'

export type AxisAlign = 'start' | 'center' | 'end'

export interface Alignment {
  /** Horizontal position of children. */
  x: AxisAlign
  /** Vertical position of children. */
  y: AxisAlign
}

export interface AlignmentGridProps {
  value: Alignment
  onChange: (value: Alignment) => void
  /** Flex direction of the frame: bars are drawn across the main axis. */
  direction?: 'row' | 'column'
  /**
   * 'space-between' shows children spread along the main axis (all three cells on the
   * main-axis line through the current cross alignment are filled).
   */
  distribution?: 'packed' | 'space-between'
  'aria-label'?: string
  className?: string
}

const AXIS: readonly AxisAlign[] = ['start', 'center', 'end']
const X_CLASS = [styles.x0, styles.x1, styles.x2]
const Y_CLASS = [styles.y0, styles.y1, styles.y2]
const NAMES = {
  start: ['left', 'top'],
  center: ['center', 'middle'],
  end: ['right', 'bottom'],
} as const

function isActive(
  xi: number,
  yi: number,
  value: Alignment,
  direction: 'row' | 'column',
  distribution: 'packed' | 'space-between',
): boolean {
  const vx = AXIS.indexOf(value.x)
  const vy = AXIS.indexOf(value.y)
  if (distribution === 'space-between') {
    // Main axis spread: column → all rows at the cross (x) position; row → all columns at y.
    return direction === 'column' ? xi === vx : yi === vy
  }
  return xi === vx && yi === vy
}

/**
 * 3×3 alignment picker for flex frames (06, Flex section). Each cell is a button; the
 * active cell shows a blue bar oriented across the main axis. Arrow keys move the
 * alignment.
 */
export const AlignmentGrid = memo(function AlignmentGrid({
  value,
  onChange,
  direction = 'column',
  distribution = 'packed',
  className,
  ...aria
}: AlignmentGridProps) {
  const ref = useRef<HTMLDivElement>(null)

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const vx = AXIS.indexOf(value.x)
    const vy = AXIS.indexOf(value.y)
    let nx = vx
    let ny = vy
    if (e.key === 'ArrowLeft') nx = Math.max(0, vx - 1)
    else if (e.key === 'ArrowRight') nx = Math.min(2, vx + 1)
    else if (e.key === 'ArrowUp') ny = Math.max(0, vy - 1)
    else if (e.key === 'ArrowDown') ny = Math.min(2, vy + 1)
    else return
    e.preventDefault()
    const x = AXIS[nx]
    const y = AXIS[ny]
    if (!x || !y) return
    onChange({ x, y })
    ref.current?.querySelectorAll<HTMLButtonElement>('button')[ny * 3 + nx]?.focus()
  }

  return (
    <div
      ref={ref}
      role="group"
      aria-label={aria['aria-label'] ?? 'Alignment'}
      className={clsx(styles.grid, className)}
      onKeyDown={onKeyDown}
    >
      {AXIS.map((y, yi) =>
        AXIS.map((x, xi) => {
          const active = isActive(xi, yi, value, direction, distribution)
          const current = x === value.x && y === value.y
          return (
            <button
              key={`${x}-${y}`}
              type="button"
              tabIndex={current ? 0 : -1}
              aria-pressed={current}
              aria-label={`Align ${NAMES[y][1]} ${NAMES[x][0]}`}
              className={clsx(styles.cell, X_CLASS[xi], Y_CLASS[yi])}
              onClick={() => onChange({ x, y })}
            >
              {active ? (
                <span
                  className={clsx(
                    styles.bar,
                    direction === 'column' ? styles.barColumn : styles.barRow,
                  )}
                />
              ) : (
                <span className={styles.dot} />
              )}
            </button>
          )
        }),
      )}
    </div>
  )
})
