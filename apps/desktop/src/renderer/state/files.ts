/**
 * Local files (bridge.files), the recently-opened order and the scratchpad id. Mutations are
 * optimistic: the list updates first, the bridge call follows, and a failure reloads.
 */
import { create } from 'zustand'
import { DESIGN_RECENT_ORDER, DESIGN_SCRATCHPAD_ID } from '../fixtures/design'
import { bridge, isMockBridge } from '../lib/bridge'
import { isStringArray, readJson, readString, writeJson, writeString } from '../lib/storage'
import type { FileMeta } from '../types/bridge'
import { findScratchpad, SCRATCHPAD_NAME, touchRecent } from './fileViews'

export interface FilesState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  files: FileMeta[]
  mru: string[]
  scratchpadId: string | null

  load(): Promise<void>
  create(name?: string): Promise<FileMeta>
  /** Opens (creating if needed) the permanent draft; returns its id. */
  ensureScratchpad(): Promise<string>
  rename(id: string, name: string): Promise<void>
  setArchived(id: string, archived: boolean): Promise<void>
  remove(id: string): Promise<void>
  markOpened(id: string): void
  byId(id: string): FileMeta | undefined
}

const MRU_KEY = 'recents'
const SCRATCHPAD_KEY = 'scratchpad'

// The browser mock is seeded with the artboard-01 files; seed their opened order too.
const initialMru =
  readJson(MRU_KEY, isStringArray) ?? (isMockBridge ? [...DESIGN_RECENT_ORDER] : [])
const initialScratchpad = readString(SCRATCHPAD_KEY) ?? (isMockBridge ? DESIGN_SCRATCHPAD_ID : null)

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

export const useFiles = create<FilesState>()((set, get) => {
  let inflight: Promise<void> | null = null
  /** One more load after the running one, shared by the calls made while it runs. */
  let again: Promise<void> | null = null

  const patch = (id: string, change: Partial<FileMeta>) =>
    set({ files: get().files.map((f) => (f.id === id ? { ...f, ...change } : f)) })

  /** Runs a bridge mutation; on failure resyncs the list and rethrows. */
  const mutate = async (op: () => Promise<void>) => {
    try {
      await op()
    } catch (error) {
      await get().load()
      throw error
    }
  }

  return {
    status: 'idle',
    error: null,
    files: [],
    mru: initialMru,
    scratchpadId: initialScratchpad,

    load() {
      // The running load may have listed the files before the caller's change (an import, a
      // team pull): a caller gets a list taken after its call.
      if (inflight) {
        again ??= inflight.then(() => {
          again = null
          return get().load()
        })
        return again
      }
      if (get().status !== 'ready') set({ status: 'loading' })
      inflight = bridge.files
        .list()
        .then((files) => {
          const pad = findScratchpad(files, get().scratchpadId)
          if (pad && pad.id !== get().scratchpadId) writeString(SCRATCHPAD_KEY, pad.id)
          set({ files, status: 'ready', error: null, scratchpadId: pad?.id ?? null })
        })
        .catch((error: unknown) => set({ status: 'error', error: message(error) }))
        .finally(() => {
          inflight = null
        })
      return inflight
    },

    async create(name = 'Untitled') {
      const meta = await bridge.files.create(name)
      set({ files: [meta, ...get().files.filter((f) => f.id !== meta.id)] })
      return meta
    },

    async ensureScratchpad() {
      const existing = findScratchpad(get().files, get().scratchpadId)
      if (existing) return existing.id
      const meta = await get().create(SCRATCHPAD_NAME)
      writeString(SCRATCHPAD_KEY, meta.id)
      set({ scratchpadId: meta.id })
      return meta.id
    },

    async rename(id, name) {
      const trimmed = name.trim()
      if (!trimmed) return
      patch(id, { name: trimmed, updatedAt: Date.now() })
      await mutate(() => bridge.files.rename(id, trimmed))
    },

    async setArchived(id, archived) {
      patch(id, { archived, updatedAt: Date.now() })
      await mutate(() => bridge.files.archive(id, archived))
    },

    async remove(id) {
      set({ files: get().files.filter((f) => f.id !== id), mru: get().mru.filter((x) => x !== id) })
      writeJson(MRU_KEY, get().mru)
      await mutate(() => bridge.files.remove(id))
    },

    markOpened(id) {
      const mru = touchRecent(get().mru, id)
      writeJson(MRU_KEY, mru)
      set({ mru })
    },

    byId(id) {
      return get().files.find((f) => f.id === id)
    },
  }
})

/**
 * An MCP agent created or imported a file (main's `files:changed`): reload the list so Recents
 * and Files show it (Phase 4 contract §4.6). Only loads lists that were loaded before.
 */
try {
  bridge.files.onChanged(() => {
    if (useFiles.getState().status !== 'idle') void useFiles.getState().load()
  })
} catch {
  // A bridge without the event (older main): the list reloads on the next navigation.
}
