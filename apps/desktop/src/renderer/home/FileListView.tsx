import { FileIcon, IconButton, MoreHorizontalIcon, PencilIcon } from '@baren/ui'
import { useVirtualizer } from '@tanstack/react-virtual'
import { memo, useRef } from 'react'
import { formatDate, formatRelative, useNow } from '../lib/relativeTime'
import { menuFromEvent, type FileViewProps } from './FileGridView'
import type { CardModel } from './fileCards'
import { FileThumbnail } from './FileThumbnail'
import css from './Files.module.css'

const ROW = 48
/** Sticky column header above the rows, inside the scroll container. */
const HEADER = 32

const FileRow = memo(function FileRow({
  card,
  now,
  onOpen,
  onMenu,
}: {
  card: CardModel
  now: number
  onOpen: FileViewProps['onOpen']
  onMenu: FileViewProps['onMenu']
}) {
  const file = card.kind === 'file' ? card.file : null
  const scratchpad = card.kind === 'newScratchpad' || (card.kind === 'file' && card.scratchpad)
  return (
    <div className={css.listRow} role="row" data-file-id={file?.id}>
      <button
        type="button"
        className={css.listMain}
        role="gridcell"
        onClick={() => onOpen(file?.id ?? null)}
      >
        <span className={css.listThumb} aria-hidden="true">
          {file ? (
            <FileThumbnail fileId={file.id} version={file.updatedAt} />
          ) : (
            <FileIcon size={14} />
          )}
        </span>
        <span className={css.listName}>{file?.name ?? 'Scratchpad'}</span>
        {scratchpad && <PencilIcon size={13} className={css.listAccessory} />}
      </button>
      <span className={css.listCell} role="gridcell">
        {scratchpad ? 'Your permanent draft' : file ? formatRelative(file.updatedAt, now) : ''}
      </span>
      <span className={css.listCell} role="gridcell">
        {file ? formatDate(file.createdAt) : '—'}
      </span>
      <span role="gridcell">
        {file && (
          <IconButton
            label={`More actions for ${file.name}`}
            size={28}
            width={32}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect()
              onMenu(file.id, r.left, r.bottom + 4)
            }}
          >
            <MoreHorizontalIcon size={16} />
          </IconButton>
        )}
      </span>
    </div>
  )
})

/** List alternative to the grid (view toggle in the page header). Rows are virtualized. */
export function FileListView({ cards, onOpen, onMenu }: FileViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const now = useNow()
  const virtualizer = useVirtualizer({
    count: cards.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW,
    overscan: 8,
    scrollMargin: HEADER,
    useFlushSync: false,
    initialRect: { width: 1088, height: 900 },
  })
  return (
    <div
      ref={scrollRef}
      className={css.scroll}
      onContextMenu={(e) => menuFromEvent(e, onMenu)}
      role="grid"
      aria-rowcount={cards.length}
    >
      <div className={css.listHeader} role="row">
        <span role="columnheader">Name</span>
        <span role="columnheader">Edited</span>
        <span role="columnheader">Created</span>
        <span />
      </div>
      <div className={css.listInner} style={{ height: cards.length * ROW }}>
        {virtualizer.getVirtualItems().map((item) => {
          const card = cards[item.index]
          if (!card) return null
          return (
            <div
              key={card.key}
              className={css.listSlot}
              style={{ transform: `translateY(${item.start - HEADER}px)` }}
            >
              <FileRow card={card} now={now} onOpen={onOpen} onMenu={onMenu} />
            </div>
          )
        })}
      </div>
    </div>
  )
}
