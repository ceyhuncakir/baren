import { createEmptyDoc, createNode, getChildIds, getNode, transact } from '@baren/schema'
import { describe, expect, it } from 'vitest'
import {
  PAGE_MAX_SIDE,
  clampInto,
  fitWithin,
  flowLayout,
  insertPlaced,
  isAcceptedFile,
  layerName,
  placeAt,
  type PreparedImage,
} from './insert'
import { imageSizeFromBytes } from './imageInfo'

describe('insert sizing math', () => {
  it('scales down to fit, never up, keeping the aspect ratio', () => {
    expect(fitWithin({ width: 2400, height: 1200 }, { width: 1440, height: 900 })).toEqual({
      width: 1440,
      height: 720,
    })
    expect(fitWithin({ width: 1000, height: 3000 }, { width: 1440, height: 900 })).toEqual({
      width: 300,
      height: 900,
    })
    expect(fitWithin({ width: 200, height: 100 }, { width: 1440, height: 900 })).toEqual({
      width: 200,
      height: 100,
    })
  })

  it('lays several images out in rows', () => {
    const l = flowLayout(
      [
        { width: 100, height: 50 },
        { width: 100, height: 80 },
        { width: 100, height: 40 },
      ],
      230,
      20,
    )
    expect(l.offsets).toEqual([
      { x: 0, y: 0 },
      { x: 120, y: 0 },
      { x: 0, y: 100 },
    ])
    expect(l.size).toEqual({ width: 220, height: 140 })
  })

  it('keeps a group inside the artboard', () => {
    const bounds = { x: 0, y: 0, width: 1440, height: 900 }
    expect(clampInto({ x: 1400, y: -20, width: 100, height: 100 }, bounds)).toEqual({
      x: 1340,
      y: 0,
      width: 100,
      height: 100,
    })
    // Larger than the artboard: the top-left corner wins.
    expect(clampInto({ x: -50, y: -50, width: 2000, height: 100 }, bounds).x).toBe(0)
  })

  it('centres drops on the point, fits them to the artboard and clamps them inside', () => {
    const board = { x: 100, y: 100, width: 1440, height: 900 }
    const [r] = placeAt({ x: 200, y: 150 }, [{ width: 2400, height: 1200 }], board)
    expect(r).toEqual({ x: 100, y: 100, width: 1440, height: 720 })
    const [a, b] = placeAt(
      { x: 800, y: 500 },
      [
        { width: 400, height: 300 },
        { width: 200, height: 300 },
      ],
      board,
    )
    expect(a).toEqual({ x: 490, y: 350, width: 400, height: 300 })
    expect(b).toEqual({ x: 910, y: 350, width: 200, height: 300 })
    // On the page the long side is capped.
    const [p] = placeAt({ x: 0, y: 0 }, [{ width: 6000, height: 3000 }], null)
    expect(p?.width).toBe(PAGE_MAX_SIDE)
    expect(p).toEqual({ x: -600, y: -300, width: 1200, height: 600 })
  })

  it('names layers after files and accepts image types', () => {
    expect(layerName('dolomites-dawn.jpg')).toBe('dolomites-dawn')
    expect(layerName(undefined)).toBe('Image')
    expect(layerName('.png', 'Vector')).toBe('Vector')
    expect(isAcceptedFile({ type: 'image/png' })).toBe(true)
    expect(isAcceptedFile({ type: 'image/svg+xml' })).toBe(true)
    expect(isAcceptedFile({ type: 'image/tiff' })).toBe(false)
    expect(isAcceptedFile({ type: '', name: 'photo.JPEG' })).toBe(true)
    expect(isAcceptedFile({ type: 'text/plain', name: 'a.png' })).toBe(false)
  })
})

describe('insertPlaced', () => {
  it('creates image and svg layers in one undoable commit, in flow order', () => {
    const doc = createEmptyDoc('Doc')
    const page = getChildIds(doc, null)[0] as string
    let board = ''
    transact(doc, () => {
      board = createNode(doc, {
        type: 'frame',
        parentId: page,
        styles: { display: 'flex', width: 400, height: 300 },
      })
      createNode(doc, { type: 'rect', parentId: board })
    })
    const images: PreparedImage[] = [
      {
        kind: 'image',
        name: 'photo',
        assetId: 'a'.repeat(64),
        size: { width: 10, height: 10 },
        fileName: 'photo.png',
      },
      { kind: 'svg', name: 'icon', markup: '<svg/>', size: { width: 24, height: 24 } },
    ]
    const ids = insertPlaced(
      doc,
      {
        parentId: board,
        place: (r) => ({ styles: { width: r.width, height: r.height, flexShrink: 0 }, index: 0 }),
      },
      images.map((image) => ({ image, rect: { x: 0, y: 0, ...image.size } })),
    )
    expect(getChildIds(doc, board)).toEqual([ids[0], ids[1], expect.any(String)])
    const img = getNode(doc, ids[0] as string)
    expect(img).toMatchObject({
      type: 'image',
      name: 'photo',
      assetId: 'a'.repeat(64),
      assetName: 'photo.png',
      styles: { width: 10, height: 10, flexShrink: 0, objectFit: 'cover' },
    })
    expect(getNode(doc, ids[1] as string)).toMatchObject({ type: 'svg', svg: '<svg/>' })
  })
})

describe('image header sizes', () => {
  const png = (w: number, h: number) => {
    const b = new Uint8Array(33)
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
    new DataView(b.buffer).setUint32(16, w)
    new DataView(b.buffer).setUint32(20, h)
    return b
  }

  it('reads PNG, GIF and WebP headers', () => {
    expect(imageSizeFromBytes(png(2400, 1200))).toEqual({ width: 2400, height: 1200 })
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x2c, 0x01, 0x96, 0x00])
    expect(imageSizeFromBytes(gif)).toEqual({ width: 300, height: 150 })
    const webp = new Uint8Array(30)
    webp.set(
      [...'RIFF'].map((c) => c.charCodeAt(0)),
      0,
    )
    webp.set(
      [...'WEBPVP8X'].map((c) => c.charCodeAt(0)),
      8,
    )
    webp.set([0x7f, 0x07, 0x00, 0x3f, 0x02, 0x00], 24) // 1920 × 576
    expect(imageSizeFromBytes(webp)).toEqual({ width: 1920, height: 576 })
    expect(imageSizeFromBytes(new Uint8Array([1, 2, 3]))).toBeNull()
  })

  it('reads JPEG frames and applies EXIF rotation', () => {
    const exif = (orientation: number) => [
      0xff,
      0xe1,
      0x00,
      0x22,
      ...[...'Exif'].map((c) => c.charCodeAt(0)),
      0,
      0,
      0x4d,
      0x4d,
      0x00,
      0x2a,
      0x00,
      0x00,
      0x00,
      0x08, // big-endian TIFF, IFD at 8
      0x00,
      0x01, // one entry
      0x01,
      0x12,
      0x00,
      0x03,
      0x00,
      0x00,
      0x00,
      0x01,
      0x00,
      orientation,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
    ]
    const sof = [
      0xff, 0xc0, 0x00, 0x11, 0x08, 0x04, 0xb0, 0x09, 0x60, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]
    const jpeg = (o: number | null) =>
      new Uint8Array([0xff, 0xd8, ...(o === null ? [] : exif(o)), ...sof, 0xff, 0xd9])
    expect(imageSizeFromBytes(jpeg(null))).toEqual({ width: 2400, height: 1200 })
    expect(imageSizeFromBytes(jpeg(1))).toEqual({ width: 2400, height: 1200 })
    expect(imageSizeFromBytes(jpeg(6))).toEqual({ width: 1200, height: 2400 })
  })

  it('reads the AVIF ispe box', () => {
    const b = new Uint8Array(64)
    b.set(
      [...'ftypavif'].map((c) => c.charCodeAt(0)),
      4,
    )
    b.set(
      [...'ispe'].map((c) => c.charCodeAt(0)),
      32,
    )
    new DataView(b.buffer).setUint32(40, 800)
    new DataView(b.buffer).setUint32(44, 600)
    expect(imageSizeFromBytes(b)).toEqual({ width: 800, height: 600 })
  })
})
