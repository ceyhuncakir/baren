/**
 * Number-field math: parsing typed input (with units and simple arithmetic), clamping,
 * rounding, keyboard nudges and drag-to-scrub deltas.
 */

export interface NumberConstraints {
  min?: number
  max?: number
  /** Decimal places kept (default 2). */
  precision?: number
}

export function clamp(value: number, min = -Infinity, max = Infinity): number {
  return Math.min(Math.max(value, min), max)
}

export function roundTo(value: number, precision = 2): number {
  const f = 10 ** precision
  const r = Math.round(value * f) / f
  // Avoid "-0" in the UI.
  return Object.is(r, -0) ? 0 : r
}

export function constrain(value: number, c: NumberConstraints = {}): number {
  return roundTo(clamp(value, c.min, c.max), c.precision ?? 2)
}

/** "1440" → "1440", 12.5 → "12.5", with optional unit suffix ("°", "%"). */
export function formatNumber(value: number, unit = '', precision = 2): string {
  return `${roundTo(value, precision)}${unit}`
}

const EXPR_RE = /^\s*(-?\d*\.?\d+)\s*(?:([+\-*/])\s*(-?\d*\.?\d+))?\s*$/

/**
 * Parses inspector input. Accepts a number with an optional unit ("24px", "45°", "50%")
 * and one binary operation ("100+20", "96/2") like design tools do. A leading operator
 * applies to the current value ("+10" → current + 10). Returns null when invalid.
 */
export function parseNumberInput(
  text: string,
  current: number,
  unit = '',
  c: NumberConstraints = {},
): number | null {
  let t = text.trim()
  if (unit && t.endsWith(unit)) t = t.slice(0, -unit.length)
  t = t.replace(/(px|%|°)$/i, '').trim()
  if (t === '') return null

  const relative = /^([+*/])\s*(-?\d*\.?\d+)$/.exec(t)
  if (relative) {
    return applyOp(current, relative[1] as Op, Number(relative[2]), c)
  }
  const m = EXPR_RE.exec(t)
  if (!m) return null
  const a = Number(m[1])
  if (m[2] === undefined || m[3] === undefined) return constrain(a, c)
  return applyOp(a, m[2] as Op, Number(m[3]), c)
}

type Op = '+' | '-' | '*' | '/'

function applyOp(a: number, op: Op, b: number, c: NumberConstraints): number | null {
  let r: number
  switch (op) {
    case '+':
      r = a + b
      break
    case '-':
      r = a - b
      break
    case '*':
      r = a * b
      break
    case '/':
      if (b === 0) return null
      r = a / b
      break
  }
  return Number.isFinite(r) ? constrain(r, c) : null
}

export interface StepModifiers {
  shiftKey?: boolean
  altKey?: boolean
}

/** Keyboard/scrub step: base step, ×10 with Shift, ÷10 with Alt. */
export function stepFor(step: number, mods: StepModifiers): number {
  if (mods.shiftKey) return step * 10
  if (mods.altKey) return step / 10
  return step
}

/** Arrow-key nudge. */
export function nudge(
  value: number,
  direction: 1 | -1,
  step: number,
  mods: StepModifiers,
  c: NumberConstraints = {},
): number {
  return constrain(value + direction * stepFor(step, mods), c)
}

/**
 * Drag-to-scrub: every `pixelsPerStep` pixels of horizontal travel changes the value by
 * one step. `deltaPx` is the total travel since the drag started, so the result does not
 * accumulate rounding error.
 */
export function scrubValue(
  start: number,
  deltaPx: number,
  step: number,
  mods: StepModifiers,
  c: NumberConstraints = {},
  pixelsPerStep = 2,
): number {
  const steps = Math.trunc(deltaPx / pixelsPerStep)
  return constrain(start + steps * stepFor(step, mods), c)
}

/** Slider: pointer x within a track → value snapped to `step`. */
export function valueFromRatio(ratio: number, min: number, max: number, step: number): number {
  const r = clamp(ratio, 0, 1)
  const raw = min + r * (max - min)
  const snapped = step > 0 ? Math.round((raw - min) / step) * step + min : raw
  const decimals = (String(step).split('.')[1] ?? '').length
  return roundTo(clamp(snapped, min, max), Math.max(decimals, 0))
}

export function ratioFromValue(value: number, min: number, max: number): number {
  if (max === min) return 0
  return clamp((value - min) / (max - min), 0, 1)
}
