import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createLogger } from '../log'
import {
  DEFAULT_PORT,
  McpConfigStore,
  generateToken,
  isValidConfig,
  portCandidates,
} from './config'
import { McpHttpServer } from './httpServer'

const quiet = createLogger('test', { sink: () => undefined })

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'baren-mcp-config-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('mcp config (contract §3.1–§3.3)', () => {
  it('generates brn_ tokens of 32 random bytes', () => {
    const token = generateToken()
    expect(token).toMatch(/^brn_[A-Za-z0-9_-]{43}$/)
    expect(generateToken()).not.toBe(token)
    expect(generateToken(() => Buffer.alloc(32, 0xff))).toBe(`brn_${'_'.repeat(42)}8`)
  })

  it('creates config.json on first start with 0600 and the mcp dir with 0700', async () => {
    const store = new McpConfigStore(dir, quiet)
    const cfg = await store.load()
    expect(cfg).toMatchObject({ version: 1, enabled: true, port: DEFAULT_PORT })
    expect(isValidConfig(cfg)).toBe(true)
    const onDisk = JSON.parse(await readFile(store.paths.config, 'utf8'))
    expect(onDisk).toEqual(cfg)
    if (process.platform !== 'win32') {
      expect((await stat(store.paths.config)).mode & 0o777).toBe(0o600)
      expect((await stat(store.paths.dir)).mode & 0o777).toBe(0o700)
    }
    // A second store reads the same config back.
    expect(await new McpConfigStore(dir, quiet).load()).toEqual(cfg)
  })

  it('recreates invalid content with a new token, keeping valid choices', async () => {
    const store = new McpConfigStore(dir, quiet)
    await store.ensureDir()
    await writeFile(
      store.paths.config,
      JSON.stringify({ version: 1, enabled: false, port: 30000, token: 'short' }),
    )
    const cfg = await store.load()
    expect(cfg.enabled).toBe(false)
    expect(cfg.port).toBe(30000)
    expect(cfg.token).toMatch(/^brn_/)
    const garbage = new McpConfigStore(join(dir, 'other'), quiet)
    await garbage.ensureDir()
    await writeFile(garbage.paths.config, '{not json')
    expect(isValidConfig(await garbage.load())).toBe(true)
  })

  it('rotates the token and persists enable/port changes', async () => {
    const store = new McpConfigStore(dir, quiet)
    const before = await store.load()
    const rotated = await store.rotateToken()
    expect(rotated.token).not.toBe(before.token)
    await store.update({ enabled: false, port: 29175 })
    const reread = await new McpConfigStore(dir, quiet).load()
    expect(reread).toEqual({ ...rotated, enabled: false, port: 29175 })
  })

  it('writes and removes endpoint.json without the token', async () => {
    const store = new McpConfigStore(dir, quiet)
    const cfg = await store.load()
    await store.writeEndpoint({
      version: 1,
      url: 'http://127.0.0.1:29170/mcp',
      port: 29170,
      pid: 42,
      appVersion: '0.1.0',
      startedAt: 1,
    })
    const text = await readFile(store.paths.endpoint, 'utf8')
    expect(text).not.toContain(cfg.token)
    expect(JSON.parse(text)).toMatchObject({ url: 'http://127.0.0.1:29170/mcp', pid: 42 })
    await store.removeEndpoint()
    await expect(stat(store.paths.endpoint)).rejects.toThrow()
    await store.removeEndpoint()
  })

  it('tries the configured port, +1…+9, then an ephemeral port; never the dev ports', () => {
    expect(portCandidates(29170)).toEqual([
      29170, 29171, 29172, 29173, 29174, 29175, 29176, 29177, 29178, 29179, 0,
    ])
    expect(portCandidates(8785)).toEqual([8785, 8786, 8788, 8789, 8790, 8791, 8792, 8793, 8794, 0])
    expect(portCandidates(5173)).not.toContain(5173)
    expect(portCandidates(29170, 0)).toEqual([0])
    expect(portCandidates(29170, 31000)).toEqual([31000])
    expect(portCandidates(65_530).at(-2)).toBe(65_535)
  })

  it('falls back to the next free port when the first is taken', async () => {
    const blocker = createServer()
    await new Promise<void>((resolve) => blocker.listen({ host: '127.0.0.1', port: 0 }, resolve))
    const taken = (blocker.address() as { port: number }).port
    const http = new McpHttpServer({
      security: () => ({ token: 'x', extraOrigins: [] }),
      handle: async () => undefined,
    })
    try {
      const bound = await http.listen([taken, 0])
      expect(bound).not.toBe(taken)
      expect(bound).toBeGreaterThan(0)
      const other = new McpHttpServer({
        security: () => ({ token: 'x', extraOrigins: [] }),
        handle: async () => undefined,
      })
      await expect(other.listen([taken])).rejects.toThrow(`port ${taken} is in use`)
    } finally {
      await http.close()
      await new Promise((resolve) => blocker.close(resolve))
    }
  })
})
