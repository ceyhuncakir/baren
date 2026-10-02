/**
 * The open-file session shared by every editor component: the Loro doc, its change fan-out
 * and caches, the UI store and a handle to the canvas controller. Created once per file by
 * `EditorRoot`; components read it through `useEditor()` and subscribe narrowly.
 */
import type { CanvasController } from '@baren/canvas'
import type { ComponentResolver, DesignNode, Token } from '@baren/schema'
import type { LoroDoc } from 'loro-crdt'
import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import { useStore } from 'zustand'
import type { AgentPresenceStore } from '../../agent/presence'
import { bridge } from '../../lib/bridge'
import type { FixtureMode } from '../lib/env'
import type { Team } from '@baren/sync-client/api'
import type { AssetSync } from '../collab/assetSync'
import type { PresenceRelay } from '../collab/presence'
import type { EditorActions } from '../commands/actions'
import type { LayerTree } from '../model/layerTree'
import {
  ComponentsWatcher,
  DocNameWatcher,
  NodesWatcher,
  TokensWatcher,
  type ComponentsSnapshot,
  type DocEvents,
  type NodesSnapshot,
} from './docEvents'
import type { Persistence } from './persistence'
import type { EditorState, EditorStore } from './store'

export type FileMeta = Awaited<ReturnType<typeof bridge.files.list>>[number]

export interface InitialViewport {
  x: number
  y: number
  zoom: number
}

export interface EditorSession {
  fileId: string
  doc: LoroDoc
  events: DocEvents
  /** The session's component resolver (instances, virtual ids); `events.resolver`. */
  resolver: ComponentResolver
  tree: LayerTree
  /** Live mains and instance counts (Components panel, component picker). */
  components: ComponentsWatcher
  tokens: TokensWatcher
  docName: DocNameWatcher
  store: EditorStore
  /** Set by the canvas once mounted; null before and after. */
  canvas: { current: CanvasController | null }
  /** Canvas container element (thumbnails, focus management). */
  canvasEl: { current: HTMLElement | null }
  fixture: FixtureMode
  file: FileMeta | null
  persistence: Persistence
  initialViewports: Record<string, InitialViewport>
  /** Menu/shortcut actions on the selection. */
  actions: EditorActions
  /** Presence callbacks (no-ops until a live connection attaches). */
  presence: PresenceRelay
  /** Asset uploads/downloads for shared files (idle while the file is local). */
  assets: AssetSync
  /** Teams of the signed-in user (filled by useCollaboration). */
  teams: Team[]
  /** Remember the viewport of a page (restored when the file reopens). */
  rememberViewport(pageId: string, v: InitialViewport): void
  /** Leave the editor (flushes and captures the thumbnail first). */
  exit(): void
  /** A hidden agent host (no user, no window chrome; Phase 4 contract §11.3). */
  readonly headless: boolean
  /** MCP agents in this file: local (this app) and relayed by collaborators (§10.2). */
  readonly agents: AgentPresenceStore
}

const EditorContext = createContext<EditorSession | null>(null)

export function EditorProvider({
  session,
  children,
}: {
  session: EditorSession
  children: ReactNode
}) {
  return <EditorContext.Provider value={session}>{children}</EditorContext.Provider>
}

export function useEditor(): EditorSession {
  const session = useContext(EditorContext)
  if (!session) throw new Error('useEditor() outside <EditorProvider>')
  return session
}

/** Subscribe to one slice of the UI store (re-renders when the selected value changes). */
export function useEditorState<T>(selector: (s: EditorState) => T): T {
  return useStore(useEditor().store, selector)
}

/** Re-render when the layer tree cache changes (structure, names, flags, icons). */
export function useLayerTreeVersion(): number {
  const { tree } = useEditor()
  return useSyncExternalStore(
    (cb) => tree.subscribe(cb),
    () => tree.version,
    () => tree.version,
  )
}

export function useTokens(): Record<string, Token> {
  const { tokens } = useEditor()
  return useSyncExternalStore(tokens.subscribe, tokens.getSnapshot, tokens.getSnapshot)
}

/** Theme-panel positions of tokens (changes together with the token map). */
export function useTokenOrders(): Record<string, number> {
  const { tokens } = useEditor()
  return useSyncExternalStore(tokens.subscribe, tokens.getOrders, tokens.getOrders)
}

export function useComponents(): ComponentsSnapshot {
  const { components } = useEditor()
  return useSyncExternalStore(components.subscribe, components.getSnapshot, components.getSnapshot)
}

export function useDocName(): string {
  const { docName } = useEditor()
  return useSyncExternalStore(docName.subscribe, docName.getSnapshot, docName.getSnapshot)
}

const EMPTY: NodesSnapshot = { nodes: [], parents: [] }

/** Live snapshots of `ids` (and their parents); re-reads only when a batch touches them. */
export function useNodes(ids: readonly string[]): NodesSnapshot {
  const { events } = useEditor()
  const key = ids.join('|')
  const watcher = useMemo(
    () => (ids.length > 0 ? new NodesWatcher(events, ids) : null),
    [events, key],
  )
  return useSyncExternalStore(
    watcher ? watcher.subscribe : noopSubscribe,
    watcher ? watcher.getSnapshot : emptySnapshot,
    watcher ? watcher.getSnapshot : emptySnapshot,
  )
}

export function useSelectedNodes(): NodesSnapshot {
  return useNodes(useEditorState((s) => s.selection))
}

const noopSubscribe = () => () => undefined
const emptySnapshot = () => EMPTY

export function createWatchers(events: DocEvents) {
  return {
    tokens: new TokensWatcher(events),
    docName: new DocNameWatcher(events),
    components: new ComponentsWatcher(events),
  }
}

export type { DesignNode }
