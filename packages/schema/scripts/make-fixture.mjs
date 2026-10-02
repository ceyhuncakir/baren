#!/usr/bin/env node
// Writes design/fixtures/sample.loro (a Loro snapshot built with the
// @baren/schema helpers) plus sample.json (its expected `toSnapshot`) so the
// Rust core can prove it reads JS-authored documents identically.
//
//   node packages/schema/scripts/make-fixture.mjs
//
// Requires Node >= 22.18 (built-in TypeScript type stripping).
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LORO_VERSION } from 'loro-crdt'
import {
  createEmptyDoc,
  createNode,
  exportSnapshot,
  getChildIds,
  loadDoc,
  setTokens,
  toSnapshot,
  transact,
} from '../src/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, '..', '..', '..', 'design', 'fixtures')

const doc = createEmptyDoc('Sample', { peerId: 1 })
const pageId = getChildIds(doc, null)[0]

transact(
  doc,
  () => {
    const board = createNode(doc, {
      type: 'frame',
      parentId: pageId,
      name: '01 Home',
      styles: {
        left: 0,
        top: 0,
        width: 1440,
        height: 900,
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        padding: '48px',
        backgroundColor: 'var(--color-background)',
      },
    })
    createNode(doc, {
      type: 'text',
      parentId: board,
      name: 'Title',
      text: 'Recents — ceyhun cakir',
      styles: {
        fontFamily: 'Inter',
        fontSize: '22px',
        lineHeight: '28px',
        color: 'var(--color-foreground)',
      },
    })
    const row = createNode(doc, {
      type: 'frame',
      parentId: board,
      name: 'Row',
      styles: { display: 'flex', gap: 8 },
    })
    createNode(doc, {
      type: 'rect',
      parentId: row,
      name: 'Swatch',
      styles: { width: '32px', height: '32px', borderRadius: '6px', backgroundColor: '#2F80FF' },
    })
    createNode(doc, {
      type: 'svg',
      parentId: row,
      name: 'Icon',
      svg: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="6"/></svg>',
      locked: true,
    })
    createNode(doc, {
      type: 'image',
      parentId: row,
      name: 'Photo',
      assetId: 'af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262',
      hidden: true,
      styles: { width: '64px', height: '64px' },
    })
    createNode(doc, { type: 'page', parentId: null, name: 'Page 2', background: '#FFFFFF' })
    setTokens(doc, {
      '--color-primary': { type: 'color', value: '#141414', description: 'Primary ink' },
      '--spacing-2': { type: 'spacing', value: '8px' },
      '--opacity-muted': { type: 'opacity', value: 0.6 },
    })
  },
  { origin: 'fixture' },
)

const bytes = exportSnapshot(doc)
const snapshot = toSnapshot(loadDoc(bytes))
mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'sample.loro'), bytes)
writeFileSync(
  join(outDir, 'sample.json'),
  `${JSON.stringify({ loroCrdtVersion: LORO_VERSION(), snapshot }, null, 2)}\n`,
)
const rel = relative(process.cwd(), outDir) || '.'
console.log(
  `wrote ${rel}/sample.loro (${bytes.byteLength} bytes, ${Object.keys(snapshot.nodes).length} nodes) and sample.json`,
)
