/**
 * Shorthand families (contract §7.6 rule 4). Every family is a set of slots (e.g. the four
 * padding sides); shorthands and longhands — stored or written — are read into slots, and a
 * family is always stored in one canonical form computed from its slots:
 *
 * - padding / margin: 1 value → `padding`; block and inline pairs → `paddingBlock` +
 *   `paddingInline`; equal left/right → `paddingTop` + `paddingInline` + `paddingBottom`;
 *   otherwise the four longhands.
 * - inset: the four longhands (`top` `right` `bottom` `left`), never `inset`.
 * - gap / overflow / radius / border width·style·colour: one key when every slot is equal,
 *   else the longhands.
 * - background (single layer): `backgroundColor/Image/Position/Size/Repeat…`; several layers
 *   stay `background` (opaque).
 * - flex: `flexGrow` `flexShrink` `flexBasis`; outline: `outlineWidth/Style/Color`.
 *
 * A slot is a value, `null` (removed / reset by a shorthand) or absent (untouched). Reading
 * existing styles plus a patch and emitting gives the update that keeps stored styles from
 * disagreeing (`clearedFamilyKeys`).
 */
import type { StyleValue } from '@baren/schema'
import { isNamedColor, parseCssColor } from './color.ts'
import { splitTopLevel, splitValues, topLevelIndex } from './syntax.ts'

export type SlotValue = StyleValue | null

export interface Family {
  name: string
  slots: readonly string[]
  /** Keys this family stores (canonical forms and its opaque shorthand). */
  stored: readonly string[]
  /** Every key the family reads or stores → the slots it covers. */
  cover: ReadonlyMap<string, readonly string[]>
  /** Order in which stored keys are read (shorthands first, longhands last). */
  readOrder: readonly string[]
  /** Read one declaration; `'opaque'` = keep the value as written (cannot be split). */
  read(key: string, value: SlotValue, set: (slot: string, v: SlotValue) => void): 'ok' | 'opaque'
  /** Canonical entries for the slots that have values. */
  emit(slots: ReadonlyMap<string, SlotValue>): [string, StyleValue][]
}

export interface FamilyState {
  slots: Map<string, SlotValue>
  opaque: { key: string; value: StyleValue } | null
}

const SIDES = ['t', 'r', 'b', 'l'] as const

/** Same CSS value (numbers are px). */
export function sameValue(a: SlotValue | undefined, b: SlotValue | undefined): boolean {
  if (a === undefined || b === undefined || a === null || b === null) return false
  const s = (v: StyleValue): string => (typeof v === 'number' ? `${v}px` : v.trim())
  return s(a) === s(b)
}

/** CSS 1–4 value box expansion → [t, r, b, l], or null for another count. */
export function boxSides(tokens: readonly string[]): [string, string, string, string] | null {
  const [a, b, c, d] = tokens
  switch (tokens.length) {
    case 1:
      return [a!, a!, a!, a!]
    case 2:
      return [a!, b!, a!, b!]
    case 3:
      return [a!, b!, c!, b!]
    case 4:
      return [a!, b!, c!, d!]
    default:
      return null
  }
}

function coverMap(entries: [string, readonly string[]][]): ReadonlyMap<string, readonly string[]> {
  return new Map(entries)
}

/** Assign a 1–4 value box to four slots (numbers fill all four). */
function readBox(
  value: SlotValue,
  slots: readonly [string, string, string, string],
  set: (slot: string, v: SlotValue) => void,
): 'ok' | 'opaque' {
  if (value === null || typeof value === 'number') {
    for (const s of slots) set(s, value)
    return 'ok'
  }
  const sides = boxSides(splitValues(value))
  if (!sides) return 'opaque'
  slots.forEach((s, i) => set(s, sides[i] as string))
  return 'ok'
}

/** Assign a 1–2 value pair (`paddingBlock`: start, end). */
function readPair(
  value: SlotValue,
  a: string,
  b: string,
  set: (slot: string, v: SlotValue) => void,
): 'ok' | 'opaque' {
  if (value === null || typeof value === 'number') {
    set(a, value)
    set(b, value)
    return 'ok'
  }
  const t = splitValues(value)
  if (t.length === 1) {
    set(a, t[0] as string)
    set(b, t[0] as string)
    return 'ok'
  }
  if (t.length === 2) {
    set(a, t[0] as string)
    set(b, t[1] as string)
    return 'ok'
  }
  return 'opaque'
}

const has = (v: SlotValue | undefined): v is StyleValue => v !== undefined && v !== null

// ---------------------------------------------------------------------------
// padding / margin
// ---------------------------------------------------------------------------

function boxFamily(prefix: 'padding' | 'margin'): Family {
  const k = (s: string): string => prefix + s
  const cover = coverMap([
    [prefix, SIDES],
    [k('Block'), ['t', 'b']],
    [k('Inline'), ['l', 'r']],
    [k('BlockStart'), ['t']],
    [k('BlockEnd'), ['b']],
    [k('InlineStart'), ['l']],
    [k('InlineEnd'), ['r']],
    [k('Top'), ['t']],
    [k('Right'), ['r']],
    [k('Bottom'), ['b']],
    [k('Left'), ['l']],
  ])
  return {
    name: prefix,
    slots: SIDES,
    stored: [prefix, k('Block'), k('Inline'), k('Top'), k('Right'), k('Bottom'), k('Left')],
    cover,
    readOrder: [...cover.keys()],
    read(key, value, set) {
      switch (key) {
        case prefix:
          return readBox(value, SIDES, set)
        case k('Block'):
          return readPair(value, 't', 'b', set)
        case k('Inline'):
          return readPair(value, 'l', 'r', set)
        default: {
          const slots = cover.get(key)
          if (!slots) return 'opaque'
          set(slots[0] as string, value)
          return 'ok'
        }
      }
    },
    emit(slots) {
      const t = slots.get('t')
      const r = slots.get('r')
      const b = slots.get('b')
      const l = slots.get('l')
      const out: [string, StyleValue][] = []
      if (has(t) && has(r) && has(b) && has(l)) {
        if (sameValue(t, r) && sameValue(t, b) && sameValue(t, l)) return [[prefix, t]]
        if (sameValue(t, b) && sameValue(l, r))
          return [
            [k('Block'), t],
            [k('Inline'), l],
          ]
        if (sameValue(l, r))
          return [
            [k('Top'), t],
            [k('Inline'), l],
            [k('Bottom'), b],
          ]
        return [
          [k('Top'), t],
          [k('Right'), r],
          [k('Bottom'), b],
          [k('Left'), l],
        ]
      }
      if (has(t) && has(b) && sameValue(t, b)) out.push([k('Block'), t])
      else {
        if (has(t)) out.push([k('Top'), t])
        if (has(b)) out.push([k('Bottom'), b])
      }
      if (has(l) && has(r) && sameValue(l, r)) out.push([k('Inline'), l])
      else {
        if (has(r)) out.push([k('Right'), r])
        if (has(l)) out.push([k('Left'), l])
      }
      return out
    },
  }
}

// ---------------------------------------------------------------------------
// inset
// ---------------------------------------------------------------------------

const insetCover = coverMap([
  ['inset', SIDES],
  ['insetBlock', ['t', 'b']],
  ['insetInline', ['l', 'r']],
  ['insetBlockStart', ['t']],
  ['insetBlockEnd', ['b']],
  ['insetInlineStart', ['l']],
  ['insetInlineEnd', ['r']],
  ['top', ['t']],
  ['right', ['r']],
  ['bottom', ['b']],
  ['left', ['l']],
])

const insetFamily: Family = {
  name: 'inset',
  slots: SIDES,
  stored: ['top', 'right', 'bottom', 'left'],
  cover: insetCover,
  readOrder: [...insetCover.keys()],
  read(key, value, set) {
    switch (key) {
      case 'inset':
        return readBox(value, SIDES, set)
      case 'insetBlock':
        return readPair(value, 't', 'b', set)
      case 'insetInline':
        return readPair(value, 'l', 'r', set)
      default: {
        const slots = insetCover.get(key)
        if (!slots) return 'opaque'
        set(slots[0] as string, value)
        return 'ok'
      }
    }
  },
  emit(slots) {
    const out: [string, StyleValue][] = []
    for (const [slot, key] of [
      ['t', 'top'],
      ['r', 'right'],
      ['b', 'bottom'],
      ['l', 'left'],
    ] as const) {
      const v = slots.get(slot)
      if (has(v)) out.push([key, v])
    }
    return out
  },
}

// ---------------------------------------------------------------------------
// two-slot families: gap, overflow
// ---------------------------------------------------------------------------

function pairFamily(
  name: string,
  shorthand: string,
  first: string,
  second: string,
  aliases: [string, readonly string[]][] = [],
): Family {
  const cover = coverMap([[shorthand, ['a', 'b']], ...aliases, [first, ['a']], [second, ['b']]])
  return {
    name,
    slots: ['a', 'b'],
    stored: [shorthand, first, second],
    cover,
    readOrder: [...cover.keys()],
    read(key, value, set) {
      const slots = cover.get(key)
      if (!slots) return 'opaque'
      if (slots.length === 1) {
        set(slots[0] as string, value)
        return 'ok'
      }
      return readPair(value, 'a', 'b', set)
    },
    emit(slots) {
      const a = slots.get('a')
      const b = slots.get('b')
      if (has(a) && has(b) && sameValue(a, b)) return [[shorthand, a]]
      const out: [string, StyleValue][] = []
      if (has(a)) out.push([first, a])
      if (has(b)) out.push([second, b])
      return out
    },
  }
}

const gapFamily = pairFamily('gap', 'gap', 'rowGap', 'columnGap', [
  ['gridGap', ['a', 'b']],
  ['gridRowGap', ['a']],
  ['gridColumnGap', ['b']],
])
const overflowFamily = pairFamily('overflow', 'overflow', 'overflowX', 'overflowY')

// ---------------------------------------------------------------------------
// radius
// ---------------------------------------------------------------------------

const CORNERS = ['tl', 'tr', 'br', 'bl'] as const
const radiusCover = coverMap([
  ['borderRadius', CORNERS],
  ['borderStartStartRadius', ['tl']],
  ['borderStartEndRadius', ['tr']],
  ['borderEndEndRadius', ['br']],
  ['borderEndStartRadius', ['bl']],
  ['borderTopLeftRadius', ['tl']],
  ['borderTopRightRadius', ['tr']],
  ['borderBottomRightRadius', ['br']],
  ['borderBottomLeftRadius', ['bl']],
])

const radiusFamily: Family = {
  name: 'radius',
  slots: CORNERS,
  stored: [
    'borderRadius',
    'borderTopLeftRadius',
    'borderTopRightRadius',
    'borderBottomRightRadius',
    'borderBottomLeftRadius',
  ],
  cover: radiusCover,
  readOrder: [...radiusCover.keys()],
  read(key, value, set) {
    if (key === 'borderRadius') {
      if (typeof value === 'string' && topLevelIndex(value, '/') !== -1) return 'opaque'
      return readBox(value, CORNERS, set)
    }
    const slots = radiusCover.get(key)
    if (!slots) return 'opaque'
    set(slots[0] as string, value)
    return 'ok'
  },
  emit(slots) {
    const v = CORNERS.map((c) => slots.get(c))
    if (v.every(has) && v.every((x) => sameValue(x, v[0])))
      return [['borderRadius', v[0] as StyleValue]]
    const keys = [
      'borderTopLeftRadius',
      'borderTopRightRadius',
      'borderBottomRightRadius',
      'borderBottomLeftRadius',
    ]
    const out: [string, StyleValue][] = []
    v.forEach((x, i) => {
      if (has(x)) out.push([keys[i] as string, x])
    })
    return out
  },
}

// ---------------------------------------------------------------------------
// border (width / style / colour per side)
// ---------------------------------------------------------------------------

const BORDER_STYLES = new Set([
  'none',
  'hidden',
  'dotted',
  'dashed',
  'solid',
  'double',
  'groove',
  'ridge',
  'inset',
  'outset',
])
const OUTLINE_STYLES = new Set([...BORDER_STYLES, 'auto'])
const WIDTH_KEYWORDS = new Set(['thin', 'medium', 'thick'])
const LENGTH_RE =
  /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?(?:px|em|rem|%|pt|pc|in|cm|mm|q|ex|ch|vw|vh|vmin|vmax|lh|rlh|svw|svh|dvw|dvh|lvw|lvh|cqw|cqh)?$/i

export function isLength(token: string): boolean {
  return LENGTH_RE.test(token) || /^(calc|min|max|clamp)\(/i.test(token)
}

/** Is a token a colour (literal, function, keyword, or a `var()` we treat as one)? */
export function looksLikeColor(token: string): boolean {
  const t = token.toLowerCase()
  if (t === 'currentcolor' || t === 'transparent' || isNamedColor(t)) return true
  if (t.startsWith('#')) return true
  if (/^(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark)\(/.test(t)) return true
  return parseCssColor(token) !== null
}

const isVar = (token: string): boolean => /^var\(/i.test(token)
const widthVar = (token: string): boolean => isVar(token) && /width|size|stroke|thick/i.test(token)

/** `1px solid red` → parts (missing parts null); null when a token is not understood. */
export function parseLineShorthand(
  value: string,
  styles: ReadonlySet<string>,
): { width: string | null; style: string | null; color: string | null } | null {
  let width: string | null = null
  let style: string | null = null
  let color: string | null = null
  for (const token of splitValues(value)) {
    const lower = token.toLowerCase()
    if (style === null && styles.has(lower)) style = lower
    else if (width === null && (isLength(token) || WIDTH_KEYWORDS.has(lower) || widthVar(token)))
      width = token
    else if (color === null && (looksLikeColor(token) || isVar(token))) color = token
    else return null
  }
  return { width, style, color }
}

const BORDER_COMPONENTS = [
  ['w', 'Width'],
  ['s', 'Style'],
  ['c', 'Color'],
] as const
const SIDE_NAMES = [
  ['t', 'Top'],
  ['r', 'Right'],
  ['b', 'Bottom'],
  ['l', 'Left'],
] as const
const LOGICAL_SIDES: [string, readonly string[]][] = [
  ['Block', ['t', 'b']],
  ['Inline', ['l', 'r']],
  ['BlockStart', ['t']],
  ['BlockEnd', ['b']],
  ['InlineStart', ['l']],
  ['InlineEnd', ['r']],
]

const borderSlots: string[] = []
for (const [c] of BORDER_COMPONENTS) for (const s of SIDES) borderSlots.push(c + s)

const borderCover = (() => {
  const entries: [string, readonly string[]][] = [['border', borderSlots]]
  for (const [side, name] of SIDE_NAMES)
    entries.push([`border${name}`, BORDER_COMPONENTS.map(([c]) => c + side)])
  for (const [name, sides] of LOGICAL_SIDES)
    entries.push([`border${name}`, BORDER_COMPONENTS.flatMap(([c]) => sides.map((s) => c + s))])
  for (const [c, comp] of BORDER_COMPONENTS)
    entries.push([`border${comp}`, SIDES.map((s) => c + s)])
  for (const [name, sides] of LOGICAL_SIDES)
    for (const [c, comp] of BORDER_COMPONENTS)
      entries.push([`border${name}${comp}`, sides.map((s) => c + s)])
  for (const [side, name] of SIDE_NAMES)
    for (const [c, comp] of BORDER_COMPONENTS) entries.push([`border${name}${comp}`, [c + side]])
  return coverMap(entries)
})()

const borderFamily: Family = {
  name: 'border',
  slots: borderSlots,
  stored: [
    'border',
    ...BORDER_COMPONENTS.map(([, comp]) => `border${comp}`),
    ...SIDE_NAMES.flatMap(([, name]) =>
      BORDER_COMPONENTS.map(([, comp]) => `border${name}${comp}`),
    ),
  ],
  cover: borderCover,
  readOrder: [...borderCover.keys()],
  read(key, value, set) {
    const slots = borderCover.get(key)
    if (!slots) return 'opaque'
    // Single component keys: borderWidth / borderTopColor / borderBlockStyle…
    const comp = BORDER_COMPONENTS.find(([, name]) => key.endsWith(name))
    if (comp) {
      const sides = slots.map((s) => s.slice(1))
      if (sides.length === 4)
        return readBox(
          value,
          sides.map((s) => comp[0] + s) as [string, string, string, string],
          set,
        )
      if (sides.length === 2) return readPair(value, comp[0] + sides[0], comp[0] + sides[1], set)
      set(slots[0] as string, value)
      return 'ok'
    }
    // Shorthands: border / borderTop / borderBlock…: width style colour.
    const sides = [...new Set(slots.map((s) => s.slice(1)))]
    if (value === null) {
      for (const s of slots) set(s, null)
      return 'ok'
    }
    let parts: { width: StyleValue | null; style: string | null; color: string | null } | null
    if (typeof value === 'number')
      parts = { width: value, style: value === 0 ? 'none' : null, color: null }
    else {
      parts = parseLineShorthand(value, BORDER_STYLES)
      if (!parts) return 'opaque'
      if (
        parts.style === null &&
        parts.width !== null &&
        /^0(?:\.0*)?[a-z%]*$/i.test(String(parts.width)) &&
        parts.color === null
      ) {
        parts = { width: null, style: 'none', color: null }
      }
    }
    if (parts.style === 'none' || parts.style === 'hidden')
      parts = { ...parts, width: null, color: null }
    for (const s of sides) {
      set(`w${s}`, parts.width)
      set(`s${s}`, parts.style)
      set(`c${s}`, parts.color)
    }
    return 'ok'
  },
  emit(slots) {
    const out: [string, StyleValue][] = []
    for (const [c, comp] of BORDER_COMPONENTS) {
      const v = SIDES.map((s) => slots.get(c + s))
      if (v.every(has) && v.every((x) => sameValue(x, v[0]))) {
        out.push([`border${comp}`, v[0] as StyleValue])
        continue
      }
      SIDE_NAMES.forEach(([, name], i) => {
        const x = v[i]
        if (has(x)) out.push([`border${name}${comp}`, x])
      })
    }
    return out
  },
}

// ---------------------------------------------------------------------------
// outline
// ---------------------------------------------------------------------------

const outlineCover = coverMap([
  ['outline', ['w', 's', 'c']],
  ['outlineWidth', ['w']],
  ['outlineStyle', ['s']],
  ['outlineColor', ['c']],
])

const outlineFamily: Family = {
  name: 'outline',
  slots: ['w', 's', 'c'],
  stored: ['outline', 'outlineWidth', 'outlineStyle', 'outlineColor'],
  cover: outlineCover,
  readOrder: [...outlineCover.keys()],
  read(key, value, set) {
    if (key !== 'outline') {
      const slots = outlineCover.get(key)
      if (!slots) return 'opaque'
      set(slots[0] as string, value)
      return 'ok'
    }
    if (value === null) {
      for (const s of ['w', 's', 'c']) set(s, null)
      return 'ok'
    }
    if (typeof value === 'number') {
      set('w', value)
      set('s', value === 0 ? 'none' : null)
      set('c', null)
      return 'ok'
    }
    const parts = parseLineShorthand(value, OUTLINE_STYLES)
    if (!parts) return 'opaque'
    const none =
      parts.style === 'none' ||
      (parts.style === null && parts.width !== null && /^0[a-z%]*$/i.test(parts.width))
    set('w', none ? null : parts.width)
    set('s', none ? 'none' : parts.style)
    set('c', none ? null : parts.color)
    return 'ok'
  },
  emit(slots) {
    const out: [string, StyleValue][] = []
    for (const [slot, key] of [
      ['w', 'outlineWidth'],
      ['s', 'outlineStyle'],
      ['c', 'outlineColor'],
    ] as const) {
      const v = slots.get(slot)
      if (has(v)) out.push([key, v])
    }
    return out
  },
}

// ---------------------------------------------------------------------------
// flex
// ---------------------------------------------------------------------------

const flexCover = coverMap([
  ['flex', ['g', 's', 'b']],
  ['flexGrow', ['g']],
  ['flexShrink', ['s']],
  ['flexBasis', ['b']],
])

const NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i

/** `flex` → [grow, shrink, basis] (contract §7.6), or null when not understood. */
export function parseFlex(value: StyleValue): [StyleValue, StyleValue, StyleValue] | null {
  if (typeof value === 'number') return [value, 1, '0%']
  const t = splitValues(value)
  const lower = t.map((x) => x.toLowerCase())
  if (t.length === 1) {
    const v = lower[0] as string
    if (v === 'auto') return ['1', '1', 'auto']
    if (v === 'none') return ['0', '0', 'auto']
    if (v === 'initial') return ['0', '1', 'auto']
    if (NUMBER_RE.test(v)) return [t[0] as string, '1', '0%']
    if (isLength(v) || v === 'content' || v.startsWith('var(')) return ['1', '1', t[0] as string]
    return null
  }
  if (t.length === 2) {
    if (!NUMBER_RE.test(lower[0] as string)) return null
    if (NUMBER_RE.test(lower[1] as string)) return [t[0] as string, t[1] as string, '0%']
    return [t[0] as string, '1', t[1] as string]
  }
  if (t.length === 3 && NUMBER_RE.test(lower[0] as string) && NUMBER_RE.test(lower[1] as string)) {
    return [t[0] as string, t[1] as string, t[2] as string]
  }
  return null
}

const flexFamily: Family = {
  name: 'flex',
  slots: ['g', 's', 'b'],
  stored: ['flex', 'flexGrow', 'flexShrink', 'flexBasis'],
  cover: flexCover,
  readOrder: [...flexCover.keys()],
  read(key, value, set) {
    if (key !== 'flex') {
      const slots = flexCover.get(key)
      if (!slots) return 'opaque'
      set(slots[0] as string, value)
      return 'ok'
    }
    if (value === null) {
      for (const s of ['g', 's', 'b']) set(s, null)
      return 'ok'
    }
    const parts = parseFlex(value)
    if (!parts) return 'opaque'
    set('g', parts[0])
    set('s', parts[1])
    set('b', parts[2])
    return 'ok'
  },
  emit(slots) {
    const out: [string, StyleValue][] = []
    for (const [slot, key] of [
      ['g', 'flexGrow'],
      ['s', 'flexShrink'],
      ['b', 'flexBasis'],
    ] as const) {
      const v = slots.get(slot)
      if (has(v)) out.push([key, v])
    }
    return out
  },
}

// ---------------------------------------------------------------------------
// background
// ---------------------------------------------------------------------------

const BG_SLOTS = [
  'color',
  'image',
  'position',
  'size',
  'repeat',
  'attachment',
  'origin',
  'clip',
] as const
const BG_KEYS: Record<(typeof BG_SLOTS)[number], string> = {
  color: 'backgroundColor',
  image: 'backgroundImage',
  position: 'backgroundPosition',
  size: 'backgroundSize',
  repeat: 'backgroundRepeat',
  attachment: 'backgroundAttachment',
  origin: 'backgroundOrigin',
  clip: 'backgroundClip',
}
const backgroundCover = coverMap([
  ['background', BG_SLOTS],
  ['backgroundPositionX', ['position']],
  ['backgroundPositionY', ['position']],
  ...BG_SLOTS.map((s): [string, readonly string[]] => [BG_KEYS[s], [s]]),
])

const REPEAT = new Set(['repeat', 'repeat-x', 'repeat-y', 'no-repeat', 'space', 'round'])
const ATTACHMENT = new Set(['scroll', 'fixed', 'local'])
const BOX = new Set(['border-box', 'padding-box', 'content-box', 'text'])
const POSITION_WORDS = new Set(['left', 'right', 'top', 'bottom', 'center'])
const SIZE_WORDS = new Set(['cover', 'contain', 'auto'])

const isImageToken = (t: string): boolean =>
  /^(url|image|image-set|cross-fade|element|-webkit-cross-fade|-webkit-image-set|(repeating-)?(linear|radial|conic)-gradient|-webkit-(repeating-)?(linear|radial)-gradient)\(/i.test(
    t,
  )
const isImageVar = (t: string): boolean =>
  isVar(t) && /gradient|image|img|pattern|texture|photo/i.test(t)

/** One background layer → slots; null when a token is not understood. */
export function parseBackgroundLayer(
  value: string,
): Partial<Record<(typeof BG_SLOTS)[number], string>> | null {
  const lower = value.trim().toLowerCase()
  if (lower === 'none' || lower === 'transparent') return {}
  const out: Partial<Record<(typeof BG_SLOTS)[number], string>> = {}
  // `position / size` may be written without spaces around the slash: split it first.
  const slash = topLevelIndex(value, '/')
  let before = value
  let after = ''
  if (slash !== -1) {
    before = value.slice(0, slash)
    after = value.slice(slash + 1)
  }
  const pos: string[] = []
  const boxes: string[] = []
  const take = (token: string): boolean => {
    const l = token.toLowerCase()
    if (out.image === undefined && (isImageToken(token) || l === 'none' || isImageVar(token)))
      out.image = token
    else if (REPEAT.has(l)) out.repeat = out.repeat === undefined ? token : `${out.repeat} ${token}`
    else if (ATTACHMENT.has(l)) out.attachment = token
    else if (BOX.has(l)) boxes.push(token)
    else if (POSITION_WORDS.has(l) || isLength(token)) pos.push(token)
    else if (out.color === undefined && (looksLikeColor(token) || isVar(token))) out.color = token
    else return false
    return true
  }
  for (const token of splitValues(before)) if (!take(token)) return null
  if (after !== '') {
    const tokens = splitValues(after)
    const size: string[] = []
    let i = 0
    while (i < tokens.length && size.length < 2) {
      const t = tokens[i] as string
      if (SIZE_WORDS.has(t.toLowerCase()) || isLength(t)) {
        size.push(t)
        i++
      } else break
    }
    if (size.length === 0 || pos.length === 0) return null
    out.size = size.join(' ')
    for (; i < tokens.length; i++) if (!take(tokens[i] as string)) return null
  }
  if (pos.length > 0) out.position = pos.join(' ')
  if (boxes.length > 0) out.origin = boxes[0] as string
  if (boxes.length > 1) out.clip = boxes[1] as string
  return out
}

const backgroundFamily: Family = {
  name: 'background',
  slots: BG_SLOTS,
  stored: ['background', ...BG_SLOTS.map((b) => BG_KEYS[b])],
  cover: backgroundCover,
  readOrder: [...backgroundCover.keys()],
  read(key, value, set) {
    if (key !== 'background') {
      const slots = backgroundCover.get(key)
      if (!slots) return 'opaque'
      if (key === 'backgroundPositionX' || key === 'backgroundPositionY') return 'opaque'
      set(slots[0] as string, value)
      return 'ok'
    }
    if (value === null) {
      for (const s of BG_SLOTS) set(s, null)
      return 'ok'
    }
    if (typeof value === 'number') return 'opaque'
    if (splitTopLevel(value, ',').length > 1) return 'opaque'
    const layer = parseBackgroundLayer(value)
    if (!layer) return 'opaque'
    for (const s of BG_SLOTS) set(s, layer[s] ?? null)
    return 'ok'
  },
  emit(slots) {
    const out: [string, StyleValue][] = []
    for (const s of BG_SLOTS) {
      const v = slots.get(s)
      if (has(v)) out.push([BG_KEYS[s], v])
    }
    return out
  },
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const FAMILIES: readonly Family[] = [
  boxFamily('padding'),
  boxFamily('margin'),
  insetFamily,
  gapFamily,
  overflowFamily,
  radiusFamily,
  borderFamily,
  outlineFamily,
  flexFamily,
  backgroundFamily,
]

const BY_KEY = new Map<string, Family>()
for (const f of FAMILIES) for (const key of f.cover.keys()) BY_KEY.set(key, f)

/** The family a style key belongs to, if any. */
export function familyOf(key: string): Family | undefined {
  return BY_KEY.get(key)
}

export function newState(): FamilyState {
  return { slots: new Map(), opaque: null }
}

/** Apply one declaration to a family state (CSS cascade order). */
export function applyToState(f: Family, state: FamilyState, key: string, value: SlotValue): void {
  const pending = new Map<string, SlotValue>()
  const r = f.read(key, value, (slot, v) => pending.set(slot, v))
  const covered = f.cover.get(key) ?? f.slots
  if (r === 'opaque') {
    state.opaque = { key, value: value as StyleValue }
    for (const s of covered) state.slots.set(s, null)
    return
  }
  if (state.opaque !== null) {
    const opaqueCover = f.cover.get(state.opaque.key) ?? f.slots
    if (opaqueCover.some((s) => pending.has(s))) state.opaque = null
  }
  for (const [s, v] of pending) state.slots.set(s, v)
}

/**
 * Canonical entries for a family state: values for the canonical keys, `null` for every key
 * that covers a removed slot (or is listed in `alsoClear`) and is not emitted with a value.
 */
const STORED = new WeakMap<Family, ReadonlySet<string>>()
const EMPTY: ReadonlySet<string> = new Set()

function storedSet(f: Family): ReadonlySet<string> {
  let s = STORED.get(f)
  if (!s) {
    s = new Set(f.stored)
    STORED.set(f, s)
  }
  return s
}

export function emitState(
  f: Family,
  state: FamilyState,
  alsoClear: Iterable<string> = [],
): [string, SlotValue][] {
  const values: [string, SlotValue][] = []
  const emitted = new Set<string>()
  let opaqueCover: ReadonlySet<string> = EMPTY
  let live: ReadonlyMap<string, SlotValue> = state.slots
  if (state.opaque !== null) {
    values.push([state.opaque.key, state.opaque.value])
    emitted.add(state.opaque.key)
    opaqueCover = new Set(f.cover.get(state.opaque.key) ?? f.slots)
    const m = new Map<string, SlotValue>()
    for (const [s, v] of state.slots) if (!opaqueCover.has(s)) m.set(s, v)
    live = m
  }
  for (const [k, v] of f.emit(live)) {
    if (emitted.has(k)) continue
    values.push([k, v])
    emitted.add(k)
  }
  let nullSlots: Set<string> | null = null
  for (const [s, v] of state.slots) {
    if (v === null && !opaqueCover.has(s)) (nullSlots ??= new Set()).add(s)
  }
  const clear = alsoClear instanceof Set ? (alsoClear as Set<string>) : new Set(alsoClear)
  if (nullSlots === null && clear.size === 0) return values
  const stored = storedSet(f)
  // Removals first, so applying the entries in order (a cascade) gives the same result.
  const nulls: [string, SlotValue][] = []
  for (const [k, slots] of f.cover) {
    if (emitted.has(k)) continue
    if (
      clear.has(k) ||
      (nullSlots !== null && stored.has(k) && slots.some((s) => (nullSlots as Set<string>).has(s)))
    ) {
      nulls.push([k, null])
      emitted.add(k)
    }
  }
  return nulls.length === 0 ? values : [...nulls, ...values]
}
