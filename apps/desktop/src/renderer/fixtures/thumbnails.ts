/**
 * Thumbnail PNGs for the design fixture files: the canvas content shown in artboard 01
 * (247×164, the card's thumbnail box). Loaded on demand by the mock bridge only. Like real
 * thumbnails (editor/session/raster.ts) they are the artboards alone on a transparent ground,
 * so the card's --color-canvas well shows through (light 01 and dark D01 alike); they were
 * matted from the two references (01 over #EEEEEE, D01 over #141414).
 */
import cv from './thumbs/cv.png'
import dashboard from './thumbs/dashboard.png'
import darkmode from './thumbs/acme-darkmode.png'
import barenDesign from './thumbs/baren.png'
import acme from './thumbs/acme.png'
import landingPage from './thumbs/landing-page.png'
import logo from './thumbs/logo.png'

const URLS: Record<string, string> = {
  cv,
  dashboard,
  'baren-darkmode': darkmode,
  baren: barenDesign,
  acme,
  'landing-page': landingPage,
  logo,
}

export async function loadFixtureThumbnail(key: string): Promise<Uint8Array | null> {
  const url = URLS[key]
  if (!url) return null
  const res = await fetch(url)
  if (!res.ok) return null
  return new Uint8Array(await res.arrayBuffer())
}
