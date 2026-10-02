/**
 * Design-fixture seeding. With `?fixture=design` (browser + mock bridge only) the mock
 * bridge serves the files of artboard 01 as empty documents; the editor fills some of
 * them the first time they open, so visual tests are deterministic:
 *
 *  - `f-acme`         → the component library (artboards 05, 06, 08, 14, 15); with
 *                           `editorScene=image` its "Cloud posture" page holds the landing
 *                           page with an image fill (24)
 *  - `f-baren`  → stays empty (04, 16); with `editorScene=theme` it gets the
 *                           theme tokens and the "Theme preview" artboard (07)
 *  - `f-acme` + `editorScene=rotation|pen|components|picker|drop` → the Phase 3 scenes of
 *    artboards 29–33 (fixtures/phase3.ts)
 *  - any file + `editorScene=perf20k|perf50k` → a generated 20k/50k-node document
 *
 * Seeding happens before the canvas (and its UndoManager) exists, so it is not undoable,
 * and only when the document is still pristine, so it never overwrites edits. The initial
 * view (page + viewport) is derived from the document, so it also applies when the file
 * was seeded by an earlier open.
 */
import { generateBenchDoc, getChildIds, getDocName, getNode } from '@baren/schema'
import type { LoroDoc } from 'loro-crdt'
import {
  ARTBOARD_TOP,
  COMPONENT_LIBRARY_PAGES,
  OVERVIEW_ZOOM,
  artboardLeft,
  isPristine,
  seedComponentLibrary,
  type SeedResult,
} from './componentLibrary'
import { LANDING_VIEWPORT, renderHeroPhoto, seedLanding } from './landing'
import {
  COMPONENTS_VIEWPORT,
  PEN_VIEWPORT,
  isPhase3Scene,
  phase3Expanded,
  seedPhase3,
} from './phase3'
import { seedThemePreview, THEME_PREVIEW_VIEWPORT } from './themePreview'

export const FIXTURE_FILE_IDS = {
  componentLibrary: 'f-acme',
  empty: 'f-baren',
} as const

/** Assets a scene's document references (stored through the bridge before seeding). */
export interface FixtureAssets {
  hero: string | null
}

/** Store the scene's images (async: they are encoded at runtime). */
export async function prepareFixtureAssets(
  scene: string | null,
  put: (bytes: Uint8Array, mime: string) => Promise<string>,
): Promise<FixtureAssets> {
  if (scene !== 'image' && scene !== 'rotation') return { hero: null }
  return { hero: await put(await renderHeroPhoto(), 'image/jpeg') }
}

export function seedFixture(
  doc: LoroDoc,
  fileId: string,
  scene: string | null,
  assets: FixtureAssets = { hero: null },
): void {
  if (!isPristine(doc)) return
  if (scene === 'perf20k' || scene === 'perf50k') {
    seedPerf(doc, scene === 'perf20k' ? 20_000 : 50_000)
    return
  }
  if (fileId === FIXTURE_FILE_IDS.componentLibrary && isPhase3Scene(scene)) {
    seedPhase3(doc, scene, assets.hero)
    return
  }
  if (fileId === FIXTURE_FILE_IDS.componentLibrary) {
    const hero = assets.hero
    if (scene === 'image' && hero)
      seedComponentLibrary(doc, (d, page) => seedLanding(d, page, hero))
    else seedComponentLibrary(doc)
  } else if (fileId === FIXTURE_FILE_IDS.empty && scene === 'theme') seedThemePreview(doc)
}

/** The initial page and viewport for a fixture file (null: use the defaults). */
export function fixtureView(doc: LoroDoc, fileId: string, scene: string | null): SeedResult | null {
  const pages = getChildIds(doc, null)
  const first = pages[0]
  if (first === undefined) return null
  if (fileId === FIXTURE_FILE_IDS.componentLibrary && isPhase3Scene(scene)) {
    if (scene === 'rotation') {
      const posture = pages.find((p) => getNode(doc, p)?.name === COMPONENT_LIBRARY_PAGES[2])
      return posture ? { pageId: posture, viewports: { [posture]: LANDING_VIEWPORT } } : null
    }
    if (scene === 'pen') {
      const logo = pages.find((p) => getNode(doc, p)?.name === COMPONENT_LIBRARY_PAGES[1])
      return logo ? { pageId: logo, viewports: { [logo]: PEN_VIEWPORT } } : null
    }
    return {
      pageId: first,
      viewports: { [first]: COMPONENTS_VIEWPORT },
      expanded: phase3Expanded(doc, scene),
    }
  }
  if (fileId === FIXTURE_FILE_IDS.componentLibrary && scene === 'image') {
    const posture = pages.find((p) => getNode(doc, p)?.name === COMPONENT_LIBRARY_PAGES[2])
    if (!posture) return null
    return { pageId: posture, viewports: { [posture]: LANDING_VIEWPORT } }
  }
  if (fileId === FIXTURE_FILE_IDS.componentLibrary && !scene) {
    const library = pages.find((p) => getNode(doc, p)?.name === COMPONENT_LIBRARY_PAGES[0])
    if (!library) return null
    return {
      pageId: library,
      viewports: {
        [library]: {
          x: artboardLeft(0) - 24 / OVERVIEW_ZOOM,
          y: ARTBOARD_TOP - 131 / OVERVIEW_ZOOM,
          zoom: OVERVIEW_ZOOM,
        },
      },
    }
  }
  if (fileId === FIXTURE_FILE_IDS.empty && scene === 'theme') {
    return { pageId: first, viewports: { [first]: THEME_PREVIEW_VIEWPORT } }
  }
  return null
}

/**
 * A large document for profiling the editor: the bench generator's layout imported into
 * the opened file (so its node ids live in this doc's history like any edit).
 */
function seedPerf(doc: LoroDoc, nodes: number): void {
  const perArtboard = 499
  const artboards = Math.round(nodes / (perArtboard + 1))
  const bench = generateBenchDoc({ artboards, nodesPerArtboard: perArtboard, seed: 7, peerId: 7 })
  // Import the bench history, then drop the original (empty) page.
  const original = getChildIds(doc, null)
  const name = getDocName(doc)
  doc.import(bench.export({ mode: 'snapshot' }))
  const tree = doc.getTree('nodes')
  for (const id of original) tree.delete(id as `${number}@${number}`)
  doc.getMap('meta').set('name', name)
  doc.commit({ origin: 'fixture:seed' })
}
