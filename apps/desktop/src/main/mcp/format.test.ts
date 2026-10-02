import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ToolError,
  batchFailed,
  errorResult,
  imageBlock,
  okResult,
  resultFromError,
} from './format'
import { GUIDE_TOPICS, Guide, splitGuide } from './guide'

const header = { file: { id: 'f1', name: 'Pricing' }, contentHash: { tokens: '0a1b2c3d' } }

describe('result format (contract §4.9, §4.10)', () => {
  it('uses two blocks: header JSON and pretty body JSON', () => {
    const result = okResult(header, { count: 1, items: ['a'] })
    expect(result.isError).toBeUndefined()
    expect(result.content).toEqual([
      {
        type: 'text',
        text: '{\n  "file": {\n    "id": "f1",\n    "name": "Pricing"\n  },\n  "contentHash": {\n    "tokens": "0a1b2c3d"\n  }\n}',
      },
      { type: 'text', text: '{\n  "count": 1,\n  "items": [\n    "a"\n  ]\n}' },
    ])
  })

  it('sends text bodies as they are and appends extra blocks', () => {
    const result = okResult(null, '(\n    <div />\n  )', [
      imageBlock(Uint8Array.of(1, 2, 3), 'image/jpeg'),
    ])
    expect(result.content).toEqual([
      { type: 'text', text: '(\n    <div />\n  )' },
      { type: 'image', data: 'AQID', mimeType: 'image/jpeg' },
    ])
  })

  it('formats errors as one actionable line with isError', () => {
    expect(errorResult('node_not_found', 'No node 1@2.\nCall get_children.', header)).toEqual({
      content: [
        { type: 'text', text: (okResult(header, null).content[0] as { text: string }).text },
        { type: 'text', text: 'Error [node_not_found]: No node 1@2. Call get_children.' },
      ],
      isError: true,
    })
    expect(resultFromError(new ToolError('timeout', 'slow')).content[0]).toEqual({
      type: 'text',
      text: 'Error [timeout]: slow',
    })
    expect(resultFromError(new Error('boom')).content[0]).toEqual({
      type: 'text',
      text: 'Error [internal]: boom',
    })
  })

  it('marks a batch failed only when no entry succeeded', () => {
    expect(batchFailed({ updated: [], errors: [{ index: 0 }] }, ['updated'])).toBe(true)
    expect(batchFailed({ updated: ['1@1'], errors: [{ index: 1 }] }, ['updated'])).toBe(false)
    expect(
      batchFailed({ deleted: [], hidden: ['1@1/k'], errors: [{}] }, ['deleted', 'hidden']),
    ).toBe(false)
    expect(batchFailed({ styles: {}, errors: [{}] }, ['styles'])).toBe(true)
    expect(batchFailed({ styles: { a: {} }, errors: [{}] }, ['styles'])).toBe(false)
    expect(batchFailed({ updated: [] }, ['updated'])).toBe(false)
  })
})

describe('guide (contract §6.1)', () => {
  const source = readFileSync(join(__dirname, '../../../../../docs/phase4/guide.md'), 'utf8')

  it('splits guide.md at its topic markers', () => {
    const topics = splitGuide(source)
    expect([...topics.keys()]).toEqual(['server-instructions', ...GUIDE_TOPICS])
    for (const [name, text] of topics) expect(text.length, name).toBeGreaterThan(50)
  })

  it('serves topics and the server instructions', () => {
    const guide = new Guide()
    expect(guide.serverInstructions).toContain('get_guide({ topic: "baren-mcp-instructions" })')
    expect(guide.topic('baren-mcp-instructions')).toMatch(/^# Working in Baren/)
    expect(guide.topic('Mobile-Status-Bar')).toContain('# Mobile status bar')
    expect(guide.topic('server-instructions')).toBeNull()
    expect(guide.topic('nope')).toBeNull()
    expect(guide.list()).toEqual([...GUIDE_TOPICS])
    expect(guide.topic('images')).not.toContain('<!-- topic:')
  })
})
