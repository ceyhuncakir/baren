import { describe, expect, it } from 'vitest'
import { readFill } from './effects'
import {
  TRANSPARENT_PIXEL,
  coverSize,
  imageFillValue,
  imageModeOf,
  imageModePatch,
  imageOpacityOf,
  imageOpacityPatch,
  naturalSizePatch,
  objectFitOf,
  readImageFill,
  setImageFillPatch,
} from './imageFill'

const A = 'a'.repeat(64)
const B = 'b'.repeat(64)
const url = (h: string) => `url("baren-asset://${h}")`

describe('image fill values', () => {
  it('encodes opacity as a cross-fade with a transparent pixel', () => {
    expect(imageFillValue(A)).toBe(url(A))
    expect(imageFillValue(A, 1)).toBe(url(A))
    const v = imageFillValue(A, 0.75)
    expect(v).toBe(`-webkit-cross-fade(${url(A)}, url("${TRANSPARENT_PIXEL}"), 25%)`)
    expect(imageOpacityOf(v)).toBe(0.75)
    expect(imageOpacityOf(url(A))).toBe(1)
    // Browsers serialise the percentage as a number.
    expect(imageOpacityOf(`-webkit-cross-fade(${url(A)}, url("x"), 0.4)`)).toBeCloseTo(0.6)
    // Still a fill the rest of the inspector recognises as an image.
    expect(readFill({ backgroundImage: v }, 'rect')?.kind).toBe('image')
  })

  it('reads the mode from background size and repeat', () => {
    expect(imageModeOf({ backgroundSize: 'cover' })).toBe('fill')
    expect(imageModeOf({ backgroundSize: 'contain', backgroundRepeat: 'no-repeat' })).toBe('fit')
    expect(imageModeOf({ backgroundSize: '320px 160px', backgroundRepeat: 'no-repeat' })).toBe(
      'crop',
    )
    expect(imageModeOf({ backgroundSize: '64px 64px', backgroundRepeat: 'repeat' })).toBe('tile')
  })

  it('reads visible and hidden image fills', () => {
    expect(
      readImageFill({ backgroundImage: imageFillValue(A, 0.5), backgroundSize: 'cover' }),
    ).toEqual({
      assetId: A,
      mode: 'fill',
      opacity: 0.5,
      hidden: false,
    })
    expect(readImageFill({ '--hidden-backgroundImage': url(B) })).toMatchObject({
      assetId: B,
      hidden: true,
    })
    expect(readImageFill({ backgroundImage: 'linear-gradient(red, blue)' })).toBeNull()
    expect(readImageFill({ backgroundColor: '#fff' })).toBeNull()
  })

  it('builds mode patches (Crop keeps the cover size, Tile the natural size)', () => {
    expect(imageModePatch('fill', null, null)).toEqual({
      backgroundSize: 'cover',
      backgroundPosition: 'center',
      backgroundRepeat: 'no-repeat',
    })
    expect(coverSize({ width: 2400, height: 1200 }, { width: 1280, height: 640 })).toEqual({
      width: 1280,
      height: 640,
    })
    expect(
      imageModePatch('crop', { width: 2400, height: 1200 }, { width: 1000, height: 1000 }),
    ).toMatchObject({ backgroundSize: '2000px 1000px', backgroundRepeat: 'no-repeat' })
    expect(imageModePatch('tile', { width: 64, height: 32 }, null)).toEqual({
      backgroundSize: '64px 32px',
      backgroundPosition: 'left top',
      backgroundRepeat: 'repeat',
    })
  })

  it('replaces fills keeping mode, opacity and hidden state', () => {
    const styles = {
      backgroundImage: imageFillValue(A, 0.5),
      backgroundSize: 'contain',
      backgroundRepeat: 'no-repeat',
    }
    expect(setImageFillPatch(styles, B)).toMatchObject({
      backgroundImage: imageFillValue(B, 0.5),
      backgroundSize: 'contain',
      backgroundColor: null,
    })
    const hidden = setImageFillPatch({ '--hidden-backgroundImage': url(A) }, B)
    expect(hidden['backgroundImage']).toBeNull()
    expect(hidden['--hidden-backgroundImage']).toBe(url(B))
    // From a solid fill: Fill mode, full opacity.
    expect(setImageFillPatch({ backgroundColor: '#FFF' }, A)).toMatchObject({
      backgroundImage: url(A),
      backgroundColor: null,
      backgroundSize: 'cover',
    })
  })

  it('changes opacity only for asset image fills', () => {
    expect(imageOpacityPatch({ backgroundImage: url(A) }, 0.3)).toEqual({
      backgroundImage: imageFillValue(A, 0.3),
    })
    expect(imageOpacityPatch({ backgroundImage: imageFillValue(A, 0.3) }, 1)).toEqual({
      backgroundImage: url(A),
    })
    expect(imageOpacityPatch({ backgroundColor: 'red' }, 0.3)).toBeNull()
  })
})

describe('image layers', () => {
  it('maps object-fit and natural size', () => {
    expect(objectFitOf({ objectFit: 'cover' })).toBe('cover')
    expect(objectFitOf({})).toBe('fill')
    expect(naturalSizePatch({ width: 2400.4, height: 1200 })).toEqual({ width: 2400, height: 1200 })
  })
})
