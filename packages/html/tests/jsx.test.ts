import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import {
  createComponent,
  createInstance,
  createNode,
  docGeometry,
  getNode,
  setTokens,
  type ResolvedNode,
  type Token,
} from '@baren/schema'
import { renderStage, toJsx, type JsxOptions } from '../src/index.ts'
import { HASH_A, resolved, seeded, setup } from './helpers.ts'
import { TOKENS, fixtureNames, readFixture, runFixture } from './corpus.ts'

const UPDATE = process.env['UPDATE_GOLDEN'] === '1'
const GOLDEN = new URL('./fixtures/jsx/', import.meta.url)

/** A file's tokens as get_tokens returns them (all typed `other`). */
const SAMPLE_TOKENS: Record<string, Token> = Object.fromEntries(
  `--color-background: #FFFFFF; --color-surface: #F7F7F7; --color-canvas: #EEEEEE; --color-muted: #EBEBEB;
  --color-input: #F3F3F3; --color-border: #E5E5E5; --color-foreground: #1A1A1A; --color-foreground-muted: #666666;
  --color-foreground-subtle: #999999; --color-primary: #141414; --color-primary-foreground: #FFFFFF;
  --color-selection: #2F80FF; --color-avatar: #F04E1E; --font-sans: Inter; --font-mono: JetBrains Mono;
  --text-xs: 11px; --text-sm: 12px; --text-base: 13px; --text-md: 14px; --text-xl: 22px; --text-2xl: 24px;
  --font-weight-regular: 400; --font-weight-medium: 500; --font-weight-semibold: 600;
  --tracking-display: -0.02em; --tracking-tight: -0.01em; --tracking-normal: 0em; --leading-sm: 16px;
  --leading-base: 20px; --leading-xl: 28px; --opacity-muted: 60%; --breakpoint-desktop: 1440px;
  --container-sidebar: 240px; --container-inspector: 264px; --container-content: 1040px; --spacing-1: 4px;
  --spacing-2: 8px; --spacing-3: 12px; --spacing-4: 16px; --spacing-6: 24px; --spacing-8: 32px;
  --spacing-12: 48px; --radius-sm: 4px; --radius-md: 6px; --radius-lg: 8px; --radius-xl: 12px;
  --radius-full: 9999px`
    .split(';')
    .map((d) => d.trim().split(/:\s*/) as [string, string])
    .map(([name, value]) => [name, { type: 'other', value }]),
)

/** A "Code block" frame with its two text layers, styles as get_computed_styles reports them. */
function codeBlock(): Record<string, ResolvedNode> {
  const base = { parentId: 'board', children: [] as string[] }
  return {
    block: {
      ...base,
      id: 'block',
      type: 'frame',
      name: 'Code block (td · #F3F3F3)',
      children: ['code', 'expiry'],
      styles: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        paddingBlock: '24px',
        paddingInline: '16px',
        borderRadius: '8px',
        gap: '8px',
        backgroundColor: '#F3F3F3',
      },
    },
    code: {
      ...base,
      id: 'code',
      parentId: 'block',
      type: 'text',
      name: 'Code',
      text: '482 719',
      styles: {
        fontSize: '34px',
        lineHeight: '40px',
        letterSpacing: '0.14em',
        paddingLeft: '0.14em',
        fontFamily: '"JetBrains Mono", system-ui, sans-serif',
        fontWeight: 600,
        color: '#141414',
      },
    },
    expiry: {
      ...base,
      id: 'expiry',
      parentId: 'block',
      type: 'text',
      name: 'Expiry',
      text: 'Expires in 10 minutes',
      styles: {
        color: '#8A8A8A',
        fontFamily: '"Inter", system-ui, sans-serif',
        fontSize: '13px',
        lineHeight: '18px',
      },
    },
  }
}

describe('get_jsx of a code block', () => {
  test('tailwind: token utilities in a fixed order (no renderer-only classes)', () => {
    const out = toJsx(codeBlock(), 'block', { format: 'tailwind', tokens: SAMPLE_TOKENS })
    const lines = out.split('\n')
    expect(lines[0]).toBe('(')
    expect(lines[1]).toBe(
      '    <div className="flex flex-col items-center py-6 px-4 rounded-lg gap-2 bg-input">',
    )
    expect(out).toContain(
      `<div className="text-base leading-[18px] font-['Inter',system-ui,sans-serif] text-[#8A8A8A]">`,
    )
    // Classes follow the fixed category order (padding first), not the stored key order.
    const code = /<div className="([^"]*)">\n {8}482 719/.exec(out)?.[1]
    expect(code?.split(' ').sort()).toEqual(
      "text-[34px] leading-[40px] tracking-[0.14em] pl-[0.14em] font-['JetBrains_Mono',system-ui,sans-serif] font-semibold text-primary"
        .split(' ')
        .sort(),
    )
    expect(code).toBe(
      "pl-[0.14em] text-[34px] leading-[40px] tracking-[0.14em] font-['JetBrains_Mono',system-ui,sans-serif] font-semibold text-primary",
    )
    expect(lines.at(-1)).toBe('  )')
  })
  test('inline-styles: the root line has sorted keys and box-sizing', () => {
    const out = toJsx(codeBlock(), 'block', { format: 'inline-styles', tokens: SAMPLE_TOKENS })
    expect(out.split('\n')[1]).toBe(
      "    <div style={{ alignItems: 'center', backgroundColor: '#F3F3F3', borderRadius: '8px', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: '8px', paddingBlock: '24px', paddingInline: '16px' }}>",
    )
    expect(out).toContain(
      `fontFamily: '"JetBrains Mono", system-ui, sans-serif', fontSize: '34px', fontWeight: 600`,
    )
  })
  test('ambiguous literal colours become arbitrary properties ([color:#FFFFFF])', () => {
    const nodes: Record<string, ResolvedNode> = {
      r: {
        id: 'r',
        parentId: 'x',
        children: [],
        type: 'text',
        name: 'io',
        text: 'io',
        styles: { color: '#FFFFFF', backgroundColor: '#F7F7F7' },
      },
    }
    expect(toJsx(nodes, 'r', { format: 'tailwind', tokens: SAMPLE_TOKENS })).toContain(
      'className="bg-surface [color:#FFFFFF]"',
    )
  })
  test('font size + line height tokens combine (text-base/sm, text-sm/sm)', () => {
    const nodes: Record<string, ResolvedNode> = {
      r: {
        id: 'r',
        parentId: 'x',
        children: [],
        type: 'text',
        name: 'Pages',
        text: 'Pages',
        styles: {
          fontSize: 'var(--text-base)',
          lineHeight: '16px',
          fontWeight: 'var(--font-weight-medium)',
          fontFamily: 'var(--font-sans)',
          color: 'var(--color-foreground)',
          flexGrow: '1',
          flexBasis: '0%',
        },
      },
    }
    expect(toJsx(nodes, 'r', { format: 'tailwind', tokens: SAMPLE_TOKENS })).toContain(
      'className="grow basis-[0%] text-base/sm font-sans font-medium text-foreground"',
    )
  })
})

describe('toJsx rules', () => {
  const tw = (nodes: Record<string, ResolvedNode>, id: string, extra: Partial<JsxOptions> = {}) =>
    toJsx(nodes, id, { format: 'tailwind', tokens: SAMPLE_TOKENS, ...extra })
  const inline = (
    nodes: Record<string, ResolvedNode>,
    id: string,
    extra: Partial<JsxOptions> = {},
  ) => toJsx(nodes, id, { format: 'inline-styles', tokens: SAMPLE_TOKENS, ...extra })

  test('deterministic: shuffled style keys and token order give identical output', () => {
    const a = codeBlock()
    const b = codeBlock()
    for (const n of Object.values(b))
      n.styles = Object.fromEntries(Object.entries(n.styles).reverse())
    const shuffledTokens = Object.fromEntries(Object.entries(SAMPLE_TOKENS).reverse())
    for (const format of ['tailwind', 'inline-styles'] as const) {
      expect(toJsx(a, 'block', { format, tokens: SAMPLE_TOKENS })).toBe(
        toJsx(b, 'block', { format, tokens: shuffledTokens }),
      )
    }
  })
  test('root carries inherited text properties it does not set (only those)', () => {
    const nodes = codeBlock()
    const inherited = {
      fontSize: '12px',
      lineHeight: '16px',
      color: '#000',
      padding: '4px',
      backgroundColor: '#F3F3F3',
    }
    const out = inline(nodes, 'block', { inherited })
    expect(out.split('\n')[1]).toContain("color: '#000'")
    expect(out.split('\n')[1]).toContain("fontSize: '12px'")
    expect(out.split('\n')[1]).not.toContain("padding: '4px'")
    expect(tw(nodes, 'block', { inherited }).split('\n')[1]).toContain('text-sm/sm')
    // A child never gets them.
    expect(out.split('\n')[2]).not.toContain("color: '#000'")
  })
  test('text escaping: braces, angle brackets, entities, edge spaces, newlines', () => {
    const nodes: Record<string, ResolvedNode> = {
      t: {
        id: 't',
        parentId: 'x',
        children: [],
        type: 'text',
        name: 't',
        styles: {},
        text: "  if (a < b) { x } &amp; it's\n  indented ",
      },
    }
    const out = tw(nodes, 't')
    expect(out).toContain(
      "{'  '}if (a {'<'} b) {'{'} x {'}'} {'&'}amp; it's<br />{'  '}indented{' '}",
    )
  })
  test('images, hidden nodes, includeIds, assetUrl', () => {
    const nodes: Record<string, ResolvedNode> = {
      f: {
        id: 'f',
        parentId: 'x',
        children: ['i', 'h', 'e'],
        type: 'frame',
        name: 'F',
        styles: { display: 'flex' },
      },
      i: {
        id: 'i',
        parentId: 'f',
        children: [],
        type: 'image',
        name: 'Photo "1"',
        assetId: HASH_A,
        styles: { width: 40, height: 40, objectFit: 'cover' },
      },
      h: {
        id: 'h',
        parentId: 'f',
        children: [],
        type: 'rect',
        name: 'hidden',
        hidden: true,
        styles: { width: 4 },
      },
      e: {
        id: 'e',
        parentId: 'f',
        children: [],
        type: 'rect',
        name: 'r',
        styles: { width: '4px', height: '4px', backgroundColor: 'var(--color-avatar)' },
      },
    }
    const out = tw(nodes, 'f', {
      includeIds: true,
      assetUrl: (h) => `https://cdn.example/${h}.png`,
    })
    expect(out).toBe(
      [
        '(',
        '    <div data-node-id="f" className="flex">',
        `      <img src="https://cdn.example/${HASH_A}.png" alt={'Photo "1"'} data-node-id="i" className="w-10 h-10 object-cover" />`,
        '      <div data-node-id="e" className="w-1 h-1 bg-avatar" />',
        '    </div>',
        '  )',
      ].join('\n'),
    )
  })
  test('svg markup → JSX (camelCase attributes, nested elements, style objects)', () => {
    const nodes: Record<string, ResolvedNode> = {
      s: {
        id: 's',
        parentId: 'x',
        children: [],
        type: 'svg',
        name: 'Icon',
        styles: { width: '16px', height: '16px', flexShrink: '0' },
        svg: '<svg viewBox="0 0 24 24" fill="none" stroke="var(--color-foreground-muted)" stroke-width="2" stroke-linecap="round" class="ic"><g style="opacity: 0.5"><path d="M5 12h14"/></g><text x="1">a&lt;b</text></svg>',
      },
    }
    expect(tw(nodes, 's')).toBe(
      [
        '(',
        '    <svg viewBox="0 0 24 24" fill="none" stroke="var(--color-foreground-muted)" strokeWidth="2" strokeLinecap="round" className="ic" className="w-4 h-4 shrink-0">',
        "      <g style={{ opacity: '0.5' }}>",
        '        <path d="M5 12h14" />',
        '      </g>',
        '      <text x="1">a{\'<\'}b</text>',
        '    </svg>',
        '  )',
      ].join('\n'),
    )
  })
  test('vectors: one path with paints resolved, overflow visible', () => {
    const { doc, pageId } = setup()
    setTokens(doc, { '--color-primary': { type: 'color', value: '#141414' } })
    const v = createNode(doc, {
      type: 'vector',
      parentId: pageId,
      name: 'Pen',
      styles: {
        left: 0,
        top: 0,
        width: 10,
        height: 10,
        stroke: 'var(--color-primary)',
        strokeWidth: 2,
        fill: 'none',
      },
      vector: {
        fillRule: 'nonzero',
        subpaths: [
          {
            id: 'a',
            closed: false,
            points: [
              { x: 0, y: 0 },
              { x: 10, y: 10 },
            ],
          },
        ],
      },
    })
    const out = toJsx(resolved(doc, v), v, {
      format: 'inline-styles',
      tokens: { '--color-primary': { type: 'color', value: '#141414' } },
    })
    expect(out).toContain(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10" overflow="visible"',
    )
    expect(out).toContain(
      '<path d="M 0 0 L 10 10" fillRule="nonzero" fill="none" stroke="#141414" strokeWidth="2" />',
    )
    expect(out).not.toContain("stroke: '")
    // Top-level root: no left/top/position.
    expect(out).not.toContain('left:')
  })
  test('groups get position: relative; instances are expanded', () => {
    const { doc, pageId } = setup()
    const board = createNode(doc, {
      type: 'frame',
      parentId: pageId,
      styles: { left: 0, top: 0, width: 200, height: 200 },
    })
    const card = createNode(doc, {
      type: 'frame',
      parentId: board,
      name: 'Card',
      styles: { display: 'flex', padding: '8px' },
    })
    createNode(doc, { type: 'text', parentId: card, text: 'Inside' })
    const main = createComponent(doc, [card], docGeometry(doc), { random: seeded(2) }) as string
    const key = getNode(doc, main)?.componentKey as string
    const inst = createInstance(
      doc,
      { componentKey: key, parentId: board, styles: { width: '120px' } },
      { random: seeded(3) },
    )
    const out = toJsx(resolved(doc, inst), inst, { format: 'inline-styles', tokens: {} })
    expect(out).toContain('Inside')
    expect(out).toContain("width: '120px'")
    const grp: Record<string, ResolvedNode> = {
      g: {
        id: 'g',
        parentId: 'x',
        children: ['c'],
        type: 'group',
        name: 'G',
        styles: { width: 10, height: 10 },
      },
      c: {
        id: 'c',
        parentId: 'g',
        children: [],
        type: 'rect',
        name: 'c',
        styles: { position: 'absolute', left: 0, top: 0, width: 10, height: 10 },
      },
    }
    expect(inline(grp, 'g').split('\n')[1]).toContain("position: 'relative'")
  })
  test('top-level detection and the explicit option', () => {
    const nodes: Record<string, ResolvedNode> = {
      a: {
        id: 'a',
        parentId: 'page',
        children: [],
        type: 'frame',
        name: 'A',
        styles: { left: 100, top: 50, width: 10, height: 10 },
      },
      b: {
        id: 'b',
        parentId: 'f',
        children: [],
        type: 'frame',
        name: 'B',
        styles: { position: 'absolute', left: 4, top: 4 },
      },
    }
    expect(inline(nodes, 'a')).not.toContain('left')
    expect(inline(nodes, 'b')).toContain("left: '4px'")
    expect(inline(nodes, 'b', { topLevel: true })).not.toContain('left')
  })
  test('pages are refused', () => {
    const nodes: Record<string, ResolvedNode> = {
      p: { id: 'p', parentId: null, children: [], type: 'page', name: 'P', styles: {} },
    }
    expect(() => tw(nodes, 'p')).toThrow(/pages/)
    expect(() => tw(nodes, 'nope')).toThrow()
  })
})

describe('tailwind mapping details', () => {
  const classes = (
    styles: Record<string, string | number>,
    tokens: Record<string, Token> = SAMPLE_TOKENS,
    type: ResolvedNode['type'] = 'frame',
  ) =>
    /className="([^"]*)"/.exec(
      toJsx(
        {
          n: {
            id: 'n',
            parentId: 'x',
            children: [],
            type,
            name: 'n',
            styles,
            ...(type === 'text' ? { text: 'x' } : {}),
          },
        },
        'n',
        {
          format: 'tailwind',
          tokens,
        },
      ),
    )?.[1] ?? ''
  test.each([
    [
      {
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
      },
      'flex flex-col items-start justify-between',
    ],
    [{ gap: '40px' }, 'gap-10'],
    [{ gap: '10px' }, 'gap-[10px]'],
    [{ padding: '1px' }, 'p-px'],
    [{ paddingTop: 0 }, 'pt-0'],
    [{ left: '-8px', position: 'absolute' }, 'absolute -left-2'],
    [{ top: '50%', position: 'absolute' }, 'absolute top-1/2'],
    [{ width: '100%', height: 'fit-content', maxWidth: '1040px' }, 'w-full h-fit max-w-content'],
    [{ minWidth: '0px' }, 'min-w-0'],
    [{ width: '240px' }, 'w-sidebar'],
    [{ borderRadius: '9999px' }, 'rounded-full'],
    [{ borderRadius: '10px / 4px' }, '[border-radius:10px_/_4px]'],
    [
      { borderTopLeftRadius: '4px', borderBottomRightRadius: '12px' },
      'rounded-tl-sm rounded-br-xl',
    ],
    [
      { borderWidth: '1px', borderStyle: 'solid', borderColor: '#E5E5E5' },
      'border border-solid border-border',
    ],
    [
      { borderTopWidth: '2px', borderTopStyle: 'dashed', borderTopColor: 'var(--color-border)' },
      'border-t-2 [border-top-style:dashed] border-t-border',
    ],
    [{ backgroundColor: 'transparent' }, 'bg-transparent'],
    [{ backgroundColor: 'var(--brand)' }, '[background-color:var(--brand)]'],
    [
      { backgroundColor: 'color-mix(in srgb, red 50%, transparent)' },
      '[background-color:color-mix(in_srgb,red_50%,transparent)]',
    ],
    [
      { backgroundImage: 'linear-gradient(90deg, #000 0%, #fff 100%)', backgroundSize: 'cover' },
      '[background-image:linear-gradient(90deg,#000_0%,#fff_100%)] bg-cover',
    ],
    [{ opacity: 0.6 }, 'opacity-muted'],
    [{ opacity: 0.35 }, 'opacity-35'],
    [{ opacity: 0.333 }, 'opacity-[0.333]'],
    [{ boxShadow: '0 1px 2px #00000014' }, '[box-shadow:0_1px_2px_#00000014]'],
    [{ rotate: '-15deg' }, '-rotate-15'],
    [{ rotate: '12.5deg' }, 'rotate-[12.5deg]'],
    [{ zIndex: 10, overflow: 'hidden' }, 'z-10 overflow-hidden'],
    [{ flexGrow: 1, flexShrink: 0, flexBasis: '0%' }, 'grow shrink-0 basis-[0%]'],
    [
      { fontWeight: 700, fontStyle: 'italic', textTransform: 'uppercase', textAlign: 'center' },
      'font-bold italic uppercase text-center',
    ],
    [{ letterSpacing: '-0.02em', fontFamily: 'Inter' }, 'tracking-display font-sans'],
    [{ fontFamily: 'Georgia, serif', fontWeight: 550 }, 'font-[Georgia,serif] font-[550]'],
    [{ lineHeight: 1.5 }, 'leading-[1.5]'],
    [{ lineHeight: '24px' }, 'leading-6'],
    [{ lineHeight: 1 }, 'leading-none'],
    [{ mixBlendMode: 'multiply', filter: 'blur(4px)' }, '[filter:blur(4px)] mix-blend-multiply'],
    [
      { aspectRatio: '16 / 9', WebkitLineClamp: '2', '--x': '1px' },
      'aspect-video [--x:1px] [-webkit-line-clamp:2]',
    ],
    [{ marginTop: 'auto', marginInline: '-4px' }, '-mx-1 mt-auto'],
    [{ marginLeft: '-6px' }, 'ml-[-6px]'],
  ] as [Record<string, string | number>, string][])('%j → %s', (styles, expected) => {
    expect(classes(styles)).toBe(expected)
  })
  test('text: canonical white-space is not printed unless stored', () => {
    expect(classes({ fontSize: '13px' }, SAMPLE_TOKENS, 'text')).toBe('text-base')
    expect(classes({ whiteSpace: 'pre-wrap' }, SAMPLE_TOKENS, 'text')).toBe('whitespace-pre-wrap')
  })
  test('literal colours matching exactly one token use it; no tokens → arbitrary values', () => {
    expect(classes({ color: '#1a1a1a' })).toBe('text-foreground')
    expect(classes({ color: 'rgb(26, 26, 26)' })).toBe('text-foreground')
    expect(classes({ color: '#1a1a1a' }, {})).toBe('text-[#1a1a1a]')
  })
})

describe('golden JSX for the corpus', () => {
  if (!existsSync(GOLDEN)) mkdirSync(GOLDEN, { recursive: true })
  for (const name of fixtureNames()) {
    test.each(['tailwind', 'inline-styles'] as const)(`${name} (%s)`, (format) => {
      const run = runFixture(readFixture(name))
      const outs: string[] = []
      for (const id of run.roots) {
        if (getNode(run.doc, id)?.parentId !== (run.boardId ?? run.pageId)) continue
        outs.push(toJsx(resolved(run.doc, id), id, { format, tokens: TOKENS }))
      }
      const text = `${outs.join('\n\n')}\n`
      const file = new URL(`${name}.${format === 'tailwind' ? 'tailwind' : 'inline'}.jsx`, GOLDEN)
      if (UPDATE || !existsSync(file)) writeFileSync(file, text)
      expect(text).toBe(readFileSync(file, 'utf8'))
    })
  }
})

describe('renderStage', () => {
  test('ids, base css, tokens on :host, inherited + background on the wrapper, upright sized root', () => {
    const { doc, pageId } = setup()
    const board = createNode(doc, {
      type: 'frame',
      parentId: pageId,
      name: 'Board',
      styles: {
        left: 300,
        top: 200,
        width: 100,
        height: 50,
        rotate: '15deg',
        display: 'flex',
        backgroundImage: `url("baren-asset://${HASH_A}")`,
      },
    })
    const t = createNode(doc, {
      type: 'text',
      parentId: board,
      text: 'Hi',
      styles: { color: 'var(--color-x)' },
    })
    createNode(doc, {
      type: 'image',
      parentId: board,
      assetId: 'b'.repeat(64),
      styles: { width: 10, height: 10 },
    })
    createNode(doc, {
      type: 'rect',
      parentId: board,
      hidden: true,
      styles: { width: 10, height: 10 },
    })
    const stage = renderStage(resolved(doc, board), board, {
      tokens: { '--color-x': { type: 'color', value: '#123456' } },
      inherited: { fontSize: '12px' },
      size: { width: 100, height: 50.5 },
      background: '#FFFFFF',
      assetUrl: (h) => `baren-asset://${h}?v=1`,
    })
    expect(stage.html.startsWith(`<div data-baren-stage data-root-id="${board}">`)).toBe(true)
    expect(stage.html).toContain(`data-node-id="${board}"`)
    expect(stage.html).toContain(`data-node-id="${t}"`)
    expect(stage.html).toContain(`url(&quot;baren-asset://${HASH_A}?v=1&quot;)`)
    expect(stage.css).toContain(':host{--color-x:#123456;}')
    expect(stage.css).toContain('background:#FFFFFF;font-size:12px;')
    expect(stage.css).toContain(
      `[data-baren-stage]>[data-node-id="${board}"]{position:relative!important;`,
    )
    expect(stage.css).toContain(
      'rotate:none!important;width:100px!important;height:50.5px!important;',
    )
    expect(stage.css).toContain('box-sizing:border-box')
    expect(stage.css).toContain('white-space:pre-wrap')
    expect(stage.assetUrls).toEqual([
      `baren-asset://${HASH_A}?v=1`,
      `baren-asset://${'b'.repeat(64)}?v=1`,
    ])
  })
  test('exports are transparent; no size = layout in the stage', () => {
    const { doc, pageId } = setup()
    const f = createNode(doc, {
      type: 'frame',
      parentId: pageId,
      styles: { left: 0, top: 0, width: 10, height: 10 },
    })
    const stage = renderStage(resolved(doc, f), f, { tokens: {}, background: null, size: null })
    expect(stage.css).toContain('background:transparent;')
    expect(stage.css).not.toContain('width:10px!important')
    expect(stage.css).not.toContain(':host{')
  })
})
