/**
 * CSS colour parsing for equivalence checks (find_nodes, Tailwind token matching): hex,
 * rgb()/rgba(), hsl()/hsla(), hwb(), lab()/lch(), oklab()/oklch(), color(srgb …) and the
 * named colours. Results are sRGB bytes (rounded, clamped) and alpha in [0, 1].
 */

export interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

const NAMED_SOURCE = `
aliceblue f0f8ff antiquewhite faebd7 aqua 00ffff aquamarine 7fffd4 azure f0ffff beige f5f5dc
bisque ffe4c4 black 000000 blanchedalmond ffebcd blue 0000ff blueviolet 8a2be2 brown a52a2a
burlywood deb887 cadetblue 5f9ea0 chartreuse 7fff00 chocolate d2691e coral ff7f50
cornflowerblue 6495ed cornsilk fff8dc crimson dc143c cyan 00ffff darkblue 00008b darkcyan 008b8b
darkgoldenrod b8860b darkgray a9a9a9 darkgreen 006400 darkgrey a9a9a9 darkkhaki bdb76b
darkmagenta 8b008b darkolivegreen 556b2f darkorange ff8c00 darkorchid 9932cc darkred 8b0000
darksalmon e9967a darkseagreen 8fbc8f darkslateblue 483d8b darkslategray 2f4f4f darkslategrey
2f4f4f darkturquoise 00ced1 darkviolet 9400d3 deeppink ff1493 deepskyblue 00bfff dimgray 696969
dimgrey 696969 dodgerblue 1e90ff firebrick b22222 floralwhite fffaf0 forestgreen 228b22 fuchsia
ff00ff gainsboro dcdcdc ghostwhite f8f8ff gold ffd700 goldenrod daa520 gray 808080 green 008000
greenyellow adff2f grey 808080 honeydew f0fff0 hotpink ff69b4 indianred cd5c5c indigo 4b0082
ivory fffff0 khaki f0e68c lavender e6e6fa lavenderblush fff0f5 lawngreen 7cfc00 lemonchiffon
fffacd lightblue add8e6 lightcoral f08080 lightcyan e0ffff lightgoldenrodyellow fafad2 lightgray
d3d3d3 lightgreen 90ee90 lightgrey d3d3d3 lightpink ffb6c1 lightsalmon ffa07a lightseagreen
20b2aa lightskyblue 87cefa lightslategray 778899 lightslategrey 778899 lightsteelblue b0c4de
lightyellow ffffe0 lime 00ff00 limegreen 32cd32 linen faf0e6 magenta ff00ff maroon 800000
mediumaquamarine 66cdaa mediumblue 0000cd mediumorchid ba55d3 mediumpurple 9370db
mediumseagreen 3cb371 mediumslateblue 7b68ee mediumspringgreen 00fa9a mediumturquoise 48d1cc
mediumvioletred c71585 midnightblue 191970 mintcream f5fffa mistyrose ffe4e1 moccasin ffe4b5
navajowhite ffdead navy 000080 oldlace fdf5e6 olive 808000 olivedrab 6b8e23 orange ffa500
orangered ff4500 orchid da70d6 palegoldenrod eee8aa palegreen 98fb98 paleturquoise afeeee
palevioletred db7093 papayawhip ffefd5 peachpuff ffdab9 peru cd853f pink ffc0cb plum dda0dd
powderblue b0e0e6 purple 800080 rebeccapurple 663399 red ff0000 rosybrown bc8f8f royalblue
4169e1 saddlebrown 8b4513 salmon fa8072 sandybrown f4a460 seagreen 2e8b57 seashell fff5ee sienna
a0522d silver c0c0c0 skyblue 87ceeb slateblue 6a5acd slategray 708090 slategrey 708090 snow
fffafa springgreen 00ff7f steelblue 4682b4 tan d2b48c teal 008080 thistle d8bfd8 tomato ff6347
turquoise 40e0d0 violet ee82ee wheat f5deb3 white ffffff whitesmoke f5f5f5 yellow ffff00
yellowgreen 9acd32
`

const NAMED: ReadonlyMap<string, string> = (() => {
  const parts = NAMED_SOURCE.trim().split(/\s+/)
  const map = new Map<string, string>()
  for (let i = 0; i + 1 < parts.length; i += 2) map.set(parts[i] as string, parts[i + 1] as string)
  return map
})()

/** True for a CSS named colour (or `transparent`). */
export function isNamedColor(value: string): boolean {
  const v = value.toLowerCase()
  return v === 'transparent' || NAMED.has(v)
}

const clamp255 = (n: number): number => Math.min(255, Math.max(0, Math.round(n)))
const clamp01 = (n: number): number => Math.min(1, Math.max(0, n))

function fromHex(hex: string): Rgba | null {
  if (!/^[0-9a-f]+$/i.test(hex)) return null
  const x = (s: string): number => parseInt(s, 16)
  switch (hex.length) {
    case 3:
    case 4: {
      const [r, g, b, a] = [...hex].map((c) => x(c + c))
      return {
        r: r as number,
        g: g as number,
        b: b as number,
        a: a === undefined ? 1 : round3(a / 255),
      }
    }
    case 6:
    case 8:
      return {
        r: x(hex.slice(0, 2)),
        g: x(hex.slice(2, 4)),
        b: x(hex.slice(4, 6)),
        a: hex.length === 8 ? round3(x(hex.slice(6, 8)) / 255) : 1,
      }
    default:
      return null
  }
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000

/** A number or percentage (`ref` = the value 100% maps to); `none` = 0. */
function num(token: string | undefined, ref: number): number | null {
  if (token === undefined) return null
  const t = token.trim().toLowerCase()
  if (t === 'none') return 0
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(%)?$/.exec(t)
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isFinite(n)) return null
  return m[2] ? (n / 100) * ref : n
}

function hue(token: string | undefined): number | null {
  if (token === undefined) return null
  const t = token.trim().toLowerCase()
  if (t === 'none') return 0
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(deg|turn|rad|grad)?$/.exec(t)
  if (!m) return null
  const n = Number(m[1])
  switch (m[2]) {
    case 'turn':
      return n * 360
    case 'rad':
      return (n * 180) / Math.PI
    case 'grad':
      return n * 0.9
    default:
      return n
  }
}

/** Function arguments: comma or space separated, optional `/ alpha`. */
function args(body: string): { parts: string[]; alpha: string | undefined } | null {
  let main = body.trim()
  let alpha: string | undefined
  const slash = main.indexOf('/')
  if (slash !== -1) {
    alpha = main.slice(slash + 1).trim()
    main = main.slice(0, slash).trim()
  }
  const parts = main.includes(',')
    ? main.split(',').map((s) => s.trim())
    : main.split(/\s+/).filter((s) => s !== '')
  if (main.includes(',') && parts.length === 4 && alpha === undefined) alpha = parts.pop()
  return { parts, alpha }
}

function alphaOf(token: string | undefined): number | null {
  if (token === undefined) return 1
  const a = num(token, 1)
  return a === null ? null : round3(clamp01(a))
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hh = (((h % 360) + 360) % 360) / 360
  const f = (n: number): number => {
    const k = (n + hh * 12) % 12
    const a = s * Math.min(l, 1 - l)
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
  }
  return [f(0) * 255, f(8) * 255, f(4) * 255]
}

function linearToSrgb(c: number): number {
  const v =
    c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(Math.abs(c), 1 / 2.4) * Math.sign(c) - 0.055
  return v * 255
}

function oklabToRgb(L: number, a: number, b: number): [number, number, number] {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.291485548 * b
  const l = l_ ** 3
  const m = m_ ** 3
  const s = s_ ** 3
  return [
    linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ]
}

function labToRgb(L: number, a: number, b: number): [number, number, number] {
  // CIE Lab (D50) → XYZ D50 → XYZ D65 (Bradford) → linear sRGB.
  const fy = (L + 16) / 116
  const fx = fy + a / 500
  const fz = fy - b / 200
  const e = 216 / 24389
  const k = 24389 / 27
  const xr = fx ** 3 > e ? fx ** 3 : (116 * fx - 16) / k
  const yr = L > k * e ? fy ** 3 : L / k
  const zr = fz ** 3 > e ? fz ** 3 : (116 * fz - 16) / k
  const X = (xr * 0.3457) / 0.3585
  const Y = yr
  const Z = (zr * (1 - 0.3457 - 0.3585)) / 0.3585
  const x65 = 0.9554734527042182 * X - 0.023098536874261423 * Y + 0.0632593086610217 * Z
  const y65 = -0.028369706963208136 * X + 1.0099954580058226 * Y + 0.021041398966943008 * Z
  const z65 = 0.012314001688319899 * X - 0.020507696433477912 * Y + 1.3303659366080753 * Z
  return [
    linearToSrgb(3.2409699419045226 * x65 - 1.537383177570094 * y65 - 0.4986107602930034 * z65),
    linearToSrgb(-0.9692436362808796 * x65 + 1.8759675015077202 * y65 + 0.04155505740717559 * z65),
    linearToSrgb(0.05563007969699366 * x65 - 0.20397695888897652 * y65 + 1.0569715142428786 * z65),
  ]
}

function finish(rgb: [number, number, number], a: number): Rgba {
  return { r: clamp255(rgb[0]), g: clamp255(rgb[1]), b: clamp255(rgb[2]), a }
}

/** Parse a CSS colour; null for anything else (`var()`, `currentColor`, `color-mix()`…). */
export function parseCssColor(value: string): Rgba | null {
  const v = value.trim().toLowerCase()
  if (v === '') return null
  if (v.startsWith('#')) return fromHex(v.slice(1))
  if (v === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }
  const named = NAMED.get(v)
  if (named) return fromHex(named)
  const m = /^([a-z]+)\(([^()]*)\)$/.exec(v)
  if (!m) return null
  const fn = m[1] as string
  const parsed = args(m[2] as string)
  if (!parsed) return null
  const { parts, alpha } = parsed
  const a = alphaOf(alpha)
  if (a === null || parts.length !== 3) return null
  switch (fn) {
    case 'rgb':
    case 'rgba': {
      const r = num(parts[0], 255)
      const g = num(parts[1], 255)
      const b = num(parts[2], 255)
      return r === null || g === null || b === null ? null : finish([r, g, b], a)
    }
    case 'hsl':
    case 'hsla': {
      const h = hue(parts[0])
      const s = num(parts[1], 100)
      const l = num(parts[2], 100)
      if (h === null || s === null || l === null) return null
      return finish(hslToRgb(h, clamp01(s / 100), clamp01(l / 100)), a)
    }
    case 'hwb': {
      const h = hue(parts[0])
      let w = num(parts[1], 100)
      let bl = num(parts[2], 100)
      if (h === null || w === null || bl === null) return null
      w /= 100
      bl /= 100
      if (w + bl >= 1) {
        const gray = (w / (w + bl)) * 255
        return finish([gray, gray, gray], a)
      }
      const rgb = hslToRgb(h, 1, 0.5).map((c) => (c / 255) * (1 - w - bl) + w) as number[]
      return finish(
        [(rgb[0] as number) * 255, (rgb[1] as number) * 255, (rgb[2] as number) * 255],
        a,
      )
    }
    case 'oklab': {
      const L = num(parts[0], 1)
      const A = num(parts[1], 0.4)
      const B = num(parts[2], 0.4)
      return L === null || A === null || B === null ? null : finish(oklabToRgb(L, A, B), a)
    }
    case 'oklch': {
      const L = num(parts[0], 1)
      const C = num(parts[1], 0.4)
      const H = hue(parts[2])
      if (L === null || C === null || H === null) return null
      const rad = (H * Math.PI) / 180
      return finish(oklabToRgb(L, C * Math.cos(rad), C * Math.sin(rad)), a)
    }
    case 'lab': {
      const L = num(parts[0], 100)
      const A = num(parts[1], 125)
      const B = num(parts[2], 125)
      return L === null || A === null || B === null ? null : finish(labToRgb(L, A, B), a)
    }
    case 'lch': {
      const L = num(parts[0], 100)
      const C = num(parts[1], 150)
      const H = hue(parts[2])
      if (L === null || C === null || H === null) return null
      const rad = (H * Math.PI) / 180
      return finish(labToRgb(L, C * Math.cos(rad), C * Math.sin(rad)), a)
    }
    default:
      return null
  }
}

/** Parse `color(srgb r g b / a)` as well (used by `parseCssColor` callers via `colorsEqual`). */
function parseColorFunction(value: string): Rgba | null {
  const m = /^color\(\s*(srgb|srgb-linear)\s+([^()]*)\)$/i.exec(value.trim())
  if (!m) return null
  const parsed = args(m[2] as string)
  if (!parsed || parsed.parts.length !== 3) return null
  const a = alphaOf(parsed.alpha)
  const c = parsed.parts.map((p) => num(p, 1))
  if (a === null || c.some((x) => x === null)) return null
  const [r, g, b] = c as number[]
  if ((m[1] as string).toLowerCase() === 'srgb-linear') {
    return finish(
      [linearToSrgb(r as number), linearToSrgb(g as number), linearToSrgb(b as number)],
      a,
    )
  }
  return finish([(r as number) * 255, (g as number) * 255, (b as number) * 255], a)
}

/** Any supported colour syntax, including `color(srgb …)`. */
export function parseAnyColor(value: string): Rgba | null {
  return parseCssColor(value) ?? parseColorFunction(value)
}

/** True when both values are colours that render the same (alpha within 1/255). */
export function colorsEqual(a: string, b: string): boolean {
  const x = parseAnyColor(a)
  const y = parseAnyColor(b)
  if (!x || !y) return false
  if (x.a === 0 && y.a === 0) return true
  return x.r === y.r && x.g === y.g && x.b === y.b && Math.abs(x.a - y.a) < 1 / 255 + 1e-9
}

/** A canonical key for colour lookups (`#rrggbbaa`), or null. */
export function colorKey(value: string): string | null {
  const c = parseAnyColor(value)
  if (!c) return null
  if (c.a === 0) return 'transparent'
  const h = (n: number): string => n.toString(16).padStart(2, '0')
  return `#${h(c.r)}${h(c.g)}${h(c.b)}${h(Math.round(c.a * 255))}`
}
