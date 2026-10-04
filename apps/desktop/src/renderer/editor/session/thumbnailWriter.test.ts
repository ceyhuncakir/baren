import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThumbnailWriter } from './thumbnailWriter'

function writer(has = true) {
  const save = vi.fn(async () => undefined)
  return { save, w: new ThumbnailWriter({ save, has: async () => has, settleMs: 1000 }) }
}

describe('ThumbnailWriter', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('writes once saves have been quiet for the settle time', async () => {
    const { save, w } = writer()
    w.saved()
    await vi.advanceTimersByTimeAsync(600)
    w.saved()
    await vi.advanceTimersByTimeAsync(600)
    expect(save).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(400)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('on close: writes edits not written yet, and nothing more afterwards', async () => {
    const { save, w } = writer()
    w.saved()
    await w.close()
    expect(save).toHaveBeenCalledTimes(1)
    w.saved()
    await vi.advanceTimersByTimeAsync(5000)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('on close without edits: writes only when the file has no thumbnail yet', async () => {
    const present = writer(true)
    await present.w.close()
    expect(present.save).not.toHaveBeenCalled()
    const missing = writer(false)
    await missing.w.close()
    expect(missing.save).toHaveBeenCalledTimes(1)
  })

  it('does not write again on close when the settled write covered the edits', async () => {
    const { save, w } = writer()
    w.saved()
    await vi.advanceTimersByTimeAsync(1000)
    expect(save).toHaveBeenCalledTimes(1)
    await w.close()
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('a failed write does not stop later ones', async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValue(undefined)
    const w = new ThumbnailWriter({ save, has: async () => true, settleMs: 1000 })
    w.saved()
    await vi.advanceTimersByTimeAsync(1000)
    w.saved()
    await w.close()
    expect(save).toHaveBeenCalledTimes(2)
  })
})
