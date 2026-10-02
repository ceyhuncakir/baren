#!/usr/bin/env node
// Smoke test for the built @baren/core-native addon, driven the way the
// Electron main process will drive it: documents are edited with loro-crdt
// through @baren/schema and persisted through CoreHandle.
//
//   pnpm --filter @baren/core-native build    (CARGO_TARGET_DIR must be absolute)
//   pnpm --filter @baren/core-native smoke     (Node >= 22.18: imports schema .ts)
//   ELECTRON_RUN_AS_NODE=1 electron crates/napi/scripts/smoke.mjs   (Electron's runtime)
//
// Exits non-zero on the first failed check.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createComponent,
  createInstance,
  createNode,
  docGeometry,
  exportSnapshot,
  generateBenchDoc,
  getChildIds,
  getNode,
  groupNodes,
  loadDoc,
  renderHtml,
  setStyles,
  setStylesAt,
  setText,
  setTextAt,
  setTokens,
  toSnapshot,
  transact,
} from '../../../packages/schema/src/index.ts'

const require = createRequire(import.meta.url)
const { CoreHandle, coreVersion } = require('../index.js')

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const dir = mkdtempSync(join(tmpdir(), 'baren-smoke-'))
// How the Electron main process constructs it: an existing data directory.
const dbPath = join(dir, 'core')
mkdirSync(dbPath)

// The methods apps/desktop/src/main/core/nativeBackend.ts requires (CORE_METHODS).
const CORE_METHODS = [
  'listFiles',
  'createFile',
  'renameFile',
  'archiveFile',
  'removeFile',
  'openFile',
  'applyUpdate',
  'setThumbnail',
  'getThumbnail',
  'putAsset',
  'getAsset',
  'getAssetInfo',
  'getAssetFile',
  'exportHtml',
  'exportJson',
]

async function step(name, fn) {
  const start = performance.now()
  const note = await fn()
  const ms = (performance.now() - start).toFixed(1).padStart(8)
  console.log(`ok ${ms} ms  ${name}${note ? `  (${note})` : ''}`)
}

async function rejects(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.match(err.message, new RegExp(`^\\[${code}\\]`), err.message)
    return true
  })
}

/** Max event-loop delay (ms) while `fn` runs: proves work happens off-thread. */
async function maxLag(fn) {
  let max = 0
  let last = performance.now()
  const timer = setInterval(() => {
    const now = performance.now()
    max = Math.max(max, now - last - 1)
    last = now
  }, 1)
  try {
    await fn()
  } finally {
    clearInterval(timer)
  }
  return max
}

function exportSince(doc, version) {
  doc.commit()
  return doc.export({ mode: 'update', from: version })
}

try {
  console.log(`@baren/core-native ${coreVersion()} — db ${dbPath}`)
  // Small compaction interval so the concurrent-update step below also
  // crosses several compactions.
  let core = new CoreHandle(dbPath, { compactEvery: 50 })
  let meta
  let doc
  let board
  let title

  await step('module shape matches the desktop-shell adapter (CORE_METHODS + close)', async () => {
    for (const m of [...CORE_METHODS, 'close']) assert.equal(typeof core[m], 'function', m)
    // A database file path works too (parent directories are created).
    const byFile = new CoreHandle(join(dir, 'nested', 'deeper', 'file.sqlite'))
    assert.equal((await byFile.createFile('x')).name, 'x')
    await byFile.close()
    assert.ok(existsSync(join(dir, 'nested', 'deeper', 'file.sqlite')))
  })

  await step('createFile → FileMeta', async () => {
    meta = await core.createFile('Smoke')
    assert.equal(typeof meta.id, 'string')
    assert.equal(meta.name, 'Smoke')
    assert.equal(typeof meta.createdAt, 'number')
    assert.equal(meta.createdAt, meta.updatedAt)
    assert.equal(meta.archived, false)
    assert.equal(meta.teamId, null)
    assert.equal(meta.remoteId, null)
    const list = await core.listFiles()
    assert.deepEqual(list, [meta])
    assert.ok(existsSync(join(dbPath, 'baren.sqlite')), 'database inside the data dir')
  })

  await step('a second process cannot open the same database ([locked])', async () => {
    const child = `
      const { CoreHandle } = require(${JSON.stringify(require.resolve('../index.js'))})
      new CoreHandle(${JSON.stringify(dbPath)}).listFiles().then(
        () => { console.log('opened'); process.exit(1) },
        (e) => { console.log(e.message); process.exit(0) })`
    const out = execFileSync(process.execPath, ['-e', child], {
      encoding: 'utf8',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    assert.match(out, /^\[locked\]/, out)
  })

  await step('openFile → loadDoc (createEmptyDoc layout)', async () => {
    const bytes = await core.openFile(meta.id)
    assert.ok(Buffer.isBuffer(bytes))
    doc = loadDoc(bytes)
    const snap = toSnapshot(doc)
    assert.equal(snap.name, 'Smoke')
    assert.equal(snap.pageIds.length, 1)
    assert.equal(snap.nodes[snap.pageIds[0]].name, 'Page 1')
    assert.equal(snap.nodes[snap.pageIds[0]].background, '#EEEEEE')
    return `${bytes.length} bytes`
  })

  await step('applyUpdate (loro-crdt update from @baren/schema helpers)', async () => {
    const before = doc.oplogVersion()
    const page = getChildIds(doc, null)[0]
    transact(doc, () => {
      board = createNode(doc, {
        type: 'frame',
        parentId: page,
        name: 'Board',
        styles: { left: 0, top: 0, width: 1440, height: 900, backgroundColor: 'var(--color-bg)' },
      })
      title = createNode(doc, {
        type: 'text',
        parentId: board,
        name: 'Title',
        text: 'Hello <smoke> & "quotes"',
        styles: { fontSize: '24px' },
      })
      createNode(doc, {
        type: 'svg',
        parentId: board,
        svg: '<svg viewBox="0 0 1 1" onload="alert(1)"><script>alert(2)</script><path d="M0 0"/></svg>',
      })
      setTokens(doc, { '--color-bg': { type: 'color', value: '#FAFAFA', description: 'Canvas' } })
    })
    const update = exportSince(doc, before)
    await core.applyUpdate(meta.id, update)
    // Re-sending the same update is accepted (nothing new).
    await core.applyUpdate(meta.id, update)
    return `${update.length} bytes`
  })

  await step('applyUpdate rejects invalid bytes; unknown ids are not-found', async () => {
    await rejects(core.applyUpdate(meta.id, Uint8Array.from([1, 2, 3])), 'invalid-update')
    await rejects(core.applyUpdate(meta.id, new Uint8Array()), 'invalid-update')
    await rejects(core.openFile('no-such-file'), 'not-found')
    await rejects(core.exportHtml(meta.id, '999@999'), 'not-found')
  })

  await step('200 dependent updates fired concurrently, in reverse order', async () => {
    const updates = []
    for (let i = 0; i < 200; i++) {
      const before = doc.oplogVersion()
      if (i % 4 === 0) setText(doc, title, `Hello <smoke> & "quotes" #${i}`)
      else setStyles(doc, board, { left: i, top: i * 2 })
      updates.push(exportSince(doc, before))
    }
    const lag = await maxLag(() =>
      Promise.all(updates.reverse().map((u) => core.applyUpdate(meta.id, u))),
    )
    return `max event-loop lag ${lag.toFixed(1)} ms`
  })

  await step('close → new CoreHandle → reopen matches the JS document', async () => {
    await core.close()
    await rejects(core.listFiles(), 'closed')
    core = new CoreHandle(dbPath)
    const reopened = loadDoc(await core.openFile(meta.id))
    assert.deepEqual(toSnapshot(reopened), toSnapshot(doc))
  })

  await step('exportJson equals JS toSnapshot', async () => {
    const json = await core.exportJson(meta.id)
    assert.deepEqual(JSON.parse(json), toSnapshot(doc))
    assert.ok(json.startsWith('{\n  "name": "Smoke",\n  "pageIds": [\n'))
    return `${json.length} chars`
  })

  await step('exportHtml: semantic, escaped, sanitised, tokens as :root vars', async () => {
    const html = await core.exportHtml(meta.id, board)
    assert.match(
      html,
      /^<style>\n:root \{\n {2}--color-bg: #FAFAFA; \/\* Canvas \*\/\n\}\n<\/style>\n/,
    )
    assert.match(
      html,
      /<section style="position: relative; width: 1440px; height: 900px; background-color: var\(--color-bg\)">/,
    )
    assert.match(
      html,
      /<h2 style="margin: 0; font-weight: inherit; font-size: 24px">Hello &lt;smoke&gt; &amp; "quotes" #196<\/h2>/,
    )
    assert.match(html, /<svg viewBox="0 0 1 1"><path d="M0 0"\/><\/svg>/)
    assert.doesNotMatch(html, /script|onload|left:/)
    const page = await core.exportHtml(meta.id, getChildIds(doc, null)[0], {
      document: true,
      includeNodeIds: true,
    })
    assert.match(page, /^<!doctype html>/)
    assert.match(page, new RegExp(`data-node-id="${board}"`))
  })

  await step('assets: blake3 content addressing, dedupe, null for unknown', async () => {
    const hash = await core.putAsset(PNG, 'image/png')
    assert.match(hash, /^[0-9a-f]{64}$/)
    assert.equal(await core.putAsset(Buffer.from(PNG), 'IMAGE/PNG'), hash)
    assert.deepEqual(new Uint8Array(await core.getAsset(hash)), PNG)
    assert.equal(await core.getAsset('0'.repeat(64)), null)
    await rejects(core.putAsset(PNG, 'not a mime'), 'invalid-input')
  })

  await step('images: asset info/file, image layers + fills in HTML and JSON export', async () => {
    // A PNG header (signature + IHDR, 2400×1200) is enough for imagesize.
    const head = new Uint8Array(33)
    head.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
    new DataView(head.buffer).setUint32(16, 2400)
    new DataView(head.buffer).setUint32(20, 1200)
    head.set([8, 6, 0, 0, 0], 24)
    // A generic mime (drag and drop) is replaced by the sniffed image type.
    const hash = await core.putAsset(head, 'application/octet-stream')
    assert.deepEqual(await core.getAssetInfo(hash), {
      mime: 'image/png',
      size: head.length,
      width: 2400,
      height: 1200,
    })
    const file = await core.getAssetFile(hash)
    assert.equal(file.mime, 'image/png')
    assert.deepEqual(new Uint8Array(file.bytes), head)
    assert.equal(await core.getAssetInfo('0'.repeat(64)), null)
    assert.equal(await core.getAssetFile('0'.repeat(64)), null)

    const local = loadDoc(await core.openFile(meta.id))
    const before = local.oplogVersion()
    const page = getChildIds(local, null)[0]
    let fillBoard
    let image
    transact(local, () => {
      fillBoard = createNode(local, {
        type: 'frame',
        parentId: page,
        name: 'Photo',
        styles: {
          left: 0,
          top: 2000,
          width: 400,
          height: 200,
          backgroundImage: `url("baren-asset://${hash}")`,
          backgroundSize: 'cover',
          '--hidden-backgroundColor': '#FF0000',
        },
      })
      image = createNode(local, {
        type: 'image',
        parentId: fillBoard,
        name: 'Hero',
        assetId: hash,
        assetName: 'dolomites-dawn.png',
        styles: { width: 100 },
      })
    })
    await core.applyUpdate(meta.id, exportSince(local, before))
    const html = await core.exportHtml(meta.id, fillBoard)
    const uri = `data:image/png;base64,${Buffer.from(head).toString('base64')}`
    assert.ok(html.includes(`background-image: url(&quot;${uri}&quot;)`), html)
    assert.ok(html.includes(`<img src="${uri}" alt="Hero" width="2400" height="1200"`), html)
    assert.doesNotMatch(html, /hidden/)
    const linked = await core.exportHtml(meta.id, fillBoard, { embedAssets: false })
    assert.ok(linked.includes(`url(&quot;baren-asset://${hash}&quot;)`), linked)
    const json = JSON.parse(await core.exportJson(meta.id, { embedAssets: true }))
    assert.equal(json.assets[hash], uri)
    assert.equal(json.nodes[image].assetName, 'dolomites-dawn.png')
    assert.equal(JSON.parse(await core.exportJson(meta.id)).assets, undefined)
  })

  await step(
    'phase 3: instances, groups, vectors and rotation in HTML and JSON export',
    async () => {
      const local = loadDoc(await core.openFile(meta.id))
      const before = local.oplogVersion()
      const pageId = getChildIds(local, null)[0]
      const card = createNode(local, {
        type: 'frame',
        parentId: pageId,
        name: 'Card',
        styles: { left: 3000, top: 0, width: 120, height: 40, display: 'flex' },
      })
      const title = createNode(local, { type: 'text', parentId: card, text: 'Main title' })
      const main = createComponent(local, [card], docGeometry(local))
      const key = getNode(local, main).componentKey
      const holder = createNode(local, {
        type: 'frame',
        parentId: pageId,
        name: 'Holder',
        styles: { left: 3200, top: 0, width: 400, height: 300 },
      })
      const inst = createInstance(local, {
        componentKey: key,
        parentId: holder,
        styles: { position: 'absolute', left: 10, top: 10, rotate: '15deg' },
      })
      const ref = `${inst}/${getNode(local, title).nodeKey}`
      setTextAt(local, ref, 'Instance title')
      setStylesAt(local, inst, { opacity: 0.5 })
      const a = createNode(local, {
        type: 'rect',
        parentId: holder,
        styles: { position: 'absolute', left: 200, top: 200, width: 10, height: 10 },
      })
      const b = createNode(local, {
        type: 'vector',
        parentId: holder,
        styles: {
          position: 'absolute',
          left: 250,
          top: 200,
          width: 20,
          height: 20,
          stroke: '#000',
        },
        vector: {
          fillRule: 'nonzero',
          subpaths: [
            {
              id: 'smoke001',
              closed: true,
              points: [
                { x: 0, y: 0 },
                { x: 20, y: 0 },
                { x: 10, y: 20 },
              ],
            },
          ],
        },
      })
      groupNodes(local, [a, b], docGeometry(local))
      await core.applyUpdate(meta.id, exportSince(local, before))
      const html = await core.exportHtml(meta.id, holder, { includeNodeIds: true })
      assert.equal(
        html,
        renderHtml(local, [holder], { includeIds: true }),
        'native = TS renderHtml',
      )
      assert.match(
        html,
        /<p data-node-id="[^"]+\/[0-9a-z]{10}" style="margin: 0">Instance title<\/p>/,
      )
      assert.match(html, /opacity: 0\.5; rotate: 15deg/)
      assert.match(html, /<path d="M 0 0 L 20 0 L 10 20 Z" fill-rule="nonzero"\/>/)
      const virtual = await core.exportHtml(meta.id, ref)
      assert.equal(virtual, renderHtml(local, [ref]))
      const json = JSON.parse(await core.exportJson(meta.id))
      assert.deepEqual(json.components, toSnapshot(local).components)
      assert.equal(json.nodes[inst].type, 'instance')
      assert.deepEqual(json.nodes[inst].overrides, toSnapshot(local).nodes[inst].overrides)
      return `${html.length} chars`
    },
  )

  await step('thumbnails: set/get PNG, reject non-PNG, null when absent', async () => {
    const other = await core.createFile('Other')
    assert.equal(await core.getThumbnail(other.id), null)
    await core.setThumbnail(meta.id, PNG)
    assert.deepEqual(new Uint8Array(await core.getThumbnail(meta.id)), PNG)
    await rejects(core.setThumbnail(meta.id, Uint8Array.from([1, 2, 3])), 'invalid-input')
    await core.removeFile(other.id)
  })

  await step('renameFile / archiveFile / setFileRemote reflected in listFiles + doc', async () => {
    await core.renameFile(meta.id, 'Smoke renamed')
    await core.archiveFile(meta.id, true)
    await core.setFileRemote(meta.id, 'team-1', 'remote-1')
    const [listed] = await core.listFiles()
    assert.equal(listed.name, 'Smoke renamed')
    assert.equal(listed.archived, true)
    assert.equal(listed.teamId, 'team-1')
    assert.ok(listed.updatedAt >= meta.updatedAt)
    assert.equal(JSON.parse(await core.exportJson(meta.id)).name, 'Smoke renamed')
    await core.setFileRemote(meta.id, null, null)
    assert.equal((await core.listFiles())[0].teamId, null)
  })

  await step(
    '20k-node document: import, open, export without blocking the event loop',
    async () => {
      const bench = exportSnapshot(
        generateBenchDoc({ artboards: 40, nodesPerArtboard: 500, peerId: 3 }),
      )
      let big
      const lags = {}
      // Measured per call. A synchronous 20k-node export would stall the loop
      // for ~150 ms; anything well below that means the work ran off-thread.
      // Typical: 0.1–6 ms. A window can occasionally reach ~30 ms when V8 runs
      // a burst of old-space GCs for this script's own allocations (wasm docs,
      // multi-MB buffers) — confirmed with --trace-gc, not native work.
      lags.importFile = await maxLag(async () => {
        big = await core.importFile(bench, 'Bench 20k')
      })
      // Cold open: a fresh handle with nothing cached (one owner at a time).
      await core.close()
      const fresh = new CoreHandle(dbPath)
      lags.openFile = await maxLag(() => fresh.openFile(big.id))
      await fresh.close()
      core = new CoreHandle(dbPath)
      // Client side (loro-crdt in this thread) is prepared outside the window.
      const local = loadDoc(await core.openFile(big.id))
      const before = local.oplogVersion()
      setStyles(local, getChildIds(local, getChildIds(local, null)[0])[0], { left: 1 })
      const update = exportSince(local, before)
      // The first update loads the 20k-node doc into the core's cache (worker thread).
      lags.applyUpdate = await maxLag(() => core.applyUpdate(big.id, update))
      lags.exportJson = await maxLag(() => core.exportJson(big.id))
      for (const [op, lag] of Object.entries(lags)) assert.ok(lag < 100, `${op} blocked ${lag} ms`)
      const report = Object.entries(lags).map(([op, lag]) => `${op} ${lag.toFixed(1)}`)
      return `snapshot ${(bench.length / 1e6).toFixed(2)} MB; max event-loop lag ms: ${report.join(', ')}`
    },
  )

  await step('removeFile', async () => {
    await core.removeFile(meta.id)
    assert.ok(!(await core.listFiles()).some((f) => f.id === meta.id))
    await rejects(core.openFile(meta.id), 'not-found')
    await rejects(core.removeFile(meta.id), 'not-found')
  })

  await core.close()
  console.log('smoke: all checks passed')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
