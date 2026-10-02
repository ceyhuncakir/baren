/**
 * The heavy half of an agent host, loaded on the first request (`attach.ts` imports it lazily,
 * so the editor chunk stays lean and nothing agent-related runs before an agent does): the
 * executors' view of the session (`HostEnv`: geometry measured in an isolated stage, the
 * whole-file mirror, assets, the read-only check) and its dispatcher.
 */
import { getChildIds, getDocName } from '@baren/schema'
import { getAssetBytes, hasLocalAsset, loadAssetUrl, putAsset } from '../../lib/assets'
import { tokenOrders } from '../../editor/model/tokenOps'
import type { EditorSession } from '../../editor/session/context'
import type { AssetAccess, HostEnv } from '../context'
import { DocIndex } from '../docIndex'
import { AgentGeometry } from '../geometry'
import { createDomMeasurer, StageHost } from '../measure'
import { createResolvedStylesProbe } from '../render/styles'
import { Dispatcher } from './dispatch'

/** Requests wait this long for a visible window's canvas to mount (contract §11.2). */
const CANVAS_WAIT_MS = 2_000
/** Writes to a shared file wait this long for the collaboration role (contract §11.2). */
const ROLE_WAIT_MS = 3_000

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms
  while (!check()) {
    if (Date.now() >= until) return false
    await delay(25)
  }
  return true
}

/** Natural size of a stored raster, decoded in the DOM (5 s cap). */
async function naturalSize(hash: string): Promise<{ width: number; height: number } | null> {
  const url = await loadAssetUrl(hash)
  if (!url) return null
  const img = new Image()
  img.decoding = 'async'
  img.src = url
  const ok = await Promise.race([
    img.decode().then(
      () => true,
      () => false,
    ),
    delay(5_000).then(() => false),
  ])
  if (!ok || img.naturalWidth === 0) return null
  return { width: img.naturalWidth, height: img.naturalHeight }
}

export const sessionAssets: AssetAccess = {
  put: putAsset,
  has: hasLocalAsset,
  get: getAssetBytes,
  naturalSize,
}

/** The executors' view of an editor session. */
export function createHostEnv(
  session: EditorSession,
  opts: { release?: () => Promise<void>; stage?: StageHost } = {},
): HostEnv {
  const { doc, store } = session
  const ctx = { doc, resolver: session.resolver }
  const stage = opts.stage ?? new StageHost()
  const openedAt = Date.now()
  const firstPage = () => getChildIds(doc, null)[0] ?? ''
  const env: HostEnv = {
    fileId: session.fileId,
    doc,
    resolver: session.resolver,
    headless: session.headless,
    geometry: new AgentGeometry(ctx, createDomMeasurer(ctx, stage)),
    index: new DocIndex(doc, (listener) => session.events.subscribe((batch) => listener(batch))),
    fileName: () => getDocName(doc) || session.file?.name || 'Untitled',
    currentPageId: () => {
      if (session.headless) return firstPage()
      const p = store.getState().pageId
      return session.tree.pages().includes(p) ? p : firstPage()
    },
    isViewing: (pageId) => !session.headless && store.getState().pageId === pageId,
    selection: () => (session.headless ? [] : store.getState().selection),
    tokenOrders: () => tokenOrders(doc),
    anchors: new Map(),
    assets: sessionAssets,
    setPage: (pageId) => {
      if (!session.headless) store.setState({ pageId, selection: [] })
    },
    age: () => Date.now() - openedAt,
    readOnly: async () => {
      if (store.getState().remoteId !== null && !session.fixture.enabled) {
        await waitFor(() => store.getState().self !== null, ROLE_WAIT_MS)
      }
      return store.getState().self?.role === 'viewer'
    },
    flush: () => session.persistence.flush(),
    resolvedStyles: createResolvedStylesProbe(ctx, stage),
  }
  if (opts.release) env.release = opts.release
  return env
}

export interface HostRuntime {
  readonly env: HostEnv
  readonly dispatcher: Dispatcher
  dispose(): void
}

export function createHostRuntime(
  session: EditorSession,
  opts: { release?: () => Promise<void> } = {},
): HostRuntime {
  const stage = new StageHost()
  const env = createHostEnv(session, { ...opts, stage })
  const dispatcher = new Dispatcher(env, {
    beforeRun: async () => {
      if (!session.headless && session.canvas.current === null) {
        await waitFor(() => session.canvas.current !== null, CANVAS_WAIT_MS)
      }
      if (typeof document !== 'undefined' && document.fonts) {
        await Promise.race([document.fonts.ready, delay(2_000)])
      }
    },
  })
  return {
    env,
    dispatcher,
    dispose() {
      dispatcher.dispose()
      env.index.dispose()
      stage.dispose()
    },
  }
}
