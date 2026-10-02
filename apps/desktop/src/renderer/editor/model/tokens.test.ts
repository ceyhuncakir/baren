import { createEmptyDoc, getTokens } from '@baren/schema'
import { describe, expect, it } from 'vitest'
import { cssValue, kebab, toCss, toJsx } from './css'
import { deleteToken, renameToken, tokenOrders, upsertTokens } from './tokenOps'
import {
  TokenUsageCounter,
  groupTokens,
  normalizeTokenName,
  tokenDisplayValue,
  tokenGroup,
  tokenNamespace,
  uniqueTokenName,
} from './tokens'

describe('token grouping', () => {
  const tokens = {
    '--color-surface': { type: 'color', value: '#F7F7F7' },
    '--color-background': { type: 'color', value: '#FFFFFF' },
    '--font-sans': { type: 'fontFamily', value: "'Inter Variable', Inter, sans-serif" },
    '--text-base': { type: 'fontSize', value: '13px' },
    '--spacing-2': { type: 'spacing', value: '8px' },
    '--radius-md': { type: 'radius', value: '6px' },
    '--shadow-x': { type: 'other', value: '0 1px 2px #000' },
  }

  it('groups by type/namespace with display names and values', () => {
    const groups = groupTokens(tokens, '', { '--color-background': 1, '--color-surface': 2 })
    expect(groups.map((g) => g.id)).toEqual(['colors', 'typography', 'spacing', 'radius', 'other'])
    const colors = groups[0]?.entries ?? []
    expect(colors.map((e) => [e.label, e.value])).toEqual([
      ['background', 'FFFFFF'],
      ['surface', 'F7F7F7'],
    ])
    expect(groups[1]?.entries.map((e) => [e.label, e.value])).toEqual([
      ['font-sans', 'Inter Variable'],
      ['text-base', '13px'],
    ])
  })

  it('filters by name or value', () => {
    expect(groupTokens(tokens, 'surf').flatMap((g) => g.entries.map((e) => e.name))).toEqual([
      '--color-surface',
    ])
    expect(groupTokens(tokens, '13px').flatMap((g) => g.entries.map((e) => e.name))).toEqual([
      '--text-base',
    ])
  })

  it('names and namespaces', () => {
    expect(tokenGroup('--font-weight-medium', { type: 'other' })).toBe('typography')
    expect(tokenNamespace('--color-selection')).toBe('--color-')
    expect(normalizeTokenName('brand blue', '--color-')).toBe('--color-brand-blue')
    expect(normalizeTokenName('--x', '--color-')).toBe('--x')
    expect(normalizeTokenName('bad{name', '--color-')).toBeNull()
    expect(uniqueTokenName('--color-new', { '--color-new': 1, '--color-new-2': 1 })).toBe(
      '--color-new-3',
    )
    expect(tokenDisplayValue({ type: 'color', value: 'var(--other)' })).toBe('var(--other)')
  })
})

describe('token usage', () => {
  it('counts layers, artboards and property kinds', () => {
    const counter = new TokenUsageCounter('--color-selection')
    const n = (id: string, styles: Record<string, string>) => ({
      id,
      type: 'frame' as const,
      name: id,
      parentId: null,
      children: [],
      styles,
    })
    counter.add('a1', [
      n('x', { backgroundColor: 'var(--color-selection)', color: 'var(--color-selection)' }),
      n('y', { boxShadow: '0 0 0 1px var(--color-selection, #2F80FF)' }),
      n('z', { color: 'var(--color-selection-subtle)' }),
    ])
    counter.add('a2', [n('w', { outline: '1px solid var(--color-selection)' })])
    expect(counter.result()).toEqual({
      layers: 3,
      artboards: 2,
      byKind: [
        { kind: 'fill', count: 1 },
        { kind: 'outline', count: 1 },
        { kind: 'shadow', count: 1 },
        { kind: 'text', count: 1 },
      ],
      nodeIds: ['x', 'y', 'w'],
    })
  })
})

describe('token ops (Loro)', () => {
  it('keeps panel order across upsert, rename and delete', () => {
    const doc = createEmptyDoc('t')
    upsertTokens(doc, {
      '--color-b': { type: 'color', value: '#000000' },
      '--color-a': { type: 'color', value: '#FFFFFF' },
    })
    expect(tokenOrders(doc)).toEqual({ '--color-b': 1, '--color-a': 2 })
    expect(renameToken(doc, '--color-b', '--color-z', { type: 'color', value: '#000000' })).toBe(
      true,
    )
    expect(tokenOrders(doc)).toEqual({ '--color-z': 1, '--color-a': 2 })
    expect(Object.keys(getTokens(doc)).sort()).toEqual(['--color-a', '--color-z'])
    // Renaming onto an existing token is refused.
    expect(renameToken(doc, '--color-z', '--color-a', { type: 'color', value: '#000000' })).toBe(
      false,
    )
    deleteToken(doc, '--color-z')
    expect(Object.keys(getTokens(doc))).toEqual(['--color-a'])
  })
})

describe('css export', () => {
  it('converts names and units like the canvas', () => {
    expect(kebab('backgroundColor')).toBe('background-color')
    expect(kebab('WebkitLineClamp')).toBe('-webkit-line-clamp')
    expect(kebab('--fill-hidden')).toBe('--fill-hidden')
    expect(cssValue('width', 12)).toBe('12px')
    expect(cssValue('opacity', 0.5)).toBe('0.5')
    expect(cssValue('lineHeight', 1.4)).toBe('1.4')
  })

  it('emits a rule for a node, skipping hidden paints and unsafe values', () => {
    const css = toCss({
      name: 'Field / Email',
      type: 'text',
      styles: {
        fontSize: '13px',
        fontWeight: 500,
        '--hidden-color': '#000',
        content: 'x;}body{color:red',
      },
    })
    expect(css).toBe(
      '.field-email {\n  font-size: 13px;\n  font-weight: 500;\n  white-space: pre-wrap;\n}\n',
    )
  })

  it('emits JSX for a subtree', () => {
    const nodes = {
      f: {
        id: 'f',
        type: 'frame' as const,
        name: 'Card',
        parentId: null,
        children: ['t', 'h'],
        styles: { gap: 8 },
      },
      t: {
        id: 't',
        type: 'text' as const,
        name: 'Title',
        parentId: 'f',
        children: [],
        styles: {},
        text: 'Hi {there}',
      },
      h: {
        id: 'h',
        type: 'rect' as const,
        name: 'Hidden',
        parentId: 'f',
        children: [],
        styles: {},
        hidden: true,
      },
    }
    expect(toJsx(nodes, 'f')).toBe(
      "<div style={{ gap: 8 }}>\n  {/* Title */}\n  <p style={{ whiteSpace: 'pre-wrap' }}>{'Hi {there}'}</p>\n</div>\n",
    )
  })
})
