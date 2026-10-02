import {
  createComponent,
  createEmptyDoc,
  createInstance,
  createNode,
  docGeometry,
  getChildIds,
  getNode,
  setTextAt,
  setTokens,
} from '@baren/schema'
import { describe, expect, it } from 'vitest'
import { KeyedMutex } from '../../util/keyedMutex'
import { blake3Hex } from './hash'
import { exportNodeHtml } from './htmlExport'
import { decodeRecords, encodeRecord } from './updateLog'

describe('updateLog', () => {
  it('round-trips records', () => {
    const a = Uint8Array.of(1, 2, 3)
    const b = new Uint8Array(300).fill(7)
    const log = Buffer.concat([encodeRecord(a), encodeRecord(b)])
    const { records, validBytes } = decodeRecords(log)
    expect(records.map((r) => [...r])).toEqual([[...a], [...b]])
    expect(validBytes).toBe(log.byteLength)
  })

  it('ignores a truncated tail', () => {
    const full = encodeRecord(Uint8Array.of(9, 9))
    const log = Buffer.concat([full, encodeRecord(Uint8Array.of(1, 2, 3, 4)).subarray(0, 6)])
    const { records, validBytes } = decodeRecords(log)
    expect(records).toHaveLength(1)
    expect(validBytes).toBe(full.byteLength)
    expect(decodeRecords(Uint8Array.of(1, 0)).records).toEqual([])
  })
})

describe('blake3Hex', () => {
  it('matches the reference vector (same hashes as the Rust core)', () => {
    expect(blake3Hex(new Uint8Array(0))).toBe(
      'af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262',
    )
  })
})

describe('KeyedMutex', () => {
  it('serialises per key, runs keys in parallel, survives failures', async () => {
    const mutex = new KeyedMutex()
    const order: string[] = []
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
    const a1 = mutex.run('a', async () => {
      await sleep(20)
      order.push('a1')
    })
    const a2 = mutex.run('a', async () => {
      order.push('a2')
      throw new Error('x')
    })
    const a3 = mutex.run('a', async () => order.push('a3'))
    const b1 = mutex.run('b', async () => order.push('b1'))
    await Promise.allSettled([a1, a2, a3, b1])
    expect(order).toEqual(['b1', 'a1', 'a2', 'a3'])
    await expect(a2).rejects.toThrow('x')
    await mutex.idle()
  })
})

describe('htmlExport (delegates to renderHtml, the twin of the Rust exporter)', () => {
  function doc() {
    const d = createEmptyDoc('Doc', { peerId: 1 })
    const pageId = getChildIds(d, null)[0] as string
    return { d, pageId }
  }

  it('renders an artboard like the Rust core: section, tokens, escaping, sanitised SVG, hidden nodes skipped', () => {
    const { d, pageId } = doc()
    setTokens(d, { '--x': { type: 'number', value: 4 } })
    const root = createNode(d, {
      type: 'frame',
      parentId: pageId,
      styles: { left: 5, top: 7, width: 100, color: 'red;} body{display:none' },
    })
    createNode(d, { type: 'text', parentId: root, text: 'a\nb & c' })
    createNode(d, {
      type: 'image',
      parentId: root,
      name: 'Photo "1"',
      assetId: 'ab'.repeat(32),
      styles: { width: 4, height: 4 },
    })
    createNode(d, {
      type: 'svg',
      parentId: root,
      svg: '<svg onload="x()"><script>alert(1)</script><a href="javascript:evil()"><path d="M0"/></a><path d="M1"/></svg>',
    })
    createNode(d, { type: 'rect', parentId: root, hidden: true })
    expect(exportNodeHtml(d, root)).toBe(
      [
        '<style>',
        ':root {',
        '  --x: 4;',
        '}',
        '</style>',
        `<section style="position: relative; width: 100px">`,
        '  <p style="margin: 0">a<br>b &amp; c</p>',
        `  <img src="baren-asset://${'ab'.repeat(32)}" alt="Photo &quot;1&quot;" style="width: 4px; height: 4px">`,
        '  <svg><path d="M1"/></svg>',
        '</section>',
        '',
      ].join('\n'),
    )
  })

  it('resolves instances and accepts virtual ids', () => {
    const { d, pageId } = doc()
    const card = createNode(d, {
      type: 'frame',
      parentId: pageId,
      styles: { left: 0, top: 0, width: 50, height: 20 },
    })
    const title = createNode(d, { type: 'text', parentId: card, text: 'Main' })
    const main = createComponent(d, [card], docGeometry(d))!
    const inst = createInstance(d, {
      componentKey: getNode(d, main)!.componentKey!,
      parentId: pageId,
      styles: { left: 100, top: 0 },
    })
    const ref = `${inst}/${getNode(d, title)!.nodeKey!}`
    setTextAt(d, ref, 'Override')
    expect(exportNodeHtml(d, inst)).toContain('<p style="margin: 0">Override</p>')
    expect(exportNodeHtml(d, ref)).toBe('<p style="margin: 0">Override</p>\n')
    expect(exportNodeHtml(d, '999@999')).toBeNull()
    expect(exportNodeHtml(d, `${inst}/zzzzzzzzzz`)).toBeNull()
    expect(exportNodeHtml(d, 'not-an-id')).toBeNull()
  })
})
