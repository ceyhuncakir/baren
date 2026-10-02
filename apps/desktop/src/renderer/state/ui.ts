/** UI-only state shared across screens (never document state). */
import { create } from 'zustand'
import { readJson, readString, writeJson, writeString } from '../lib/storage'

export type ViewMode = 'grid' | 'list'
export type PromoCardId = 'invite' | 'agents'

export type AppDialog =
  | { kind: 'invite' }
  | { kind: 'createTeam' }
  | { kind: 'shortcuts' }
  | { kind: 'preferences' }
  | { kind: 'changePassword' }
  /** Connect your agent (34): the MCP server's setup, opened from the editor, home and Preferences. */
  | { kind: 'mcp' }
  | null

export interface UiState {
  search: string
  viewMode: ViewMode
  dismissed: Partial<Record<PromoCardId, true>>
  dialog: AppDialog
  setSearch(search: string): void
  setViewMode(mode: ViewMode): void
  dismissCard(id: PromoCardId): void
  openDialog(dialog: Exclude<AppDialog, null>): void
  closeDialog(): void
}

const isDismissed = (v: unknown): v is Partial<Record<PromoCardId, true>> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

export const useUi = create<UiState>()((set, get) => ({
  search: '',
  viewMode: readString('viewMode') === 'list' ? 'list' : 'grid',
  dismissed: readJson('dismissedCards', isDismissed) ?? {},
  dialog: null,
  setSearch(search) {
    set({ search })
  },
  setViewMode(viewMode) {
    writeString('viewMode', viewMode)
    set({ viewMode })
  },
  dismissCard(id) {
    const dismissed = { ...get().dismissed, [id]: true as const }
    writeJson('dismissedCards', dismissed)
    set({ dismissed })
  },
  openDialog(dialog) {
    set({ dialog })
  },
  closeDialog() {
    set({ dialog: null })
  },
}))

/* ---- Search field focus (Ctrl+F) without React state ---- */

let searchInput: HTMLInputElement | null = null

export function registerSearchInput(el: HTMLInputElement | null): void {
  searchInput = el
}

/** Focuses the sidebar search; false when no search field is on screen. */
export function focusSearch(): boolean {
  if (!searchInput || !searchInput.isConnected) return false
  searchInput.focus()
  searchInput.select()
  return true
}
