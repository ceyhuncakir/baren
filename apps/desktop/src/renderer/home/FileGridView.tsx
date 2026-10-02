import { FILE_CARD_HEIGHT, FILE_GRID_GAP, FileCard, PencilIcon } from '@baren/ui'
import { useVirtualizer } from '@tanstack/react-virtual'
import { memo, useRef, type MouseEvent } from 'react'
import { formatEdited, useNow } from '../lib/relativeTime'
import { gridColumns } from '../state/fileViews'
import type { CardModel } from './fileCards'
import { FileThumbnail } from './FileThumbnail'
import css from './Files.module.css'
import { useContentWidth } from './useContentWidth'

const ROW = FILE_CARD_HEIGHT + FILE_GRID_GAP

export interface FileViewProps {
  cards: readonly CardModel[]
  /** Opens a card (file id, or null for the not-yet-created Scratchpad). */
  onOpen: (fileId: string | null) => void
  /** Context menu for a file at viewport coordinates. */
  onMenu: (fileId: string, x: number, y: number) => void
}

const FileGridCard = memo(function FileGridCard({
  card,
  now,
  onOpen,
}: {
  card: CardModel
  now: number
  onOpen: (fileId: string | null) => void
}) {
  if (card.kind === 'newScratchpad') {
    return (
      <FileCard
        title="Scratchpad"
        titleAccessory={<PencilIcon size={13} />}
        subtitle="Your permanent draft"
        onClick={() => onOpen(null)}
      />
    )
  }
  const { file, scratchpad } = card
  return (
    <FileCard
      data-file-id={file.id}
      title={file.name}
      titleAccessory={scratchpad ? <PencilIcon size={13} /> : undefined}
      subtitle={scratchpad ? 'Your permanent draft' : formatEdited(file.updatedAt, now)}
      thumbnail={<FileThumbnail fileId={file.id} version={file.updatedAt} />}
      onClick={() => onOpen(file.id)}
    />
  )
})

/** Opens the context menu for the card under the event (mouse or the keyboard menu key). */
export function menuFromEvent(e: MouseEvent, onMenu: FileViewProps['onMenu']): void {
  const target =
    e.target instanceof Element ? e.target.closest<HTMLElement>('[data-file-id]') : null
  const id = target?.dataset['fileId']
  if (!target || !id) return
  e.preventDefault()
  // Keyboard-initiated context menus report (0, 0): anchor to the card instead.
  if (e.clientX === 0 && e.clientY === 0) {
    const r = target.getBoundingClientRect()
    onMenu(id, r.left + 24, r.top + 24)
  } else {
    onMenu(id, e.clientX, e.clientY)
  }
}

/**
 * Recents/Files/Archive grid (artboard 01): 257×226 cards, 20px gaps, as many columns as fit
 * (4 at 1440px). Rows are virtualized, so thousands of files cost a few dozen DOM cards.
 */
export function FileGridView({ cards, onOpen, onMenu }: FileViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const width = useContentWidth(scrollRef)
  const cols = gridColumns(width)
  const rows = Math.ceil(cards.length / cols)
  const now = useNow()
  const virtualizer = useVirtualizer({
    count: rows,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW,
    overscan: 2,
    useFlushSync: false,
    initialRect: { width: 1088, height: 900 },
  })

  return (
    <div
      ref={scrollRef}
      className={css.scroll}
      onContextMenu={(e) => menuFromEvent(e, onMenu)}
      data-testid="file-grid"
    >
      <div className={css.gridInner} style={{ height: Math.max(0, rows * ROW - FILE_GRID_GAP) }}>
        {virtualizer.getVirtualItems().map((row) => (
          <div
            key={row.key}
            className={css.gridRow}
            style={{
              transform: `translateY(${row.start}px)`,
              gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
            }}
          >
            {cards.slice(row.index * cols, row.index * cols + cols).map((card) => (
              <FileGridCard key={card.key} card={card} now={now} onOpen={onOpen} />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
