import { describe, expect, test } from 'vitest'
import {
  canonicalStyles,
  clearedFamilyKeys,
  normalizeStyles,
  partitionStyles,
  resolveStyleImages,
  type HtmlWarning,
} from '../src/index.ts'
import { HASH_A, IMAGES } from './helpers.ts'

const norm = (
  input: Parameters<typeof normalizeStyles>[0],
  ctx?: Parameters<typeof normalizeStyles>[1],
) => normalizeStyles(input, ctx).styles
const codes = (ws: HtmlWarning[]): string[] => ws.map((w) => w.code)

describe('declaration parsing', () => {
  test('splits on top-level semicolons only (strings, parentheses, url())', () => {
    expect(
      norm(
        `font-family: "A;B", serif; background-image: url("data:image/png;base64,AAA"); color: red`,
      ),
    ).toEqual({
      fontFamily: '"A;B", serif',
      backgroundImage: 'url("data:image/png;base64,AAA")',
      color: 'red',
    })
  })
  test('kebab → camel, vendor prefixes, custom properties verbatim, !important stripped', () => {
    expect(
      norm(
        '-webkit-line-clamp: 2; -moz-osx-font-smoothing: grayscale; --Brand-Color: #f00; Z-INDEX: 3 !important',
      ),
    ).toEqual({
      WebkitLineClamp: '2',
      MozOsxFontSmoothing: 'grayscale',
      '--Brand-Color': '#f00',
      zIndex: '3',
    })
  })
  test('comments, empty declarations and stray colons are ignored', () => {
    expect(norm('/* c */ color: red;;; : x; width:10px /* trailing */')).toEqual({
      color: 'red',
      width: '10px',
    })
  })
  test('record input accepts kebab-case keys; null and "" remove', () => {
    // Removing a shorthand removes every stored member of its family.
    expect(norm({ 'background-color': '#fff', fontSize: 14, color: null, gap: '' })).toEqual({
      backgroundColor: '#fff',
      fontSize: 14,
      color: null,
      gap: null,
      rowGap: null,
      columnGap: null,
    })
  })
  test('multi-line values are collapsed to single spaces (no control characters stored)', () => {
    expect(norm('box-shadow: 0 1px 2px\n    rgba(0,0,0,.1),\n    0 0 0 1px #eee')).toEqual({
      boxShadow: '0 1px 2px rgba(0,0,0,.1), 0 0 0 1px #eee',
    })
  })
})

describe('values (rule 3)', () => {
  test('rem → px wherever it appears, never inside strings or urls', () => {
    expect(
      norm(
        'padding: 1.5rem; width: calc(100% - 2rem); font-family: "1rem"; background-image: url(a-1rem.png)',
      ),
    ).toEqual({
      padding: '24px',
      width: 'calc(100% - 32px)',
      fontFamily: '"1rem"',
      backgroundImage: 'url(a-1rem.png)',
    })
    expect(norm('margin-top: -0.25rem; --x-1rem: 1rem').marginTop).toBe('-4px')
    expect(norm('--x-1rem: 1rem')['--x-1rem']).toBe('1rem')
  })
  test('numbers stay numbers; numeric fontWeight strings become numbers', () => {
    expect(norm({ width: 120, opacity: 0.5, fontWeight: '600' })).toEqual({
      width: 120,
      opacity: 0.5,
      fontWeight: 600,
    })
    expect(norm('font-weight: 700')).toEqual({ fontWeight: 700 })
    expect(norm('font-weight: bold')).toEqual({ fontWeight: 'bold' })
  })
  test('rotate is normalised to (−180, 180] degrees', () => {
    expect(norm('rotate: 0.25turn')).toEqual({ rotate: '90deg' })
    expect(norm('rotate: 270deg')).toEqual({ rotate: '-90deg' })
    expect(norm({ rotate: 45 })).toEqual({ rotate: '45deg' })
    expect(norm('rotate: 0deg')).toEqual({ rotate: null })
  })
  test('unsafe values are dropped with unsafe-value', () => {
    const r = normalizeStyles(
      'width: expression(alert(1)); color: red; background: url(javascript:alert(1)); --x: url(a.png)',
    )
    expect(r.styles).toEqual({ color: 'red' })
    expect(r.warnings.map((w) => [w.code, w.property])).toEqual([
      ['unsafe-value', 'width'],
      ['unsafe-value', 'background'],
      ['unsafe-value', '--x'],
    ])
    // url() outside image properties.
    const f = normalizeStyles('filter: url(https://evil.example/x.svg#f); clip-path: url(#clip)')
    expect(f.styles).toEqual({ clipPath: 'url(#clip)' })
    expect(codes(f.warnings)).toEqual(['unsafe-value'])
  })
  test('script urls are dropped even when written with spaces or escapes', () => {
    const r = normalizeStyles(
      `background-image: url("java\\script:alert(1)"); mask-image: url(' vbscript:x')`,
      { image: () => null },
    )
    expect(r.styles).toEqual({})
    expect(codes(r.warnings)).toEqual(['unsafe-value', 'unsafe-value'])
  })
})

describe('shorthand policy (rule 4)', () => {
  const rows: [string, Record<string, unknown>][] = [
    ['padding: 8px', { padding: '8px' }],
    ['padding: 8px 16px', { paddingBlock: '8px', paddingInline: '16px' }],
    ['padding: 4px 16px 8px', { paddingTop: '4px', paddingInline: '16px', paddingBottom: '8px' }],
    [
      'padding: 1px 2px 3px 4px',
      { paddingTop: '1px', paddingRight: '2px', paddingBottom: '3px', paddingLeft: '4px' },
    ],
    ['margin: 8px 16px', { marginBlock: '8px', marginInline: '16px' }],
    ['inset: 0', { top: '0', right: '0', bottom: '0', left: '0' }],
    ['inset: 1px 2px', { top: '1px', right: '2px', bottom: '1px', left: '2px' }],
    ['gap: 12px', { gap: '12px' }],
    ['gap: 12px 24px', { rowGap: '12px', columnGap: '24px' }],
    [
      'border: 1px solid #E5E5E5',
      { borderWidth: '1px', borderStyle: 'solid', borderColor: '#E5E5E5' },
    ],
    [
      'border: solid var(--color-border) 2px',
      { borderWidth: '2px', borderStyle: 'solid', borderColor: 'var(--color-border)' },
    ],
    [
      'border-top: 1px solid red',
      { borderTopWidth: '1px', borderTopStyle: 'solid', borderTopColor: 'red' },
    ],
    [
      'border-width: 1px 2px',
      {
        borderTopWidth: '1px',
        borderRightWidth: '2px',
        borderBottomWidth: '1px',
        borderLeftWidth: '2px',
      },
    ],
    ['border-color: red', { borderColor: 'red' }],
    [
      'outline: 2px dashed blue',
      { outlineWidth: '2px', outlineStyle: 'dashed', outlineColor: 'blue' },
    ],
    ['border-radius: 8px', { borderRadius: '8px' }],
    [
      'border-radius: 8px 0',
      {
        borderTopLeftRadius: '8px',
        borderTopRightRadius: '0',
        borderBottomRightRadius: '8px',
        borderBottomLeftRadius: '0',
      },
    ],
    ['border-radius: 10px / 20px', { borderRadius: '10px / 20px' }],
    ['background: #fff', { backgroundColor: '#fff' }],
    ['background: var(--color-surface)', { backgroundColor: 'var(--color-surface)' }],
    [
      'background: linear-gradient(90deg, #000, #fff)',
      { backgroundImage: 'linear-gradient(90deg, #000, #fff)' },
    ],
    [
      'background: #000 url(a.png) center/cover no-repeat',
      {
        backgroundColor: '#000',
        backgroundImage: 'url(a.png)',
        backgroundPosition: 'center',
        backgroundSize: 'cover',
        backgroundRepeat: 'no-repeat',
      },
    ],
    [
      'background: url(a.png), linear-gradient(red, blue)',
      { background: 'url(a.png), linear-gradient(red, blue)' },
    ],
    ['flex: 1', { flexGrow: '1', flexShrink: '1', flexBasis: '0%' }],
    ['flex: 2 0', { flexGrow: '2', flexShrink: '0', flexBasis: '0%' }],
    ['flex: 0 0 240px', { flexGrow: '0', flexShrink: '0', flexBasis: '240px' }],
    ['flex: 120px', { flexGrow: '1', flexShrink: '1', flexBasis: '120px' }],
    ['flex: auto', { flexGrow: '1', flexShrink: '1', flexBasis: 'auto' }],
    ['flex: none', { flexGrow: '0', flexShrink: '0', flexBasis: 'auto' }],
    ['flex: initial', { flexGrow: '0', flexShrink: '1', flexBasis: 'auto' }],
    ['flex-flow: column wrap', { flexDirection: 'column', flexWrap: 'wrap' }],
    ['place-items: center', { alignItems: 'center', justifyItems: 'center' }],
    ['place-content: start end', { alignContent: 'start', justifyContent: 'end' }],
    ['place-self: stretch', { alignSelf: 'stretch', justifySelf: 'stretch' }],
    [
      'font: italic 600 16px/24px "Inter", sans-serif',
      {
        fontStyle: 'italic',
        fontWeight: 600,
        fontSize: '16px',
        lineHeight: '24px',
        fontFamily: '"Inter", sans-serif',
      },
    ],
    ['overflow: hidden', { overflow: 'hidden' }],
    ['overflow: hidden auto', { overflowX: 'hidden', overflowY: 'auto' }],
  ]
  test.each(rows)('%s', (input, expected) => {
    const out = norm(input)
    // Resets (null) are allowed in addition to the stored keys.
    const values = Object.fromEntries(Object.entries(out).filter(([, v]) => v !== null))
    expect(values).toEqual(expected)
  })

  test('border: none / 0 → borderStyle none, width and colour removed', () => {
    for (const input of ['border: none', 'border: 0']) {
      const out = norm(input)
      expect(out['borderStyle']).toBe('none')
      expect(out['borderWidth']).toBeNull()
      expect(out['borderColor']).toBeNull()
    }
  })
  test('background: none / transparent removes colour and image', () => {
    for (const input of ['background: none', 'background: transparent']) {
      const out = norm(input)
      expect(out['backgroundColor']).toBeNull()
      expect(out['backgroundImage']).toBeNull()
    }
  })
  test('a shorthand resets the members it does not set (CSS semantics)', () => {
    expect(norm('background: red')).toMatchObject({
      backgroundColor: 'red',
      backgroundImage: null,
      backgroundSize: null,
    })
    expect(norm('font: 12px Inter')).toMatchObject({
      fontStyle: null,
      fontWeight: null,
      lineHeight: null,
    })
  })
  test('later declarations win within one block (shorthand then longhand)', () => {
    expect(norm('padding: 10px; padding-top: 4px')).toEqual({
      paddingTop: '4px',
      paddingInline: '10px',
      paddingBottom: '10px',
    })
    expect(norm('padding-top: 4px; padding: 10px')).toEqual({ padding: '10px' })
    expect(norm('border: 1px solid red; border-left-color: blue')).toEqual({
      borderWidth: '1px',
      borderStyle: 'solid',
      borderTopColor: 'red',
      borderRightColor: 'red',
      borderBottomColor: 'red',
      borderLeftColor: 'blue',
    })
  })
  test('logical longhands (paddingBlock / paddingInline) are stored canonically', () => {
    expect(norm({ paddingBlock: '24px', paddingInline: '16px' })).toEqual({
      paddingBlock: '24px',
      paddingInline: '16px',
    })
    expect(norm({ paddingInlineStart: '4px', paddingInlineEnd: '4px' })).toEqual({
      paddingInline: '4px',
    })
  })
  test('a single inset side never clears the others', () => {
    expect(clearedFamilyKeys(norm('left: 10px'), { top: 4, left: 2 })).toEqual({
      top: 4,
      left: '10px',
    })
  })
})

describe('clearing in updates (clearedFamilyKeys)', () => {
  test('a shorthand clears its longhands', () => {
    const patch = norm('padding: 12px')
    expect(
      clearedFamilyKeys(patch, { paddingTop: '4px', paddingLeft: '2px', color: 'red' }),
    ).toEqual({
      padding: '12px',
      paddingTop: null,
      paddingLeft: null,
    })
  })
  test('a longhand splits the shorthand that contains it (the other sides keep their value)', () => {
    const patch = norm('padding-top: 4px')
    expect(clearedFamilyKeys(patch, { padding: '10px' })).toEqual({
      paddingTop: '4px',
      paddingInline: '10px',
      paddingBottom: '10px',
      padding: null,
    })
    expect(clearedFamilyKeys(norm({ borderTopLeftRadius: 0 }), { borderRadius: '8px' })).toEqual({
      borderTopLeftRadius: 0,
      borderTopRightRadius: '8px',
      borderBottomRightRadius: '8px',
      borderBottomLeftRadius: '8px',
      borderRadius: null,
    })
  })
  test('legacy stored shorthands are read (border, multi-value padding)', () => {
    expect(clearedFamilyKeys(norm('border-color: blue'), { border: '1px solid #eee' })).toEqual({
      borderWidth: '1px',
      borderStyle: 'solid',
      borderColor: 'blue',
      border: null,
    })
    expect(clearedFamilyKeys(norm('padding-left: 0'), { padding: '8px 12px' })).toEqual({
      paddingTop: '8px',
      paddingRight: '12px',
      paddingBottom: '8px',
      paddingLeft: '0',
      padding: null,
    })
  })
  test('background longhand vs stored background shorthand', () => {
    expect(
      clearedFamilyKeys(norm('background-color: red'), { background: 'url(a) center/cover, blue' }),
    ).toEqual({
      backgroundColor: 'red',
      background: null,
    })
    expect(
      clearedFamilyKeys(norm('background: blue'), {
        backgroundImage: 'url("x")',
        backgroundSize: 'cover',
      }),
    ).toMatchObject({
      backgroundColor: 'blue',
      backgroundImage: null,
      backgroundSize: null,
    })
  })
  test('removing a shorthand removes every member', () => {
    expect(
      clearedFamilyKeys({ padding: null }, { paddingBlock: '4px', paddingInline: '8px' }),
    ).toEqual({
      padding: null,
      paddingBlock: null,
      paddingInline: null,
    })
  })
  test('non-family keys pass through unchanged; idempotent on canonical input', () => {
    const patch = { color: 'red', width: 10 }
    expect(clearedFamilyKeys(patch, { color: 'blue' })).toEqual(patch)
    const canonical = { paddingBlock: '4px', paddingInline: '8px' }
    expect(clearedFamilyKeys(norm('padding: 4px 8px'), canonical)).toEqual(canonical)
  })
})

describe('property policy (rule 5)', () => {
  test('boxSizing is dropped silently', () => {
    const r = normalizeStyles('box-sizing: content-box; width: 10px')
    expect(r.styles).toEqual({ width: '10px' })
    expect(r.warnings).toEqual([])
  })
  test('unsupported properties are dropped with a warning', () => {
    const r = normalizeStyles(
      'transition: all .2s; animation: spin 1s; cursor: pointer; pointer-events: none; user-select: none; content: "x"; will-change: transform; resize: both; caret-color: red; appearance: none; scroll-margin: 4px; counter-reset: x; -webkit-transition: none',
    )
    expect(r.styles).toEqual({})
    expect(new Set(codes(r.warnings))).toEqual(new Set(['unsupported-property']))
    expect(r.warnings).toHaveLength(13)
  })
  test('list-style is dropped with list-markers-dropped', () => {
    const r = normalizeStyles('list-style: disc; list-style-type: none')
    expect(r.styles).toEqual({})
    expect(codes(r.warnings)).toEqual([
      'unsupported-property',
      'list-markers-dropped',
      'unsupported-property',
    ])
  })
  test('position fixed/sticky → absolute', () => {
    const r = normalizeStyles('position: sticky; top: 0')
    expect(r.styles).toEqual({ position: 'absolute', top: '0' })
    expect(codes(r.warnings)).toEqual(['position-converted'])
  })
  test('table display → flex (column for tables)', () => {
    expect(normalizeStyles('display: table').styles).toEqual({
      display: 'flex',
      flexDirection: 'column',
    })
    expect(normalizeStyles('display: table-row').styles).toEqual({ display: 'flex' })
    expect(normalizeStyles('display: table; flex-direction: row').styles).toEqual({
      display: 'flex',
      flexDirection: 'row',
    })
    expect(codes(normalizeStyles('display: table-cell').warnings)).toEqual(['table-as-flex'])
  })
  test('display: contents is dropped', () => {
    const r = normalizeStyles('display: contents')
    expect(r.styles).toEqual({})
    expect(codes(r.warnings)).toEqual(['unsupported-property'])
  })
  test('discouraged properties are kept with a warning', () => {
    const r = normalizeStyles(
      'margin: 8px; display: grid; grid-template-columns: 1fr 1fr; float: left; clear: both',
    )
    expect(r.styles).toEqual({
      margin: '8px',
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      float: 'left',
      clear: 'both',
    })
    expect(codes(r.warnings)).toEqual(Array(5).fill('discouraged-property'))
    expect(codes(normalizeStyles('display: inline-block').warnings)).toEqual([
      'discouraged-property',
    ])
  })
  test('unknown properties are dropped', () => {
    const r = normalizeStyles('colour: red; webkit-thing: 1; fill: red; stroke-width: 2')
    expect(r.styles).toEqual({ fill: 'red', strokeWidth: '2' })
    expect(r.warnings.map((w) => w.property)).toEqual(['colour', 'webkitThing'])
  })
  test('everything else is kept verbatim (colours, color-mix, shadows, filters)', () => {
    const css =
      'color: oklch(70% 0.1 200); background-color: color-mix(in srgb, var(--color-primary) 40%, transparent); box-shadow: 0 1px 2px #0001; filter: blur(4px); transform: translateX(4px)'
    expect(normalizeStyles(css).styles).toEqual({
      color: 'oklch(70% 0.1 200)',
      backgroundColor: 'color-mix(in srgb, var(--color-primary) 40%, transparent)',
      boxShadow: '0 1px 2px #0001',
      filter: 'blur(4px)',
      transform: 'translateX(4px)',
    })
  })
  test('system font keyword is unsupported', () => {
    expect(codes(normalizeStyles('font: menu').warnings)).toEqual(['unsupported-property'])
  })
})

describe('tokens (rule 6)', () => {
  const tokens = { '--color-primary': { type: 'color', value: '#141414' } }
  test('var() is kept; unknown tokens warn unless declared locally', () => {
    const r = normalizeStyles(
      'color: var(--color-primary); background: var(--nope, red); --local: 4px; gap: var(--local)',
      {
        tokens,
      },
    )
    expect(r.styles).toMatchObject({
      color: 'var(--color-primary)',
      backgroundColor: 'var(--nope, red)',
      gap: 'var(--local)',
    })
    expect(r.warnings.map((w) => [w.code, w.property])).toEqual([['unknown-token', 'background']])
    expect(
      normalizeStyles('gap: var(--from-ancestor)', {
        tokens,
        localVars: new Set(['--from-ancestor']),
      }).warnings,
    ).toEqual([])
  })
  test('without tokens no unknown-token warnings are produced', () => {
    expect(normalizeStyles('color: var(--x)').warnings).toEqual([])
  })
})

describe('images in values (rule 7)', () => {
  const image = (src: string) => IMAGES[src] ?? null
  test('raster url() → baren-asset url; svg / unresolved / unknown scheme dropped with warnings', () => {
    const r = normalizeStyles(
      "background-image: url('/Users/ana/brand/logo.png'); mask-image: url(/Users/ana/icon.svg); border-image-source: url(/missing.png)",
      { image },
    )
    expect(r.styles).toEqual({ backgroundImage: `url("baren-asset://${HASH_A}")` })
    expect(codes(r.warnings)).toEqual(['image-unresolved', 'image-unresolved'])
    const g = normalizeStyles('background: url(ftp://example.com/cat.png) center/cover', { image })
    expect(codes(g.warnings)).toEqual(['image-unresolved'])
    expect(Object.values(g.styles).every((v) => v === null)).toBe(true)
  })
  test('without a lookup urls are kept for the applier; resolveStyleImages rewrites them', () => {
    const patch = norm('background: #fff url("/Users/ana/brand/logo.png") center / cover no-repeat')
    expect(patch['backgroundImage']).toBe('url("/Users/ana/brand/logo.png")')
    const r = resolveStyleImages(patch, image)
    expect(r.styles['backgroundImage']).toBe(`url("baren-asset://${HASH_A}")`)
    expect(r.warnings).toEqual([])
  })
  test('existing baren-asset urls are accepted', () => {
    const v = `url(baren-asset://${HASH_A})`
    expect(resolveStyleImages({ backgroundImage: v }, () => null).styles).toEqual({
      backgroundImage: `url("baren-asset://${HASH_A}")`,
    })
  })
})

describe('partitionStyles (§7.7)', () => {
  test('pages keep only the background', () => {
    expect(
      partitionStyles(
        { backgroundColor: '#eee', width: 10 },
        { type: 'page', styles: {}, isTopLevel: false },
      ),
    ).toEqual({
      apply: { backgroundColor: '#eee' },
      ignored: ['width'],
    })
  })
  test('flex container keys on leaves; text needs display flex', () => {
    expect(
      partitionStyles({ gap: '4px', opacity: 1 }, { type: 'image', styles: {}, isTopLevel: false })
        .ignored,
    ).toEqual(['gap'])
    expect(
      partitionStyles({ alignItems: 'center' }, { type: 'text', styles: {}, isTopLevel: false })
        .ignored,
    ).toEqual(['alignItems'])
    expect(
      partitionStyles(
        { alignItems: 'center', display: 'flex' },
        { type: 'text', styles: {}, isTopLevel: false },
      ).ignored,
    ).toEqual([])
    expect(
      partitionStyles({ gap: '4px' }, { type: 'frame', styles: {}, isTopLevel: false }).ignored,
    ).toEqual([])
  })
  test('offsets need a position unless the node is top-level', () => {
    expect(
      partitionStyles({ left: 4 }, { type: 'frame', styles: {}, isTopLevel: false }).ignored,
    ).toEqual(['left'])
    expect(
      partitionStyles({ left: 4 }, { type: 'frame', styles: {}, isTopLevel: true }).ignored,
    ).toEqual([])
    expect(
      partitionStyles(
        { left: 4, position: 'absolute' },
        { type: 'frame', styles: {}, isTopLevel: false },
      ).ignored,
    ).toEqual([])
    expect(
      partitionStyles(
        { top: 4 },
        { type: 'frame', styles: { position: 'relative' }, isTopLevel: false },
      ).ignored,
    ).toEqual([])
    expect(
      partitionStyles(
        { top: 4, position: null },
        { type: 'frame', styles: { position: 'absolute' }, isTopLevel: false },
      ).ignored,
    ).toEqual(['top'])
  })
  test('objectFit only on images; typography not on rect/image/vector', () => {
    expect(
      partitionStyles({ objectFit: 'cover' }, { type: 'frame', styles: {}, isTopLevel: false })
        .ignored,
    ).toEqual(['objectFit'])
    expect(
      partitionStyles({ objectFit: 'cover' }, { type: 'image', styles: {}, isTopLevel: false })
        .ignored,
    ).toEqual([])
    expect(
      partitionStyles(
        { fontSize: '12px', textDecorationLine: 'underline' },
        { type: 'rect', styles: {}, isTopLevel: false },
      ).ignored,
    ).toEqual(['fontSize', 'textDecorationLine'])
    expect(
      partitionStyles({ fontSize: '12px' }, { type: 'frame', styles: {}, isTopLevel: false })
        .ignored,
    ).toEqual([])
  })
  test('removals are never reported as ignored', () => {
    expect(
      partitionStyles({ gap: null }, { type: 'image', styles: { gap: '4px' }, isTopLevel: false }),
    ).toEqual({
      apply: { gap: null },
      ignored: [],
    })
  })
})

describe('canonicalStyles (§8.2)', () => {
  test('px numbers, fontWeight, hidden paints, text white-space, sorted keys', () => {
    const out = canonicalStyles({
      type: 'text',
      styles: {
        width: 12,
        opacity: 0.5,
        fontWeight: '600',
        '--hidden-backgroundColor': 'red',
        rotate: 15,
        Zoo: 'x',
        alpha: 'y',
      },
    })
    expect(out).toEqual({
      alpha: 'y',
      fontWeight: 600,
      opacity: 0.5,
      rotate: '15deg',
      whiteSpace: 'pre-wrap',
      width: '12px',
      Zoo: 'x',
    })
    expect(Object.keys(out)).toEqual([
      'alpha',
      'fontWeight',
      'opacity',
      'rotate',
      'whiteSpace',
      'width',
      'Zoo',
    ])
  })
  test('shorthands and tokens stay as stored; frames get no white-space', () => {
    expect(
      canonicalStyles({ type: 'frame', styles: { border: '1px solid var(--c)', padding: 4 } }),
    ).toEqual({
      border: '1px solid var(--c)',
      padding: '4px',
    })
  })
})
