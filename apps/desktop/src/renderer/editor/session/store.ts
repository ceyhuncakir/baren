/**
 * UI-only editor state (one store per open file). Document state never lives here:
 * the selection, hover, zoom and history flags mirror the canvas controller; everything
 * else is panel/menu state. Components subscribe with narrow selectors.
 */
import { createStore, type StoreApi } from 'zustand/vanilla'
import type { PeerPresence, SyncStatus, WelcomeMessage } from '@baren/sync-client'
import type { EditorAgent } from '../../agent/presence'
import type { TokenGroupId } from '../model/tokens'

export type CanvasTool = 'select' | 'hand' | 'artboard' | 'rectangle' | 'text' | 'pen'
export type EditorTool = CanvasTool | 'insert' | 'component' | 'image' | 'generate'

export type PanelMode = 'design' | 'theme'

export interface ViewToggles {
  pixelGrid: boolean
  snapToPixel: boolean
  rulers: boolean
  outline: boolean
}

export interface Identity {
  userId: string | null
  name: string
  email: string | null
}

export interface ContextMenuState {
  x: number
  y: number
  /** Where the menu was opened (affects "Paste here" and wording). */
  source: 'canvas' | 'layers'
  /** World point for "Paste here" (canvas only). */
  world: { x: number; y: number } | null
}

export interface EditorState {
  mode: PanelMode
  leftPanelOpen: boolean
  pageId: string
  tool: EditorTool
  selection: readonly string[]
  hoveredId: string | null
  editingTextId: string | null
  /** Vector whose points are being edited on the canvas (30). */
  editingVectorId: string | null
  zoom: number
  canUndo: boolean
  canRedo: boolean
  renamingId: string | null
  expanded: ReadonlySet<string>
  pagesExpanded: boolean
  selectedToken: string | null
  tokenQuery: string
  collapsedGroups: ReadonlySet<TokenGroupId>
  viewToggles: ViewToggles
  contextMenu: ContextMenuState | null
  shareOpen: boolean
  zoomMenuOpen: boolean
  insertOpen: boolean
  /** Component picker popover of the tool rail (32). */
  componentPickerOpen: boolean
  /** Components section of the left panel (31). */
  componentsExpanded: boolean
  /** Layers header (shown with the Components section). */
  layersExpanded: boolean
  identity: Identity | null
  /** The signed-in account (or its absence) is known: `identity` and `session.teams` are set. */
  accountLoaded: boolean
  syncStatus: SyncStatus | 'local'
  /** Server file this document is linked to (`FileMeta.remoteId`); live sync runs while set. */
  remoteId: string | null
  peers: readonly PeerPresence[]
  self: WelcomeMessage | null
  /** The collaborator (user id) whose page and viewport this canvas follows (`collab/follow`). */
  following: string | null
  /** MCP agents in this file, local first (Phase 4 contract §10.2; `EditorSession.agents`). */
  agents: readonly EditorAgent[]
}

export type EditorStore = StoreApi<EditorState>

export function createEditorStore(
  init: Pick<EditorState, 'pageId'> & Partial<EditorState>,
): EditorStore {
  return createStore<EditorState>()(() => ({
    mode: 'design',
    leftPanelOpen: true,
    tool: 'select',
    selection: [],
    hoveredId: null,
    editingTextId: null,
    editingVectorId: null,
    zoom: 1,
    canUndo: false,
    canRedo: false,
    renamingId: null,
    expanded: new Set(),
    pagesExpanded: true,
    selectedToken: null,
    tokenQuery: '',
    collapsedGroups: new Set(['spacing', 'radius']),
    viewToggles: { pixelGrid: true, snapToPixel: true, rulers: false, outline: false },
    contextMenu: null,
    shareOpen: false,
    zoomMenuOpen: false,
    insertOpen: false,
    componentPickerOpen: false,
    componentsExpanded: true,
    layersExpanded: true,
    identity: null,
    accountLoaded: false,
    syncStatus: 'local',
    remoteId: null,
    peers: [],
    self: null,
    following: null,
    agents: [],
    ...init,
  }))
}

/** Shallow equality for string arrays (selection comparisons). */
export function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
