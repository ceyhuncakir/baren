/**
 * End-to-end: spawns the real `baren-server` binary and drives it with the REST client and
 * two `connectFile` sessions over Node's built-in WebSocket.
 *
 * Build the server first:
 *   CARGO_TARGET_DIR=$PWD/target/sync-server cargo build -p baren-server
 * or point BAREN_SERVER_BIN at a binary. Without one, the suite is skipped.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import {
  createEmptyDoc,
  createNode,
  exportSnapshot,
  getDocName,
  loadDoc,
  setDocName,
  setStyle,
  setTokens,
  toSnapshot,
} from '@baren/schema'
import { LoroDoc } from 'loro-crdt'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { createApiClient, type ApiClient } from '../src/api.ts'
import {
  connectFile,
  type ConnectFileOptions,
  type FileConnection,
  type SyncStatus,
} from '../src/connect.ts'
import type { PeerPresence } from '../src/protocol.ts'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const candidates = [
  process.env['BAREN_SERVER_BIN'],
  join(repoRoot, 'target/sync-server/debug/baren-server'),
  join(repoRoot, 'target/sync-server/release/baren-server'),
  join(repoRoot, 'target/debug/baren-server'),
  join(repoRoot, 'target/release/baren-server'),
].filter((p): p is string => typeof p === 'string' && p.length > 0)
const serverBin = candidates.find((p) => existsSync(p))

const SKIP_MESSAGE =
  '[sync-client e2e] SKIPPED: baren-server binary not found. Build it with\n' +
  '  CARGO_TARGET_DIR=$PWD/target/sync-server cargo build -p baren-server\n' +
  `or set BAREN_SERVER_BIN. Looked in:\n  ${candidates.join('\n  ')}`

// Visible in the run output (a module-level console.warn would be swallowed).
it.runIf(!serverBin)('e2e skipped: baren-server binary not found (see stderr)', () => {
  console.warn(SKIP_MESSAGE)
})

class ServerProcess {
  readonly codes = new Map<string, string>()
  baseUrl = ''
  private readonly dir = mkdtempSync(join(tmpdir(), 'baren-e2e-'))
  private child: ChildProcessWithoutNullStreams | null = null
  private readonly log: string[] = []

  async start(bin: string): Promise<void> {
    const child = spawn(bin, [], {
      env: {
        ...process.env,
        BIND: '127.0.0.1:0',
        DATABASE_URL: `sqlite://${join(this.dir, 'e2e.db')}`,
        RUST_LOG: 'info',
        NO_COLOR: '1',
      },
    })
    this.child = child
    const listening = new Promise<string>((resolve, reject) => {
      const onLine = (line: string) => {
        this.log.push(line)
        const code = /verification code for (\S+): (\d{6})/.exec(line)
        if (code) this.codes.set(code[1]!, code[2]!)
        const url = /listening on (http:\/\/\S+)/.exec(line)
        if (url) resolve(url[1]!)
      }
      createInterface({ input: child.stdout }).on('line', onLine)
      createInterface({ input: child.stderr }).on('line', onLine)
      child.once('exit', (code) =>
        reject(new Error(`server exited early (${code}):\n${this.log.join('\n')}`)),
      )
    })
    this.baseUrl = await listening
  }

  async codeFor(email: string): Promise<string> {
    await vi.waitFor(() => expect(this.codes.has(email)).toBe(true), { timeout: 5000 })
    return this.codes.get(email)!
  }

  async stop(): Promise<void> {
    const child = this.child
    if (child && child.exitCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve))
      child.kill('SIGTERM')
      await exited
    }
    rmSync(this.dir, { recursive: true, force: true })
  }
}

async function signUp(server: ServerProcess, api: ApiClient, name: string, email: string) {
  await api.auth.register({ name, email, password: 'correct horse battery' })
  return api.auth.verify(email, await server.codeFor(email))
}

/** Plain-data view of a design doc for equality checks. */
const view = (doc: LoroDoc) => toSnapshot(doc)

describe.skipIf(!serverBin)('e2e against the baren-server binary', () => {
  const server = new ServerProcess()
  const connections: FileConnection[] = []
  let anon: ApiClient
  let alice: { api: ApiClient; token: string }
  let bob: { api: ApiClient; token: string }
  let teamId: string
  let fileId: string

  beforeAll(async () => {
    await server.start(serverBin!)
    anon = createApiClient({ baseUrl: server.baseUrl })
    const a = await signUp(server, anon, 'ceyhun cakir', 'ceyhun@example.com')
    const b = await signUp(server, anon, 'Defne Aydın', 'defne@example.com')
    alice = {
      token: a.token,
      api: createApiClient({ baseUrl: server.baseUrl, getToken: () => a.token }),
    }
    bob = {
      token: b.token,
      api: createApiClient({ baseUrl: server.baseUrl, getToken: () => b.token }),
    }
  })

  afterAll(async () => {
    for (const c of connections) c.disconnect()
    await server.stop()
  })

  const connect = (token: string, doc: LoroDoc, extra: Partial<ConnectFileOptions> = {}) => {
    const conn = connectFile({ baseUrl: server.baseUrl, token, fileId, doc, ...extra })
    connections.push(conn)
    return conn
  }

  it('signs up, creates the first team, invites and accepts', async () => {
    const me = await alice.api.me()
    expect(me.user.name).toBe('ceyhun cakir')
    expect(me.teams[0]?.name).toBe("ceyhun's Team")
    teamId = me.teams[0]!.id

    const invite = await alice.api.invites.create(teamId, { role: 'editor', maxUses: 1 })
    expect(invite.url).toBe(`${server.baseUrl}/i/${invite.token}`)
    const preview = await anon.invites.preview(invite.token)
    expect(preview).toMatchObject({
      teamName: "ceyhun's Team",
      inviterName: 'ceyhun cakir',
      role: 'editor',
    })
    const accepted = await bob.api.invites.accept(invite.token)
    expect(accepted.team.role).toBe('editor')

    const members = await bob.api.teams.members(teamId)
    expect(members.map((m) => [m.name, m.role]).sort()).toEqual([
      ['Defne Aydın', 'editor'],
      ['ceyhun cakir', 'admin'],
    ])
  })

  it('syncs concurrent edits between two clients', async () => {
    // Alice uploads her local document as the file's initial snapshot.
    const docA = createEmptyDoc('Shared design')
    const remote = await alice.api.files.create(teamId, {
      name: 'Shared design',
      snapshot: exportSnapshot(docA),
    })
    fileId = remote.id
    const pageId = toSnapshot(docA).pageIds[0]!

    const docB = new LoroDoc()
    const statusesB: SyncStatus[] = []
    const connA = connect(alice.token, docA)
    const connB = connect(bob.token, docB, { onStatus: (s) => statusesB.push(s) })
    await Promise.all([connA.whenSynced(), connB.whenSynced()])
    expect(statusesB).toEqual(['connecting', 'syncing', 'synced'])
    expect(view(docB)).toEqual(view(docA))
    expect(connA.self?.role).toBe('admin')
    expect(connB.self?.role).toBe('editor')

    // Both edit at the same time.
    const frame = createNode(docA, {
      type: 'frame',
      parentId: pageId,
      name: 'Landing — Hero',
      styles: { left: 0, top: 0, width: 320, height: 232 },
    })
    const text = createNode(docB, {
      type: 'text',
      parentId: pageId,
      name: 'Title',
      text: 'Attack surface',
    })
    setTokens(docB, { '--color-primary': { type: 'color', value: '#141414' } })

    await vi.waitFor(
      () => {
        expect(view(docA).nodes[text]?.text).toBe('Attack surface')
        expect(view(docB).nodes[frame]?.name).toBe('Landing — Hero')
        expect(view(docA)).toEqual(view(docB))
      },
      { timeout: 5000, interval: 20 },
    )
    expect(view(docA).tokens['--color-primary']?.value).toBe('#141414')
  })

  it('relays presence with the server-assigned name and colour', async () => {
    const seenByA: Array<readonly PeerPresence[]> = []
    const docA = new LoroDoc()
    const docB = new LoroDoc()
    const connA = connect(alice.token, docA, { onPresence: (p) => seenByA.push(p) })
    const connB = connect(bob.token, docB)
    await Promise.all([connA.whenSynced(), connB.whenSynced()])

    connB.setPresence({ pageId: 'p', cursor: { x: 12, y: 34 }, selection: ['n1'] })
    await vi.waitFor(
      () => {
        const peer = seenByA.at(-1)?.find((p) => p.userId === connB.self?.userId)
        expect(peer).toMatchObject({
          name: 'Defne Aydın',
          cursor: { x: 12, y: 34 },
          selection: ['n1'],
        })
        expect(peer?.color).toBe(connB.self?.color)
      },
      { timeout: 5000, interval: 20 },
    )
    connB.disconnect()
    await vi.waitFor(
      () => expect(seenByA.at(-1)?.some((p) => p.clientId === connB.self?.clientId)).toBe(false),
      { timeout: 5000, interval: 20 },
    )
    connA.disconnect()
  })

  it('uploads offline edits on reconnect', async () => {
    const docA = loadDoc(await alice.api.files.snapshot(fileId))
    const docB = loadDoc(await bob.api.files.snapshot(fileId))
    const connA = connect(alice.token, docA)
    await connA.whenSynced()

    // Bob edits while not connected at all.
    setDocName(docB, 'Renamed offline')
    const pageId = toSnapshot(docB).pageIds[0]!
    const offlineNode = createNode(docB, { type: 'rect', parentId: pageId, name: 'Offline rect' })
    // Alice keeps editing meanwhile.
    const frameId = Object.values(toSnapshot(docA).nodes).find((n) => n.type === 'frame')!.id
    setStyle(docA, frameId, 'backgroundColor', 'var(--color-primary)')

    const connB = connect(bob.token, docB)
    await connB.whenSynced()
    await vi.waitFor(
      () => {
        expect(getDocName(docA)).toBe('Renamed offline')
        expect(view(docA).nodes[offlineNode]?.name).toBe('Offline rect')
        expect(view(docB).nodes[frameId]?.styles['backgroundColor']).toBe('var(--color-primary)')
        expect(view(docA)).toEqual(view(docB))
      },
      { timeout: 5000, interval: 20 },
    )

    // The REST snapshot reflects the live room, and the file list mirrors meta.name.
    const fromRest = loadDoc(await bob.api.files.snapshot(fileId))
    expect(view(fromRest)).toEqual(view(docA))
    await vi.waitFor(async () => {
      const files = await alice.api.files.list(teamId)
      expect(files.find((f) => f.id === fileId)?.name).toBe('Renamed offline')
    })
  })

  it('rejects bad tokens and outsiders without retrying', async () => {
    const statuses: SyncStatus[] = []
    connect('not-a-token', new LoroDoc(), { onStatus: (s) => statuses.push(s) })
    await vi.waitFor(() => expect(statuses.at(-1)).toBe('unauthorized'), { timeout: 5000 })

    const eve = await signUp(server, anon, 'Eve', 'eve@example.com')
    const outsider = connect(eve.token, new LoroDoc())
    await expect(outsider.whenSynced()).rejects.toThrow()
    expect(outsider.status).toBe('forbidden')

    const eveApi = createApiClient({ baseUrl: server.baseUrl, getToken: () => eve.token })
    await expect(eveApi.files.snapshot(fileId)).rejects.toMatchObject({ status: 403 })
    await expect(anon.me()).rejects.toMatchObject({ status: 401, code: 'unauthorized' })
  })
})
