/**
 * QA (Phase 3) end to end: two clients edit one file through the real `baren-server`
 * binary (own port, `MAIL_TRANSPORT=file:<tmp>`). Every scenario is made truly concurrent —
 * peer B goes offline, both peers edit, B reconnects — and must converge to identical
 * snapshots, identical resolved instances and identical HTML on both sides:
 *
 * - A groups {x, y} while B moves x;
 * - A edits a main component while B overrides the same nodes in an instance;
 * - A and B edit different and the same points of one vector;
 * - A pastes (a copy of the main and an instance from another file) while B edits the main;
 * - A and B paste the same component from another file into the file;
 * - A rotates a layer while B reparents it.
 *
 * Build the server first (or set BAREN_SERVER_BIN):
 *   CARGO_TARGET_DIR=$PWD/target/p3-qa cargo build -p baren-server
 * Without a binary the suite is skipped.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import {
  createComponent,
  createComponentResolver,
  createEmptyDoc,
  createInstance,
  createNode,
  docGeometry,
  editVector,
  exportSnapshot,
  getChildIds,
  getNode,
  groupNodes,
  loadDoc,
  pasteClipboard,
  renderHtml,
  reparentNodes,
  rotateNodes,
  serializeClipboard,
  setStyles,
  setStylesAt,
  setTextAt,
  toRenderSubtree,
  toSnapshot,
  transact,
  type ClipboardPayload,
} from '@baren/schema'
import type { LoroDoc } from 'loro-crdt'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { createApiClient, type ApiClient } from '../src/api.ts'
import { connectFile, type FileConnection } from '../src/connect.ts'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const candidates = [
  process.env['BAREN_SERVER_BIN'],
  join(repoRoot, 'target/p3-qa/debug/baren-server'),
  join(repoRoot, 'target/p3-qa/release/baren-server'),
  join(repoRoot, 'target/sync-server/debug/baren-server'),
  join(repoRoot, 'target/p2-server/debug/baren-server'),
  join(repoRoot, 'target/debug/baren-server'),
  join(repoRoot, 'target/release/baren-server'),
].filter((p): p is string => typeof p === 'string' && p.length > 0)
const serverBin =
  process.env['BAREN_SERVER_BIN'] && existsSync(process.env['BAREN_SERVER_BIN'])
    ? process.env['BAREN_SERVER_BIN']
    : candidates
        .filter((p) => existsSync(p))
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]

it.runIf(!serverBin)('phase 3 e2e skipped: baren-server binary not found', () => {
  console.warn(
    '[sync-client e2e-phase3] SKIPPED: build the server or set BAREN_SERVER_BIN. Looked in:\n  ' +
      candidates.join('\n  '),
  )
})

class ServerProcess {
  baseUrl = ''
  readonly dir = mkdtempSync(join(tmpdir(), 'baren-e2e3-'))
  readonly mailDir = join(this.dir, 'mail')
  private child: ChildProcessWithoutNullStreams | null = null
  readonly log: string[] = []

  async start(bin: string): Promise<void> {
    const child = spawn(bin, [], {
      env: {
        ...process.env,
        BIND: '127.0.0.1:0',
        DATABASE_URL: `sqlite://${join(this.dir, 'e2e.db')}`,
        MAIL_TRANSPORT: `file:${this.mailDir}`,
        SMTP_URL: '',
        RUST_LOG: 'info',
        NO_COLOR: '1',
      },
    })
    this.child = child
    this.baseUrl = await new Promise<string>((resolve, reject) => {
      const onLine = (line: string) => {
        this.log.push(line)
        const url = /listening on (http:\/\/\S+)/.exec(line)
        if (url) resolve(url[1]!)
      }
      createInterface({ input: child.stdout }).on('line', onLine)
      createInterface({ input: child.stderr }).on('line', onLine)
      child.once('exit', (code) =>
        reject(new Error(`server exited early (${code}):\n${this.log.join('\n')}`)),
      )
    })
  }

  /** The verification code mailed to `to` (from the file transport's `.json` sidecars). */
  async code(to: string): Promise<string> {
    let code: string | null = null
    await vi.waitFor(
      () => {
        const files = existsSync(this.mailDir) ? readdirSync(this.mailDir) : []
        for (const f of files.filter((n) => n.endsWith('-verification_code.json'))) {
          const mail = JSON.parse(readFileSync(join(this.mailDir, f), 'utf8')) as {
            to: string
            code: string | null
          }
          if (mail.to === to && mail.code) code = mail.code
        }
        expect(code).not.toBeNull()
      },
      { timeout: 5000 },
    )
    return code!
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

/** Everything both peers must agree on: snapshot, resolved instances and exported HTML. */
function rendered(doc: LoroDoc): unknown {
  const snap = toSnapshot(doc)
  const resolver = createComponentResolver(doc)
  const instances = Object.values(snap.nodes)
    .filter((n) => n.type === 'instance')
    .map((n) => n.id)
    .sort()
  const pageRoots = snap.pageIds.flatMap((p) => getChildIds(doc, p))
  return {
    snapshot: snap,
    instances: instances.map((id) => toRenderSubtree(doc, id, resolver)),
    html: renderHtml(doc, pageRoots, { includeIds: true }),
  }
}

describe.skipIf(!serverBin)('phase 3 e2e: concurrent edits through the real server', () => {
  const server = new ServerProcess()
  const connections: FileConnection[] = []
  let alice: { api: ApiClient; token: string }
  let bob: { api: ApiClient; token: string }
  let teamId = ''

  const signUp = async (anon: ApiClient, name: string, email: string) => {
    await anon.auth.register({ name, email, password: 'correct horse battery' })
    const session = await anon.auth.verify(email, await server.code(email))
    return {
      token: session.token,
      api: createApiClient({ baseUrl: server.baseUrl, getToken: () => session.token }),
    }
  }

  beforeAll(async () => {
    await server.start(serverBin!)
    const anon = createApiClient({ baseUrl: server.baseUrl })
    alice = await signUp(anon, 'Ada', 'ada@example.com')
    bob = await signUp(anon, 'Bora', 'bora@example.com')
    teamId = (await alice.api.me()).teams[0]!.id
    const invite = await alice.api.invites.create(teamId, { role: 'editor', maxUses: 1 })
    await bob.api.invites.accept(invite.token)
  })

  afterAll(async () => {
    for (const c of connections) c.disconnect()
    await server.stop()
  })

  /**
   * A shared file seeded by A, both peers connected and synced. `concurrently` takes B
   * offline, runs both edits, reconnects B and waits until both peers agree.
   */
  async function sharedFile(seed: (doc: LoroDoc, pageId: string) => void) {
    const docA = createEmptyDoc('QA shared', { peerId: 101 })
    const pageId = toSnapshot(docA).pageIds[0]!
    seed(docA, pageId)
    docA.commit()
    const remote = await alice.api.files.create(teamId, {
      name: 'QA shared',
      snapshot: exportSnapshot(docA),
    })
    const docB = loadDoc(await bob.api.files.snapshot(remote.id))
    docB.setPeerId(202)
    const connect = (token: string, doc: LoroDoc) => {
      const c = connectFile({ baseUrl: server.baseUrl, token, fileId: remote.id, doc })
      connections.push(c)
      return c
    }
    const connA = connect(alice.token, docA)
    let connB = connect(bob.token, docB)
    await Promise.all([connA.whenSynced(), connB.whenSynced()])
    expect(toSnapshot(docB)).toEqual(toSnapshot(docA))

    const converged = async () => {
      await vi.waitFor(() => expect(rendered(docB)).toEqual(rendered(docA)), {
        timeout: 10_000,
        interval: 25,
      })
    }
    const concurrently = async (onA: (doc: LoroDoc) => void, onB: (doc: LoroDoc) => void) => {
      connB.disconnect()
      onA(docA)
      onB(docB)
      // A's edit reached the server while B was offline: B's edit is concurrent with it.
      connB = connect(bob.token, docB)
      await connB.whenSynced()
      await converged()
    }
    return { docA, docB, pageId, concurrently, converged }
  }

  it('A groups {x, y} while B moves x: x ends in the group on both peers', async () => {
    const ids: Record<string, string> = {}
    const s = await sharedFile((doc, page) => {
      ids['x'] = createNode(doc, {
        type: 'rect',
        parentId: page,
        name: 'x',
        styles: { left: 0, top: 0, width: 10, height: 10 },
      })
      ids['y'] = createNode(doc, {
        type: 'rect',
        parentId: page,
        name: 'y',
        styles: { left: 50, top: 50, width: 10, height: 10 },
      })
    })
    let group = ''
    await s.concurrently(
      (a) => {
        group = groupNodes(a, [ids['x']!, ids['y']!], docGeometry(a), {
          origin: 'editor:group',
        })!
      },
      (b) => transact(b, () => setStyles(b, ids['x']!, { left: 500 }), { origin: 'canvas:move' }),
    )
    for (const doc of [s.docA, s.docB]) {
      expect(getNode(doc, ids['x']!)?.parentId).toBe(group)
      expect(getNode(doc, group)?.children).toEqual([ids['x'], ids['y']])
    }
  })

  it('A edits the main while B overrides it in an instance: both kept, identical renders', async () => {
    const ids: Record<string, string> = {}
    const s = await sharedFile((doc, page) => {
      const card = createNode(doc, {
        type: 'frame',
        parentId: page,
        name: 'Card',
        styles: { left: 0, top: 0, width: 200, height: 100, backgroundColor: '#FFFFFF' },
      })
      ids['title'] = createNode(doc, {
        type: 'text',
        parentId: card,
        name: 'Title',
        text: 'Title',
        styles: { position: 'absolute', left: 8, top: 8, fontSize: 14, color: '#111111' },
      })
      ids['icon'] = createNode(doc, {
        type: 'rect',
        parentId: card,
        name: 'Icon',
        styles: {
          position: 'absolute',
          left: 150,
          top: 10,
          width: 20,
          height: 20,
          backgroundColor: '#FF0000',
        },
      })
      ids['main'] = createComponent(doc, [card], docGeometry(doc))!
      ids['inst'] = createInstance(doc, {
        componentKey: getNode(doc, ids['main'])!.componentKey!,
        parentId: page,
        styles: { left: 300, top: 0 },
      })
    })
    const tk = getNode(s.docA, ids['title']!)!.nodeKey!
    const ik = getNode(s.docA, ids['icon']!)!.nodeKey!
    await s.concurrently(
      (a) =>
        transact(
          a,
          () => {
            setStyles(a, ids['icon']!, { backgroundColor: '#00FF00', width: 30 })
            setStyles(a, ids['title']!, { fontSize: 20 })
            setTextAt(a, ids['title']!, 'Main title')
          },
          { origin: 'editor:inspector' },
        ),
      (b) =>
        transact(
          b,
          () => {
            setStylesAt(b, `${ids['inst']}/${ik}`, { backgroundColor: '#0000FF' })
            setTextAt(b, `${ids['inst']}/${tk}`, 'Override')
          },
          { origin: 'editor:inspector' },
        ),
    )
    for (const doc of [s.docA, s.docB]) {
      const r = createComponentResolver(doc)
      expect(r.resolveNode(`${ids['inst']}/${ik}`)?.styles).toMatchObject({
        backgroundColor: '#0000FF',
        width: 30,
      })
      const title = r.resolveNode(`${ids['inst']}/${tk}`)
      expect(title?.text).toBe('Override')
      expect(title?.styles['fontSize']).toBe(20)
      expect(getNode(doc, ids['title']!)?.text).toBe('Main title')
    }
  })

  it('A and B edit one vector concurrently: different points both kept, same point LWW', async () => {
    const ids: Record<string, string> = {}
    const s = await sharedFile((doc, page) => {
      ids['v'] = createNode(doc, {
        type: 'vector',
        parentId: page,
        name: 'Path',
        styles: { left: 0, top: 0, width: 100, height: 100, stroke: '#000', fill: 'none' },
        vector: {
          fillRule: 'nonzero',
          subpaths: [
            {
              id: 'qa000001',
              closed: false,
              points: [
                { x: 0, y: 0 },
                { x: 50, y: 0 },
                { x: 100, y: 50 },
                { x: 100, y: 100 },
              ],
            },
          ],
        },
      })
    })
    await s.concurrently(
      (a) =>
        transact(
          a,
          () =>
            editVector(a, ids['v']!, [
              { kind: 'set', subpathId: 'qa000001', index: 0, point: { x: 5, y: 5 } },
              { kind: 'insert', subpathId: 'qa000001', index: 2, point: { x: 75, y: 10 } },
              { kind: 'set', subpathId: 'qa000001', index: 4, point: { x: 90, y: 90 } },
            ]),
          { origin: 'canvas:vector' },
        ),
      (b) =>
        transact(
          b,
          () =>
            editVector(b, ids['v']!, [
              { kind: 'set', subpathId: 'qa000001', index: 2, point: { x: 60, y: 60 } },
              { kind: 'set', subpathId: 'qa000001', index: 3, point: { x: 80, y: 80 } },
              { kind: 'closed', subpathId: 'qa000001', closed: true },
            ]),
          { origin: 'canvas:vector' },
        ),
    )
    const pts = getNode(s.docA, ids['v']!)!.vector!.subpaths[0]!.points
    expect(pts).toHaveLength(5)
    // A's first point and inserted point, B's moved middle point survive.
    expect(pts[0]).toEqual({ x: 5, y: 5 })
    expect(pts[2]).toEqual({ x: 75, y: 10 })
    expect(pts[3]).toEqual({ x: 60, y: 60 })
    // The last point was set by both: one value wins, the same on both peers.
    expect([
      { x: 90, y: 90 },
      { x: 80, y: 80 },
    ]).toContainEqual(pts[4])
    expect(getNode(s.docB, ids['v']!)!.vector!.subpaths[0]!.closed).toBe(true)
  })

  it('A pastes (a main copy and instances from another file) while B edits the main', async () => {
    const ids: Record<string, string> = {}
    const s = await sharedFile((doc, page) => {
      const card = createNode(doc, {
        type: 'frame',
        parentId: page,
        name: 'Card',
        styles: { left: 0, top: 0, width: 200, height: 100, backgroundColor: '#FFFFFF' },
      })
      ids['title'] = createNode(doc, {
        type: 'text',
        parentId: card,
        name: 'Title',
        text: 'Title',
        styles: { position: 'absolute', left: 8, top: 8 },
      })
      ids['main'] = createComponent(doc, [card], docGeometry(doc))!
      ids['inst'] = createInstance(doc, {
        componentKey: getNode(doc, ids['main'])!.componentKey!,
        parentId: page,
        styles: { left: 300, top: 0 },
      })
    })
    // Another file with its own component (a button) and an instance of it.
    const other = createEmptyDoc('Other', { peerId: 303 })
    const otherPage = toSnapshot(other).pageIds[0]!
    const btn = createNode(other, {
      type: 'frame',
      parentId: otherPage,
      name: 'Button',
      styles: { left: 0, top: 0, width: 120, height: 40, backgroundColor: '#14213D' },
    })
    createNode(other, { type: 'text', parentId: btn, name: 'Label', text: 'Go', styles: {} })
    const btnMain = createComponent(other, [btn], docGeometry(other))!
    const btnInst = createInstance(other, {
      componentKey: getNode(other, btnMain)!.componentKey!,
      parentId: otherPage,
      styles: { left: 300, top: 0 },
    })
    const foreign = serializeClipboard(other, [btnInst], {
      geo: docGeometry(other),
      fileId: 'other',
      pageId: otherPage,
    })!
    let local: ClipboardPayload | null = null
    let pasted: string[] = []
    await s.concurrently(
      (a) => {
        local = serializeClipboard(a, [ids['main']!, ids['inst']!], {
          geo: docGeometry(a),
          fileId: 'shared',
          pageId: s.pageId,
        })
        const r1 = pasteClipboard(a, local!, {
          parentId: s.pageId,
          geo: docGeometry(a),
          translate: { dx: 0, dy: 400 },
        })
        const r2 = pasteClipboard(a, foreign, { parentId: s.pageId, geo: docGeometry(a) })
        pasted = [...r1.ids, ...r2.ids]
      },
      (b) =>
        transact(
          b,
          () => {
            setStyles(b, ids['main']!, { backgroundColor: '#FFEEDD', borderRadius: 8 })
            setTextAt(b, ids['title']!, 'Edited by B')
          },
          { origin: 'editor:inspector' },
        ),
    )
    expect(pasted).toHaveLength(3)
    for (const doc of [s.docA, s.docB]) {
      const r = createComponentResolver(doc)
      // The original instance and the pasted instance follow B's main edit.
      const pastedInst = pasted.find((id) => getNode(doc, id)?.type === 'instance' && id !== '')
      for (const inst of [ids['inst']!, pastedInst!]) {
        const exp = r.expandInstance(inst)!
        expect(exp.status).toBe('ok')
      }
      expect(r.resolveNode(ids['inst']!)?.styles['borderRadius']).toBe(8)
      // The pasted main copy is a separate component (fresh key) and not edited by B.
      const copy = getNode(doc, pasted[0]!)!
      expect(copy.componentKey).not.toBe(getNode(doc, ids['main']!)!.componentKey)
      // The foreign component's main landed on a "Components" page.
      const pages = toSnapshot(doc).pageIds.map((p) => getNode(doc, p)!.name)
      expect(pages).toContain('Components')
    }
  })

  it('A and B paste the same component from another file: deterministic resolution on both', async () => {
    const s = await sharedFile(() => undefined)
    const other = createEmptyDoc('Other', { peerId: 404 })
    const otherPage = toSnapshot(other).pageIds[0]!
    const chip = createNode(other, {
      type: 'frame',
      parentId: otherPage,
      name: 'Chip',
      styles: { left: 0, top: 0, width: 80, height: 24, backgroundColor: '#EEF2F8' },
    })
    createNode(other, { type: 'text', parentId: chip, name: 'Label', text: 'New', styles: {} })
    const chipMain = createComponent(other, [chip], docGeometry(other))!
    const key = getNode(other, chipMain)!.componentKey!
    const inst = createInstance(other, { componentKey: key, parentId: otherPage, styles: {} })
    const payload = serializeClipboard(other, [inst], {
      geo: docGeometry(other),
      fileId: 'other',
      pageId: otherPage,
    })!
    await s.concurrently(
      (a) => void pasteClipboard(a, payload, { parentId: s.pageId, geo: docGeometry(a) }),
      (b) =>
        void pasteClipboard(b, payload, {
          parentId: s.pageId,
          geo: docGeometry(b),
          translate: { dx: 200, dy: 0 },
        }),
    )
    for (const doc of [s.docA, s.docB]) {
      const instances = Object.values(toSnapshot(doc).nodes).filter((n) => n.type === 'instance')
      expect(instances).toHaveLength(2)
      const r = createComponentResolver(doc)
      for (const i of instances) expect(r.expandInstance(i.id)?.status).toBe('ok')
    }
  })

  it('A deletes the main while B overrides its instance; cross instances make a cycle', async () => {
    const ids: Record<string, string> = {}
    const frame = (doc: LoroDoc, page: string, name: string, left: number) =>
      createNode(doc, {
        type: 'frame',
        parentId: page,
        name,
        styles: { left, top: 0, width: 100, height: 100, backgroundColor: '#FFFFFF' },
      })
    const s = await sharedFile((doc, page) => {
      const card = frame(doc, page, 'Card', 0)
      ids['title'] = createNode(doc, {
        type: 'text',
        parentId: card,
        name: 'Title',
        text: 'Hi',
        styles: {},
      })
      ids['main'] = createComponent(doc, [card], docGeometry(doc))!
      ids['inst'] = createInstance(doc, {
        componentKey: getNode(doc, ids['main'])!.componentKey!,
        parentId: page,
        styles: { left: 300, top: 0 },
      })
      ids['x'] = createComponent(doc, [frame(doc, page, 'X', 600)], docGeometry(doc))!
      ids['y'] = createComponent(doc, [frame(doc, page, 'Y', 800)], docGeometry(doc))!
    })
    const tk = getNode(s.docA, ids['title']!)!.nodeKey!
    const keyOf = (doc: LoroDoc, id: string) => getNode(doc, id)!.componentKey!
    await s.concurrently(
      (a) =>
        transact(
          a,
          () => {
            a.getTree('nodes').delete(ids['main'] as `${number}@${number}`)
            // An instance of Y inside X…
            createInstance(a, { componentKey: keyOf(a, ids['y']!), parentId: ids['x']! })
          },
          { origin: 'editor:menu' },
        ),
      (b) =>
        transact(
          b,
          () => {
            setTextAt(b, `${ids['inst']}/${tk}`, 'B override')
            // …while B puts an instance of X inside Y: a cycle after the merge.
            createInstance(b, { componentKey: keyOf(b, ids['x']!), parentId: ids['y']! })
          },
          { origin: 'editor:inspector' },
        ),
    )
    for (const doc of [s.docA, s.docB]) {
      const r = createComponentResolver(doc)
      const exp = r.expandInstance(ids['inst']!)!
      expect(exp.status).toBe('ok')
      expect(exp.mainDeleted).toBe(true)
      expect(exp.nodes[`${ids['inst']}/${tk}`]?.text).toBe('B override')
      const statuses = Object.values(toSnapshot(doc).nodes)
        .filter((n) => n.type === 'instance' && n.id !== ids['inst'])
        .map((n) => {
          const e = r.expandInstance(n.id)!
          return Object.values(e.nodes).some((v) => v.status === 'cycle')
        })
      expect(statuses).toEqual([true, true])
    }
  })

  it('A and B convert the same frame into a component at the same time', async () => {
    const ids: Record<string, string> = {}
    const s = await sharedFile((doc, page) => {
      ids['f'] = createNode(doc, {
        type: 'frame',
        parentId: page,
        name: 'Tile',
        styles: { left: 0, top: 0, width: 100, height: 100 },
      })
      createNode(doc, { type: 'rect', parentId: ids['f'], name: 'Dot', styles: { width: 5 } })
    })
    await s.concurrently(
      (a) => void createComponent(a, [ids['f']!], docGeometry(a), { origin: 'editor:component' }),
      (b) => void createComponent(b, [ids['f']!], docGeometry(b), { origin: 'editor:component' }),
    )
    for (const doc of [s.docA, s.docB]) {
      const key = getNode(doc, ids['f']!)!.componentKey!
      expect(key).toMatch(/^[0-9a-z]{16}$/)
      const inst = createInstance(doc, { componentKey: key, parentId: s.pageId, styles: {} })
      expect(createComponentResolver(doc).expandInstance(inst)?.status).toBe('ok')
      doc.getTree('nodes').delete(inst as `${number}@${number}`)
      doc.commit()
    }
    await s.converged()
  })

  it('A rotates a layer while B reparents it into a frame', async () => {
    const ids: Record<string, string> = {}
    const s = await sharedFile((doc, page) => {
      ids['frame'] = createNode(doc, {
        type: 'frame',
        parentId: page,
        name: 'Frame',
        styles: { left: 200, top: 0, width: 300, height: 300 },
      })
      ids['r'] = createNode(doc, {
        type: 'rect',
        parentId: page,
        name: 'R',
        styles: { left: 0, top: 0, width: 40, height: 20 },
      })
    })
    await s.concurrently(
      (a) => rotateNodes(a, [ids['r']!], 45, docGeometry(a), { origin: 'canvas:rotate' }),
      (b) =>
        void reparentNodes(
          b,
          [{ id: ids['r']!, world: { x: 250, y: 50, width: 40, height: 20, rotation: 0 } }],
          { parentId: ids['frame']! },
          docGeometry(b),
          { origin: 'canvas:reparent' },
        ),
    )
    for (const doc of [s.docA, s.docB]) {
      expect(getNode(doc, ids['r']!)?.parentId).toBe(ids['frame'])
      expect(getNode(doc, ids['r']!)?.styles['rotate']).toBe('45deg')
    }
  })
})
