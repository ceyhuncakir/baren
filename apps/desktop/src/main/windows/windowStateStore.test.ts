import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createLogger } from '../log'
import { WindowStateStore } from './windowStateStore'

const silent = createLogger('test', { sink: () => {} })
const state = { bounds: { x: 10, y: 20, width: 1200, height: 800 }, maximized: false }

describe('WindowStateStore', () => {
  let dir: string
  let file: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'baren-ws-'))
    file = join(dir, 'nested', 'window-state.json')
  })
  afterEach(() => rm(dir, { recursive: true, force: true }))

  it('returns null when nothing was saved', async () => {
    expect(await new WindowStateStore(file, silent).load()).toBeNull()
  })

  it('round-trips through flush and load', async () => {
    const store = new WindowStateStore(file, silent)
    store.save(state)
    await store.flush()
    expect(await new WindowStateStore(file, silent).load()).toEqual(state)
  })

  it('coalesces rapid saves into one write of the latest state', async () => {
    const store = new WindowStateStore(file, silent, 20)
    store.save(state)
    store.save({ ...state, maximized: true })
    await new Promise((r) => setTimeout(r, 60))
    await store.flush()
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ ...state, maximized: true })
  })

  it('flushSync writes pending state immediately (quit path)', async () => {
    const store = new WindowStateStore(file, silent, 10_000)
    store.save(state)
    store.flushSync()
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(state)
  })

  it('ignores corrupt files', async () => {
    await writeFile(join(dir, 'bad.json'), '{not json')
    expect(await new WindowStateStore(join(dir, 'bad.json'), silent).load()).toBeNull()
  })
})
