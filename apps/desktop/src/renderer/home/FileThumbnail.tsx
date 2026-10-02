import { memo, useEffect, useState } from 'react'
import { loadThumbnail, peekThumbnail } from './thumbnailCache'

/**
 * The canvas preview inside a file card. Files without a thumbnail (or still loading) show
 * the empty canvas — the placeholder the design shows for the Scratchpad card.
 */
export const FileThumbnail = memo(function FileThumbnail({
  fileId,
  version,
}: {
  fileId: string
  version: number
}) {
  const [url, setUrl] = useState<string | null | undefined>(() => peekThumbnail(fileId, version))

  useEffect(() => {
    const cached = peekThumbnail(fileId, version)
    setUrl(cached)
    if (cached !== undefined) return
    let alive = true
    void loadThumbnail(fileId, version).then((next) => {
      if (alive) setUrl(next)
    })
    return () => {
      alive = false
    }
  }, [fileId, version])

  if (!url) return null
  return <img src={url} alt="" draggable={false} decoding="async" />
})
