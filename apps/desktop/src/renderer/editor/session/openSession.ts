/**
 * Open a design file for editing: load the Loro snapshot through the bridge, seed design
 * fixtures (browser fixture mode only), build the session caches and the save pipeline.
 * `close()` flushes pending changes and saves preferences; the file thumbnail is written once
 * saves settle and on close (thumbnailWriter.ts).
 *
 * Opens and closes of the same file are serialized: React StrictMode mounts the editor
 * twice in development, and the second open must see what the first one saved.
 *
 * Every session is an MCP agent host (Phase 4 contract §11.2, `attachAgentHost`). A headless
 * session (`#/agent-host/<fileId>`, a hidden window main opens for agents) reads and writes no
 * file preferences and seeds no fixtures; its `release` request closes it.
 */
import { getChildIds, loadDoc } from '@baren/schema'
import { toast } from '@baren/ui'
import { attachAgentHost } from '../../agent/host/attach'
import { AgentPresenceStore } from '../../agent/presence'
import { assetsArrived, getAssetBytes, putAsset, sniffImageMime } from '../../lib/assets'
import { bridge } from '../../lib/bridge'
import { AssetSync } from '../collab/assetSync'
import { EditorActions } from '../commands/actions'
import { PresenceRelay } from '../collab/presence'
import { fixtureView, prepareFixtureAssets, seedFixture } from '../fixtures'
import {
  batchFontFamilies,
  docFontFamilies,
  ensureDesignFonts,
  ensureFontFamilies,
} from '../lib/fonts'
import { fixtureMode } from '../lib/env'
import { createPage } from '../model/docOps'
import { LayerTree } from '../model/layerTree'
import { createWatchers, type EditorSession, type InitialViewport } from './context'
import { DocEvents } from './docEvents'
import { Persistence } from './persistence'
import { persistFilePrefs, readFilePrefs } from './prefs'
import { createEditorStore } from './store'
import { saveThumbnail } from './thumbnail'
import { ThumbnailWriter } from './thumbnailWriter'

export interface SessionHandle {
  session: EditorSession
  close(): Promise<void>
}

const locks = new Map<string, Promise<void>>()

async function acquire(fileId: string): Promise<() => void> {
  const previous = locks.get(fileId) ?? Promise.resolve()
  let release!: () => void
  const mine = new Promise<void>((resolve) => (release = resolve))
  const chain = previous.then(() => mine)
  locks.set(fileId, chain)
  await previous
  return () => {
    release()
    if (locks.get(fileId) === chain) locks.delete(fileId)
  }
}

export interface OpenSessionOptions {
  /** A hidden agent host: no file preferences, no fixtures (contract §11.3). */
  headless?: boolean
}

export async function openSession(
  fileId: string,
  exit: () => void,
  options: OpenSessionOptions = {},
): Promise<SessionHandle> {
  const headless = options.headless === true
  const release = await acquire(fileId)
  try {
    void ensureDesignFonts()
    const fixture = headless ? { ...fixtureMode, enabled: false } : fixtureMode
    const [bytes, files] = await Promise.all([
      bridge.files.open(fileId),
      bridge.files.list().catch(() => []),
    ])
    const doc = loadDoc(bytes)
    const base = doc.oplogVersion()
    if (fixture.enabled) {
      const assets = await prepareFixtureAssets(fixture.scene, putAsset)
      seedFixture(doc, fileId, fixture.scene, assets)
    }
    const seed = fixture.enabled ? fixtureView(doc, fileId, fixture.scene) : null
    if (getChildIds(doc, null).length === 0) createPage(doc, 'Page 1')

    const events = new DocEvents(doc)
    const tree = new LayerTree(doc, events.resolver)
    events.subscribe((batch, affected) => tree.apply(batch, affected))
    const prefs = fixture.enabled || headless ? null : readFilePrefs(fileId)
    const pages = tree.pages()
    const pageId =
      seed?.pageId ??
      (prefs?.pageId && pages.includes(prefs.pageId) ? prefs.pageId : (pages[0] as string))
    const store = createEditorStore({
      pageId,
      remoteId: files.find((f) => f.id === fileId)?.remoteId ?? null,
      expanded: new Set(seed?.expanded ?? prefs?.expanded ?? []),
      leftPanelOpen: prefs?.leftPanelOpen ?? true,
      mode: prefs?.mode ?? 'design',
    })
    const prefsWriter = fixture.enabled || headless ? null : persistFilePrefs(fileId, store, prefs)

    // The Home card preview: written once saves settle and on close (thumbnailWriter.ts).
    const thumbnails = new ThumbnailWriter({
      save: () => saveThumbnail(fileId, doc),
      has: async () => (await bridge.files.getThumbnail(fileId)) !== null,
    })
    let lastSaveError = 0
    const persistence = new Persistence(
      doc,
      (update) => bridge.files.applyUpdate(fileId, update),
      base,
      {
        onError: (error) => {
          // One toast per 30 s at most; the save is retried on the next change.
          if (Date.now() - lastSaveError < 30_000) return
          lastSaveError = Date.now()
          toast(
            `Couldn't save changes: ${error instanceof Error ? error.message : 'unknown error'}`,
          )
        },
        onSaved: () => thumbnails.saved(),
      },
    )

    const initialViewports: Record<string, InitialViewport> = {
      ...(prefs?.viewports ?? {}),
      ...(seed?.viewports ?? {}),
    }
    const watchers = createWatchers(events)
    let session: EditorSession
    const actions = new EditorActions(() => session)
    const assets = new AssetSync({
      local: { get: getAssetBytes, put: putAsset, mimeOf: sniffImageMime },
      onArrived: (hashes) => {
        assetsArrived(hashes)
        session.canvas.current?.reloadAssets(hashes)
      },
      onError: (error) => console.warn('[assets]', error),
    })
    events.subscribe((batch) => assets.onBatch(doc, batch))
    // Google Fonts the design uses (and later adds): registered so they render the same here as
    // for every collaborator. After the first paint: the canvas re-measures text as faces arrive.
    const fontsTimer = setTimeout(() => void ensureFontFamilies(docFontFamilies(doc)), 0)
    events.subscribe((batch) => {
      const families = batchFontFamilies(doc, batch)
      if (families.size > 0) void ensureFontFamilies(families)
    })
    const agents = new AgentPresenceStore()
    agents.subscribe(() => store.setState({ agents: agents.get() }))
    session = {
      fileId,
      doc,
      events,
      resolver: events.resolver,
      tree,
      components: watchers.components,
      tokens: watchers.tokens,
      docName: watchers.docName,
      comments: watchers.comments,
      store,
      canvas: { current: null },
      canvasEl: { current: null },
      fixture,
      file: files.find((f) => f.id === fileId) ?? null,
      persistence,
      initialViewports,
      presence: new PresenceRelay(),
      assets,
      teams: [],
      actions,
      rememberViewport: (page, v) => prefsWriter?.setViewport(page, v),
      exit,
      headless,
      agents,
    }

    let closed = false
    const close = async (): Promise<void> => {
      if (closed) return
      closed = true
      clearTimeout(fontsTimer)
      try {
        agentHost.dispose()
        agents.dispose()
        prefsWriter?.dispose()
        assets.dispose()
        await persistence.dispose()
        events.dispose()
        await thumbnails.close()
      } finally {
        release()
      }
    }
    // Headless hosts close themselves on main's `release` request (flush + thumbnail).
    const agentHost = attachAgentHost(session, headless ? { release: close } : {})
    return { session, close }
  } catch (error) {
    release()
    throw error
  }
}
