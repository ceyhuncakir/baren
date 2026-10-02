/**
 * Per-file editor preferences (expanded layers, current page, panel state, viewport per
 * page) kept in localStorage so reopening a file restores the view. Best effort only.
 */
import { isRecord, isStringArray, readPref, writePref } from '../lib/storage'
import type { InitialViewport } from './context'
import type { EditorStore, PanelMode } from './store'

export interface FilePrefs {
  expanded: string[]
  pageId: string | null
  leftPanelOpen: boolean
  mode: PanelMode
  viewports: Record<string, InitialViewport>
}

function isViewport(v: unknown): v is InitialViewport {
  return (
    isRecord(v) &&
    typeof v['x'] === 'number' &&
    typeof v['y'] === 'number' &&
    typeof v['zoom'] === 'number' &&
    Number.isFinite(v['x']) &&
    Number.isFinite(v['y']) &&
    v['zoom'] > 0
  )
}

function isPrefs(v: unknown): v is FilePrefs {
  if (!isRecord(v)) return false
  if (!isStringArray(v['expanded'])) return false
  if (v['pageId'] !== null && typeof v['pageId'] !== 'string') return false
  if (typeof v['leftPanelOpen'] !== 'boolean') return false
  if (v['mode'] !== 'design' && v['mode'] !== 'theme') return false
  const vps = v['viewports']
  return isRecord(vps) && Object.values(vps).every(isViewport)
}

const key = (fileId: string) => `file.${fileId}`

export function readFilePrefs(fileId: string): FilePrefs | null {
  return readPref(key(fileId), isPrefs)
}

/** Persist store changes (debounced) and viewports; returns a disposer that flushes. */
export function persistFilePrefs(
  fileId: string,
  store: EditorStore,
  initial: FilePrefs | null,
): { setViewport(pageId: string, v: InitialViewport): void; dispose(): void } {
  const viewports: Record<string, InitialViewport> = { ...(initial?.viewports ?? {}) }
  let timer: ReturnType<typeof setTimeout> | null = null
  const write = () => {
    timer = null
    const s = store.getState()
    writePref(key(fileId), {
      expanded: [...s.expanded].slice(0, 5000),
      pageId: s.pageId,
      leftPanelOpen: s.leftPanelOpen,
      mode: s.mode,
      viewports,
    } satisfies FilePrefs)
  }
  const schedule = () => {
    if (timer === null) timer = setTimeout(write, 500)
  }
  const unsubscribe = store.subscribe((s, prev) => {
    if (
      s.expanded !== prev.expanded ||
      s.pageId !== prev.pageId ||
      s.leftPanelOpen !== prev.leftPanelOpen ||
      s.mode !== prev.mode
    ) {
      schedule()
    }
  })
  return {
    setViewport(pageId, v) {
      viewports[pageId] = { x: v.x, y: v.y, zoom: v.zoom }
      schedule()
    },
    dispose() {
      unsubscribe()
      if (timer !== null) {
        clearTimeout(timer)
        write()
      }
    },
  }
}
