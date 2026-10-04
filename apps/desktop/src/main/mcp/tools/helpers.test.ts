import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isAuthUrl, isHomeUrl } from '../hosts'
import { pngHasAlpha } from '../assets'
import { deadlines, fileUrl, parseFileRef, underDeadline } from './context'
import { MAX_COMMENT_LENGTH as SCHEMA_MAX_COMMENT_LENGTH } from '@baren/schema'
import { HOST_TOOLS, hostArgs } from './host'
import { exportMultiplier, parseScale, sanitizeFileName, uniquePath } from './pixels'
import { MAX_COMMENT_LENGTH, schemas } from './schemas'

describe('comment tools', () => {
  it("run in the host and share the schema package's comment length limit", () => {
    expect(MAX_COMMENT_LENGTH).toBe(SCHEMA_MAX_COMMENT_LENGTH)
    for (const tool of ['get_comments', 'reply_to_comment', 'resolve_comment'] as const) {
      expect(HOST_TOOLS).toContain(tool)
    }
    const reply = schemas.reply_to_comment
    expect(reply.safeParse({ threadId: 't', body: 'x'.repeat(MAX_COMMENT_LENGTH) }).success).toBe(
      true,
    )
    expect(
      reply.safeParse({ threadId: 't', body: 'x'.repeat(MAX_COMMENT_LENGTH + 1) }).success,
    ).toBe(false)
    expect(reply.safeParse({ threadId: 't', body: '' }).success).toBe(false)
    expect(schemas.get_comments.safeParse({ includeResolved: true, nodeId: 'n' }).success).toBe(
      true,
    )
    expect(schemas.resolve_comment.safeParse({ threadId: 't', extra: 1 }).success).toBe(false)
    expect(hostArgs('get_comments', { fileId: 'f', pageId: 'p' }, null)).toEqual({ pageId: 'p' })
  })
})

describe('file references (contract §4.5)', () => {
  it('accepts ids and the documented URL forms', () => {
    expect(parseFileRef('abc-123')).toEqual({ fileId: 'abc-123', pageId: null })
    expect(parseFileRef(' baren://file/abc/p1 ')).toEqual({ fileId: 'abc', pageId: 'p1' })
    expect(parseFileRef('baren://file/abc')).toEqual({ fileId: 'abc', pageId: null })
    expect(parseFileRef('#/file/abc')).toEqual({ fileId: 'abc', pageId: null })
    expect(parseFileRef('/file/a%20b')).toEqual({ fileId: 'a b', pageId: null })
    expect(parseFileRef('https://baren.dev/file/abc/12%4034')).toEqual({
      fileId: 'abc',
      pageId: '12@34',
    })
    expect(parseFileRef('https://baren.dev/file/abc?x=1')).toEqual({
      fileId: 'abc',
      pageId: null,
    })
    expect(parseFileRef('')).toBeNull()
    expect(parseFileRef('https://evil.example/file/abc')).toBeNull()
    expect(parseFileRef('a b')).toBeNull()
    expect(fileUrl('abc')).toBe('baren://file/abc')
    expect(fileUrl('abc', '1@2')).toBe('baren://file/abc/1%402')
  })

  it('recognises home screens for open_file navigation', () => {
    expect(isHomeUrl('baren-app://app/index.html#/recents')).toBe(true)
    expect(isHomeUrl('http://localhost:5173/#/files')).toBe(true)
    expect(isHomeUrl('http://localhost:5173/#/team/members')).toBe(true)
    expect(isHomeUrl('http://localhost:5173/')).toBe(true)
    expect(isHomeUrl('http://localhost:5173/#/file/abc')).toBe(false)
    expect(isHomeUrl('http://localhost:5173/#/auth/sign-in')).toBe(false)
  })

  it('recognises the sign-in screen (open_file fails fast there)', () => {
    expect(isAuthUrl('baren-app://app/index.html#/auth/sign-in')).toBe(true)
    expect(isAuthUrl('http://localhost:5173/#/auth/verify?email=a')).toBe(true)
    expect(isAuthUrl('http://localhost:5173/#/auth')).toBe(true)
    expect(isAuthUrl('http://localhost:5173/#/file/abc')).toBe(false)
    expect(isAuthUrl('http://localhost:5173/#/recents')).toBe(false)
    expect(isAuthUrl('http://localhost:5173/#/authors')).toBe(false)
  })
})

describe('host arguments', () => {
  it('strips fileId, applies defaults and clamps', () => {
    expect(hostArgs('get_jsx', { fileId: 'f', nodeId: 'n' }, null)).toEqual({
      nodeId: 'n',
      format: 'tailwind',
      includeIds: false,
    })
    expect(hostArgs('get_tree_summary', { nodeId: 'n', depth: 0.5 }, null)).toEqual({
      nodeId: 'n',
      depth: 1,
    })
    expect(hostArgs('get_tree_summary', { nodeId: 'n' }, null)).toEqual({ nodeId: 'n', depth: 3 })
    expect(hostArgs('get_tokens', {}, null)).toEqual({ format: 'json' })
    expect(hostArgs('get_basic_info', { fileId: 'baren://file/f/p2' }, 'p2')).toEqual({
      pageId: 'p2',
    })
    expect(hostArgs('get_basic_info', { pageId: 'p9' }, 'p2')).toEqual({ pageId: 'p9' })
    expect(hostArgs('find_nodes', { textValue: 'Buy' }, 'p2')).toEqual({ textValue: 'Buy' })
  })

  it('validates find_nodes and artboard sizes', () => {
    expect(() => hostArgs('find_nodes', {}, null)).toThrow(/filters, textValue/)
    expect(() =>
      hostArgs(
        'create_artboard',
        { name: 'A', styles: { width: '1440px', height: 'fit-content' } },
        null,
      ),
    ).not.toThrow()
    expect(() =>
      hostArgs('create_artboard', { name: 'A', styles: { width: '1440', height: '900px' } }, null),
    ).toThrow(/styles.width/)
    expect(() =>
      hostArgs('create_artboard', { name: 'A', styles: { width: '50%', height: '900px' } }, null),
    ).toThrow()
  })
})

describe('export helpers (contract §6.30)', () => {
  it('parses scales and computes multipliers', () => {
    expect(parseScale('2x')).toEqual({ value: 2, unit: 'x' })
    expect(parseScale('1.5x')).toEqual({ value: 1.5, unit: 'x' })
    expect(parseScale('800w')).toEqual({ value: 800, unit: 'w' })
    expect(parseScale('0x')).toBeNull()
    expect(parseScale('x2')).toBeNull()
    expect(exportMultiplier({ value: 2, unit: 'x' }, 400, 200)).toBe(2)
    expect(exportMultiplier({ value: 800, unit: 'w' }, 400, 200)).toBe(2)
    expect(exportMultiplier({ value: 100, unit: 'h' }, 400, 200)).toBe(0.5)
    expect(exportMultiplier({ value: 512, unit: 'p' }, 400, 200)).toBe(2.56)
  })

  it('sanitises file names and finds free paths', async () => {
    expect(sanitizeFileName('Icon/Star: "big" <1>|*?')).toBe('Icon-Star- -big- -1----')
    expect(sanitizeFileName('  ..  ')).toBe('Untitled')
    expect(sanitizeFileName('a\u0001b')).toBe('a-b')
    const dir = await mkdtemp(join(tmpdir(), 'baren-export-'))
    try {
      expect(await uniquePath(dir, 'Hero@2x', 'png')).toBe(join(dir, 'Hero@2x.png'))
      await writeFile(join(dir, 'Hero@2x.png'), '')
      expect(await uniquePath(dir, 'Hero@2x', 'png')).toBe(join(dir, 'Hero@2x (2).png'))
      expect(
        await uniquePath(dir, 'Hero@2x', 'png', undefined, new Set([join(dir, 'Hero@2x (2).png')])),
      ).toBe(join(dir, 'Hero@2x (3).png'))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('detects PNG transparency', () => {
    const header = (colorType: number) => {
      const b = new Uint8Array(40)
      b.set([0x89, 0x50, 0x4e, 0x47], 0)
      b[25] = colorType
      return b
    }
    expect(pngHasAlpha(header(6))).toBe(true)
    expect(pngHasAlpha(header(2))).toBe(false)
  })
})

describe('deadlines (contract §4.6)', () => {
  it('uses the contract defaults, or one override for every tool', () => {
    expect(deadlines(null)).toMatchObject({
      read: 30_000,
      writeHtml: 60_000,
      screenshot: 45_000,
      export: 120_000,
    })
    expect(deadlines(1_000)).toMatchObject({
      read: 1_000,
      writeHtml: 1_000,
      export: 1_000,
      release: 1_000,
    })
  })

  it('reports a deadline abort as timeout and a client abort as cancelled', async () => {
    await expect(
      underDeadline(
        undefined,
        10,
        'slow tool',
        (signal) =>
          new Promise((_, reject) =>
            signal.addEventListener('abort', () => reject(new Error('aborted'))),
          ),
      ),
    ).rejects.toMatchObject({ code: 'timeout', message: 'slow tool did not finish within 0 s' })
    const controller = new AbortController()
    const pending = underDeadline(
      controller.signal,
      5_000,
      'x',
      (signal) =>
        new Promise((_, reject) =>
          signal.addEventListener('abort', () => reject(new Error('cancelled'))),
        ),
    )
    controller.abort()
    await expect(pending).rejects.toThrow('cancelled')
  })
})
