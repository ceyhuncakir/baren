import { DESIGN_FILES } from '../fixtures/design'
import type { BarenBridge } from '../types/bridge'
import { FIXTURE_TOKEN, isDesignFixture } from './fixture'
import { createMockBridge, type MockBridge, type MockFileSeed } from './mockBridge'

const real: BarenBridge | undefined = typeof window === 'undefined' ? undefined : window.baren

/** True when running without Electron (browser dev, Playwright): the bridge is in-memory. */
export const isMockBridge: boolean = real === undefined

/** The files from artboard 01, timestamped relative to now. Thumbnails load on demand. */
function designFileSeeds(now: number): MockFileSeed[] {
  return DESIGN_FILES.map((f) => {
    const key = f.thumbnail
    return {
      id: f.id,
      name: f.name,
      createdAt: now - f.createdAgo,
      updatedAt: now - f.editedAgo,
      thumbnail: key
        ? () => import('../fixtures/thumbnails').then((m) => m.loadFixtureThumbnail(key))
        : undefined,
    }
  })
}

function sessionStore(): Storage | undefined {
  try {
    return window.sessionStorage
  } catch {
    return undefined
  }
}

/** `?theme=` given explicitly (dark-theme visual tests); otherwise fixtures are light. */
function hasThemeParam(): boolean {
  try {
    return new URLSearchParams(window.location.search).has('theme')
  } catch {
    return false
  }
}

function createBrowserBridge(): MockBridge {
  return createMockBridge({
    files: designFileSeeds(Date.now()),
    // Fixture mode always starts signed in; browser dev keeps the token across reloads.
    token: isDesignFixture ? FIXTURE_TOKEN : undefined,
    tokenStore: isDesignFixture ? undefined : sessionStore(),
    version: isDesignFixture ? '0.1.0' : undefined,
    // Artboard 17 shows "Light" selected; the mock otherwise reads ?theme= (default system).
    theme: isDesignFixture && !hasThemeParam() ? 'light' : undefined,
    externalLinks: isDesignFixture ? 'record' : 'open',
  })
}

/** The desktop bridge: `window.baren` inside Electron, otherwise the in-memory mock. */
export const bridge: BarenBridge = real ?? createBrowserBridge()

/** Mock-only controls (deep links, maximize, recorded URLs); null inside Electron. */
export const mockControls: MockBridge['mock'] | null =
  real === undefined ? (bridge as MockBridge).mock : null
