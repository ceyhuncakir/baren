/**
 * write_html corpus (contract §14.1): each fixture's resulting layer trees (types,
 * names, canonical styles, text, svg markup, assets) and warnings are compared with the
 * reviewed golden file `<fixture>.tree.json`. `UPDATE_GOLDEN=1` rewrites the goldens.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { getNode } from '@baren/schema'
import { checkInvariants, tree } from './helpers.ts'
import { FIXTURES, fixtureNames, readFixture, runFixture } from './corpus.ts'

const UPDATE = process.env['UPDATE_GOLDEN'] === '1'

describe('write_html corpus', () => {
  const names = fixtureNames()
  test('has at least 12 fixtures', () => {
    expect(names.length).toBeGreaterThanOrEqual(12)
  })
  test.each(names)('%s', (name) => {
    const run = runFixture(readFixture(name))
    expect(checkInvariants(run.doc)).toEqual([])
    const page = run.boardId === null
    const actual = {
      // Objects (not tuples) keep the golden files stable under prettier.
      warnings: run.warnings
        .map((w) => ({ ...w, message: undefined }))
        .map((w) => JSON.parse(JSON.stringify(w))),
      // Roots placed directly in the artboard (or page); later calls' roots appear inside them.
      roots: run.roots
        .filter((id) => getNode(run.doc, id)?.parentId === (run.boardId ?? run.pageId))
        .map((id) => tree(run.doc, id, { geometry: page })),
    }
    const file = new URL(`${name}.tree.json`, FIXTURES)
    if (UPDATE || !existsSync(file)) {
      writeFileSync(file, `${JSON.stringify(actual, null, 2)}\n`)
    }
    expect(actual).toEqual(JSON.parse(readFileSync(file, 'utf8')))
  })
})
