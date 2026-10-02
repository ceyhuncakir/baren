/** What one card in the grid/list shows (the Scratchpad may not exist yet). */
import type { ViewSelection } from '../state/fileViews'
import type { FileMeta } from '../types/bridge'

export type CardModel =
  | { kind: 'file'; key: string; file: FileMeta; scratchpad: boolean }
  | { kind: 'newScratchpad'; key: string }

export function toCards(selection: ViewSelection): CardModel[] {
  const cards: CardModel[] = []
  const pad = selection.scratchpad
  if (pad === 'missing') cards.push({ kind: 'newScratchpad', key: 'new-scratchpad' })
  else if (pad) cards.push({ kind: 'file', key: pad.id, file: pad, scratchpad: true })
  for (const file of selection.items)
    cards.push({ kind: 'file', key: file.id, file, scratchpad: false })
  return cards
}
