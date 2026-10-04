import { memo, useEffect, useState } from 'react'
import { loadThumbnail, onThumbnailChanged, peekThumbnail } from './thumbnailCache'

/**
 * The canvas preview inside a file card. Files without a thumbnail (or still loading) show
 * the empty canvas — the placeholder the design shows for the Scratchpad card.
 *
 * A newer thumbnail (the file was edited, or its thumbnail was rewritten after the card
 * mounted) replaces the shown one once loaded, without flashing the empty canvas; the URL is
 * kept with its file id, so a card reused for another file never shows the wrong preview.
 */
export const FileThumbnail = memo(function FileThumbnail({
  fileId,
  version,
}: {
  fileId: string
  version: number
}) {
  const [shown, setShown] = useState(() => ({
    fileId,
    url: peekThumbnail(fileId, version) ?? null,
  }))
  const [revision, setRevision] = useState(0)

  useEffect(() => onThumbnailChanged((id) => id === fileId && setRevision((r) => r + 1)), [fileId])

  useEffect(() => {
    const cached = peekThumbnail(fileId, version)
    if (cached !== undefined) {
      setShown({ fileId, url: cached })
      return
    }
    let alive = true
    void loadThumbnail(fileId, version).then((url) => {
      if (alive) setShown({ fileId, url })
    })
    return () => {
      alive = false
    }
  }, [fileId, version, revision])

  const url = shown.fileId === fileId ? shown.url : null
  if (!url) return null
  return <img src={url} alt="" draggable={false} decoding="async" />
})
