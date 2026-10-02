/**
 * Phase 3 fixture scenes (artboards 29–33), seeded with the schema's own helpers so the
 * documents are real: a rotated layer inside a group, vectors, main components with nested
 * instances and per-instance overrides. Values come from the artboards' mock
 * canvases (29 at 55 %, 30 at 200 %, 31–33 at 100 %).
 *
 *  - `rotation` (29): the image scene's landing page plus a "Launch sticker" group inside
 *    the Hero, whose rectangle and label are rotated 15°.
 *  - `pen` (30): "Logo — Mark" with two vectors, "Sun" and "Peak".
 *  - `components` (31), `picker` (32), `drop` (33): the "Component library" page with the
 *    Button / Badge mains and the "Pricing — Desktop" artboard whose plans are instances of
 *    "Card / Plan" (31, 32) or detached frames (33); the "Card / Plan" main and further
 *    instances live on another page.
 */
import {
  createComponent,
  createInstance,
  createNode,
  docGeometry,
  getChildIds,
  getNode,
  setNodeProps,
  setPropsAt,
  setStylesAt,
  setTextAt,
  transact,
  virtualId,
  type Styles,
  type VectorData,
  type VectorPoint,
} from '@baren/schema'
import type { LoroDoc } from 'loro-crdt'
import { createSpec, frame, group, rect, svg, text, vector, type NodeSpec } from './build'
import { COMPONENT_LIBRARY_PAGES, seedComponentLibrary } from './componentLibrary'
import { LANDING_ZOOM, seedLanding } from './landing'

export const PHASE3_SCENES = ['rotation', 'pen', 'components', 'picker', 'drop'] as const
export type Phase3Scene = (typeof PHASE3_SCENES)[number]

export function isPhase3Scene(scene: string | null): scene is Phase3Scene {
  return scene !== null && (PHASE3_SCENES as readonly string[]).includes(scene)
}

/** Deterministic keys for components, node keys and subpaths (mulberry32). */
function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const INK = '#14213D'
const z = (mock: number): number => Math.round((mock / LANDING_ZOOM) * 100) / 100

const inter = (size: number, line: number, color: string, extra: Styles = {}): Styles => ({
  fontFamily: 'Inter',
  fontSize: `${size}px`,
  lineHeight: `${line}px`,
  color,
  ...extra,
})

/** Display name: an instance without a name of its own shows its main's name. */
function displayName(doc: LoroDoc, id: string): string {
  const node = getNode(doc, id)
  if (!node) return ''
  if (node.type === 'instance' && node.name === '' && node.mainId) {
    return getNode(doc, node.mainId)?.name ?? ''
  }
  return node.name
}

function find(doc: LoroDoc, parent: string, name: string): string {
  const id = getChildIds(doc, parent).find((c) => displayName(doc, c) === name)
  if (!id) throw new Error(`fixture: no "${name}"`)
  return id
}

function pagesOf(doc: LoroDoc): string[] {
  return getChildIds(doc, null)
}

/** The three pages of the component library file (names only, plus `fill` per page). */
function seedPages(doc: LoroDoc, fill: ((page: string, index: number) => void)[]): string[] {
  const pages = pagesOf(doc)
  const ids: string[] = []
  COMPONENT_LIBRARY_PAGES.forEach((name, i) => {
    const existing = i === 0 ? pages[0] : undefined
    if (existing !== undefined) {
      setNodeProps(doc, existing, { name, background: '#EEEEEE' })
      ids.push(existing)
    } else {
      ids.push(createNode(doc, { type: 'page', parentId: null, name, background: '#EEEEEE' }))
    }
  })
  ids.forEach((id, i) => fill[i]?.(id, i))
  return ids
}

/** A plain artboard with a title (collapsed rows of the layer list). */
function plainBoard(name: string, left: number, width: number, height: number): NodeSpec {
  return frame(
    name,
    {
      left,
      top: 0,
      width,
      height,
      backgroundColor: '#FFFFFF',
      display: 'flex',
      flexDirection: 'column',
      gap: 16,
      paddingTop: 40,
      paddingLeft: 40,
      paddingRight: 40,
    },
    [text('Title', name, inter(20, 24, INK, { fontWeight: 600 }))],
  )
}

// ---------------------------------------------------------------------------
// 29 — Rotation & groups
// ---------------------------------------------------------------------------

/** Size of the sticker (unrotated), its rotation and its centre relative to the Hero frame. */
export const STICKER = { width: 304, height: 116, rotate: 15, cx: 1147.3, cy: 532.7 } as const

function stickerGroup(): NodeSpec {
  const { width: w, height: h, rotate, cx, cy } = STICKER
  const rad = (rotate * Math.PI) / 180
  const aabbW = Math.round((w * Math.cos(rad) + h * Math.sin(rad)) * 100) / 100
  const aabbH = Math.round((w * Math.sin(rad) + h * Math.cos(rad)) * 100) / 100
  const labelW = 220
  const labelH = z(20)
  const round = (n: number) => Math.round(n * 100) / 100
  return group(
    'Launch sticker',
    {
      position: 'absolute',
      left: round(cx - aabbW / 2),
      top: round(cy - aabbH / 2),
      width: aabbW,
      height: aabbH,
    },
    [
      rect('Sticker', {
        position: 'absolute',
        left: round((aabbW - w) / 2),
        top: round((aabbH - h) / 2),
        width: w,
        height: h,
        borderRadius: 16,
        backgroundColor: '#FFC857',
        rotate: `${rotate}deg`,
      }),
      text(
        'Label',
        'Free for 14 days',
        inter(z(16), labelH, INK, {
          fontWeight: 700,
          letterSpacing: '-0.02em',
          textAlign: 'center',
          position: 'absolute',
          left: round(aabbW / 2 - labelW / 2),
          top: round(aabbH / 2 - labelH / 2),
          width: labelW,
          height: labelH,
          rotate: `${rotate}deg`,
        }),
      ),
    ],
  )
}

export function seedRotationScene(doc: LoroDoc, heroAsset: string): void {
  seedComponentLibrary(doc, (d, page) => {
    seedLanding(d, page, heroAsset)
    const board = find(d, page, 'Landing — Desktop')
    const hero = find(d, board, 'Hero')
    setStylesAt(d, hero, { position: 'relative' })
    createSpec(d, stickerGroup(), hero)
  })
}

// ---------------------------------------------------------------------------
// 30 — Pen tool
// ---------------------------------------------------------------------------

/** "Logo — Mark" at 200 %: world (0, 0) at canvas (186, 170). */
export const PEN_VIEWPORT = { x: -93, y: -85, zoom: 2 }

const P = (x: number, y: number, extra: Partial<VectorPoint> = {}): VectorPoint => ({
  x,
  y,
  ...extra,
})

/** The peak: mock path ÷ 2 (200 %), relative to its box at (45, 65). */
export const PEAK: VectorData = {
  fillRule: 'nonzero',
  subpaths: [
    {
      id: 'peak0001',
      closed: true,
      points: [
        P(0, 135),
        P(57.5, 37.5),
        P(86, 76, { in: [-25, 6.5], out: [25, -6.5], mode: 'mirrored' }),
        P(125, 0, { out: [11, 40] }),
        P(170, 135, { in: [-10, -25] }),
      ],
    },
  ],
}

const K = 0.5523 * 17
/** The sun: a 34 px circle as four smooth points. */
export const SUN: VectorData = {
  fillRule: 'nonzero',
  subpaths: [
    {
      id: 'sun00001',
      closed: true,
      points: [
        P(17, 0, { in: [-K, 0], out: [K, 0], mode: 'mirrored' }),
        P(34, 17, { in: [0, -K], out: [0, K], mode: 'mirrored' }),
        P(17, 34, { in: [K, 0], out: [-K, 0], mode: 'mirrored' }),
        P(0, 17, { in: [0, K], out: [0, -K], mode: 'mirrored' }),
      ],
    },
  ],
}

export function seedPenScene(doc: LoroDoc): void {
  seedPages(doc, [
    (page) => void createSpec(doc, plainBoard('Overview', 0, 1440, 900), page),
    (page) => {
      createSpec(
        doc,
        frame(
          'Logo — Mark',
          { left: 0, top: 0, width: 260, height: 260, backgroundColor: '#FFFFFF' },
          [
            vector('Sun', SUN, {
              position: 'absolute',
              left: 63,
              top: 67,
              width: 34,
              height: 34,
              fill: '#FFC857',
              stroke: 'none',
            }),
            vector('Peak', PEAK, {
              position: 'absolute',
              left: 45,
              top: 65,
              width: 170,
              height: 135,
              fill: '#E8ECF4',
              stroke: INK,
              strokeWidth: 3,
              strokeLinecap: 'round',
              strokeLinejoin: 'round',
            }),
          ],
        ),
        page,
      )
      const mark = (name: string, left: number, width: number, height: number) =>
        createSpec(
          doc,
          frame(name, { left, top: 0, width, height, backgroundColor: '#FFFFFF' }, [
            svg(
              'Mark',
              `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M2 20 9 7l4 6 3-4 6 11Z" fill="${INK}"/></svg>`,
              { position: 'absolute', left: 20, top: 20, width: 48, height: 48 },
            ),
          ]),
          page,
        )
      mark('Logo — Lockup', 2000, 520, 200)
      mark('Logo — Mono', 2600, 260, 260)
      mark('App icon', 2940, 180, 180)
      mark('Favicon', 3200, 64, 64)
    },
    (page) => void createSpec(doc, plainBoard('Cloud posture', 0, 1200, 800), page),
  ])
}

// ---------------------------------------------------------------------------
// 31–33 — Components
// ---------------------------------------------------------------------------

/** Mains at world (0, 0) and the pricing artboard at (212, 0); 100 %, origin at (40, 170). */
export const COMPONENTS_VIEWPORT = { x: -40, y: -170, zoom: 1 }

const CHECK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5" fill="none" stroke="#2E9E6A" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`

function buttonSpec(name: string, label: string, primary: boolean): NodeSpec {
  return frame(
    name,
    {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: 168,
      height: 44,
      borderRadius: 10,
      flexShrink: 0,
      ...(primary
        ? { backgroundColor: INK }
        : { backgroundColor: '#FFFFFF', boxShadow: '#D5DAE3 0px 0px 0px 1px inset' }),
    },
    [text('Label', label, inter(14, 18, primary ? '#FFFFFF' : INK, { fontWeight: 500 }))],
  )
}

function badgeSpec(name: string, label: string): NodeSpec {
  return frame(
    name,
    {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      height: 24,
      paddingLeft: 10,
      paddingRight: 10,
      borderRadius: 12,
      backgroundColor: '#EEF2F8',
      flexShrink: 0,
    },
    [
      rect('Dot', {
        width: 6,
        height: 6,
        borderRadius: 3,
        backgroundColor: '#2E9E6A',
        flexShrink: 0,
      }),
      text('Label', label, inter(12, 16, '#33405A', { fontWeight: 500 })),
    ],
  )
}

interface PlanText {
  plan: string
  amount: string
  per: string
  features: [string, string, string]
}

const STARTER: PlanText = {
  plan: 'Starter',
  amount: '$0',
  per: '/ seat',
  features: ['1 cloud account', 'Daily drift scans', 'Email alerts'],
}
const TEAM: PlanText = {
  plan: 'Team',
  amount: '$24',
  per: '/ seat / month',
  features: ['Unlimited accounts', 'Real-time drift alerts', 'Slack and PagerDuty'],
}

const CARD_STYLES: Styles = {
  display: 'flex',
  flexDirection: 'column',
  gap: 18,
  width: 252,
  paddingTop: 22,
  paddingBottom: 22,
  paddingLeft: 22,
  paddingRight: 22,
  borderRadius: 14,
  backgroundColor: '#FFFFFF',
  boxShadow: '#E3E7EE 0px 0px 0px 1px inset',
  flexShrink: 0,
}

/** A plan card's children without its badge and button (inserted as instances). */
function cardChildren(t: PlanText): NodeSpec[] {
  return [
    frame(
      'Header',
      {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        height: 24,
        flexShrink: 0,
      },
      [text('Plan name', t.plan, inter(15, 20, INK, { fontWeight: 600 }))],
    ),
    frame('Price', { display: 'flex', alignItems: 'baseline', gap: 6 }, [
      text('Amount', t.amount, inter(34, 40, INK, { fontWeight: 600, letterSpacing: '-0.03em' })),
      text('Per', t.per, inter(13, 18, '#5B6478')),
    ]),
    frame(
      'Features',
      { display: 'flex', flexDirection: 'column', gap: 10 },
      t.features.map((f, i) =>
        frame(`Feature ${i + 1}`, { display: 'flex', alignItems: 'center', gap: 8 }, [
          svg('Check', CHECK, { width: 14, height: 14, flexShrink: 0 }),
          text('Label', f, inter(13, 18, '#33405A')),
        ]),
      ),
    ),
  ]
}

interface Mains {
  button: string
  secondary: string
  badge: string
  card: string
  input?: string
  nav?: string
}

function keyOf(doc: LoroDoc, id: string): string {
  const key = getNode(doc, id)?.componentKey
  if (!key) throw new Error('fixture: not a main')
  return key
}

function nodeKeyAt(doc: LoroDoc, parent: string, names: string[]): string {
  let id = parent
  for (const name of names) id = find(doc, id, name)
  const key = getNode(doc, id)?.nodeKey
  if (!key) throw new Error(`fixture: no node key for ${names.join('/')}`)
  return key
}

/** Instance overrides that turn the card main (Starter look) into the Team card. */
function overrideTeam(doc: LoroDoc, inst: string, mains: Mains): void {
  setStylesAt(doc, inst, {
    backgroundColor: '#F7F8FC',
    boxShadow: `${INK} 0px 0px 0px 1.5px inset`,
  })
  const text = (path: string[], value: string) =>
    setTextAt(doc, virtualId(inst, nodeKeyAt(doc, mains.card, path)), value)
  text(['Header', 'Plan name'], TEAM.plan)
  text(['Price', 'Amount'], TEAM.amount)
  text(['Price', 'Per'], TEAM.per)
  TEAM.features.forEach((f, i) => text(['Features', `Feature ${i + 1}`, 'Label'], f))
  // Nested instances: the badge shows "Popular", the button is green "Start free trial".
  const badgePath = nodeKeyAt(doc, mains.card, ['Header', 'Badge / New'])
  const badgeLabel = nodeKeyAt(doc, mains.badge, ['Label'])
  setPropsAt(doc, virtualId(inst, badgePath), { hidden: false })
  setTextAt(doc, virtualId(inst, `${badgePath}/${badgeLabel}`), 'Popular')
  const buttonPath = nodeKeyAt(doc, mains.card, ['Button / Primary'])
  const buttonLabel = nodeKeyAt(doc, mains.button, ['Label'])
  setStylesAt(doc, virtualId(inst, buttonPath), { backgroundColor: '#1F7A50' })
  setTextAt(doc, virtualId(inst, `${buttonPath}/${buttonLabel}`), 'Start free trial')
}

/** Starter: no badge, a secondary-looking "Start free" button. */
function overrideStarter(doc: LoroDoc, inst: string, mains: Mains): void {
  const badgePath = nodeKeyAt(doc, mains.card, ['Header', 'Badge / New'])
  setPropsAt(doc, virtualId(inst, badgePath), { hidden: true })
  const buttonPath = nodeKeyAt(doc, mains.card, ['Button / Primary'])
  const buttonLabel = nodeKeyAt(doc, mains.button, ['Label'])
  setStylesAt(doc, virtualId(inst, buttonPath), {
    backgroundColor: '#FFFFFF',
    boxShadow: '#D5DAE3 0px 0px 0px 1px inset',
  })
  setStylesAt(doc, virtualId(inst, `${buttonPath}/${buttonLabel}`), { color: INK })
  setTextAt(doc, virtualId(inst, `${buttonPath}/${buttonLabel}`), 'Start free')
}

export function seedComponentsScene(doc: LoroDoc, scene: 'components' | 'picker' | 'drop'): void {
  const random = seeded(31)
  const geo = docGeometry(doc)
  const opts = { origin: 'fixture:seed', random }
  seedPages(doc, [
    () => undefined,
    (page) => void createSpec(doc, plainBoard('Logo — Mark', 0, 260, 260), page),
    () => undefined,
  ])
  const [library, , other] = pagesOf(doc) as [string, string, string]

  // Mains on the component library page (top-level artboards).
  const top = (spec: NodeSpec, left: number, topY: number): string => {
    const id = createSpec(doc, { ...spec, styles: { ...spec.styles, left, top: topY } }, library)
    return createComponent(doc, [id], geo, opts) as string
  }
  const mains: Mains = {
    button: top(buttonSpec('Button / Primary', 'Get started', true), 0, 0),
    secondary: top(buttonSpec('Button / Secondary', 'Learn more', false), 0, 92),
    badge: top(badgeSpec('Badge / New', 'New'), 0, 184),
    card: '',
  }
  const keys = {
    button: keyOf(doc, mains.button),
    secondary: keyOf(doc, mains.secondary),
    badge: keyOf(doc, mains.badge),
  }

  // The card main on another page: header badge and button are nested instances.
  const cardId = createSpec(
    doc,
    frame('Card / Plan', { ...CARD_STYLES, left: 0, top: 0 }, cardChildren(STARTER)),
    other,
  )
  const header = find(doc, cardId, 'Header')
  createInstance(doc, { componentKey: keys.badge, parentId: header }, opts)
  createInstance(
    doc,
    { componentKey: keys.button, parentId: cardId, styles: { width: '100%' } },
    opts,
  )
  mains.card = createComponent(doc, [cardId], geo, opts) as string
  // The main shows its badge hidden (Starter); the Team instance shows it.
  setPropsAt(doc, find(doc, header, 'Badge / New'), { hidden: true })
  const cardKey = keyOf(doc, mains.card)

  if (scene === 'picker') {
    mains.input = createComponent(
      doc,
      [
        createSpec(
          doc,
          frame(
            'Input / Email',
            { display: 'flex', flexDirection: 'column', gap: 6, width: 280, left: 0, top: 600 },
            [
              text('Label', 'Email', inter(12, 16, INK, { fontWeight: 500 })),
              frame(
                'Field',
                {
                  display: 'flex',
                  alignItems: 'center',
                  height: 40,
                  paddingLeft: 12,
                  paddingRight: 12,
                  borderRadius: 8,
                  backgroundColor: '#FFFFFF',
                  boxShadow: '#D5DAE3 0px 0px 0px 1px inset',
                },
                [text('Placeholder', 'you@company.com', inter(13, 18, '#8A92A3'))],
              ),
            ],
          ),
          other,
        ),
      ],
      geo,
      opts,
    ) as string
    mains.nav = createComponent(
      doc,
      [
        createSpec(
          doc,
          frame(
            'Nav / Top bar',
            {
              display: 'flex',
              alignItems: 'center',
              gap: 16,
              width: 600,
              height: 44,
              paddingLeft: 16,
              paddingRight: 16,
              borderRadius: 8,
              backgroundColor: '#FFFFFF',
              boxShadow: '#E3E7EE 0px 0px 0px 1px inset',
              left: 0,
              top: 720,
            },
            [
              text('Brand', 'Summit', inter(14, 18, INK, { fontWeight: 600, flexGrow: 1 })),
              text('Link', 'Pricing', inter(12, 16, '#A3AAB8')),
              text('Link', 'Docs', inter(12, 16, '#A3AAB8')),
            ],
          ),
          other,
        ),
      ],
      geo,
      opts,
    ) as string
  }

  // Pricing — Desktop: heading and the two plans.
  const desktop = createSpec(
    doc,
    frame(
      'Pricing — Desktop',
      {
        left: 212,
        top: 0,
        width: 600,
        height: 454,
        backgroundColor: '#FFFFFF',
        display: 'flex',
        flexDirection: 'column',
        gap: 28,
        paddingTop: 40,
        paddingBottom: 44,
        paddingLeft: 40,
        paddingRight: 40,
      },
      [
        frame('Heading', { display: 'flex', flexDirection: 'column', gap: 8 }, [
          text(
            'Title',
            'Simple, per-seat pricing',
            inter(28, 34, INK, { fontWeight: 600, letterSpacing: '-0.025em' }),
          ),
          text('Subtitle', 'Start free. Upgrade when your team grows.', inter(14, 20, '#5B6478')),
        ]),
        frame('Plans', { display: 'flex', gap: 16 }, []),
      ],
    ),
    library,
  )
  const plans = find(doc, desktop, 'Plans')
  if (scene === 'drop') {
    // Detached cards (frames): the badge is dragged from Team's header into Starter.
    const card = (t: PlanText, team: boolean) => {
      const id = createSpec(
        doc,
        frame(
          t.plan,
          team
            ? {
                ...CARD_STYLES,
                backgroundColor: '#F7F8FC',
                boxShadow: `${INK} 0px 0px 0px 1.5px inset`,
              }
            : CARD_STYLES,
          cardChildren(t),
        ),
        plans,
      )
      const head = find(doc, id, 'Header')
      if (team) {
        const badge = createInstance(doc, { componentKey: keys.badge, parentId: head }, opts)
        setTextAt(doc, virtualId(badge, nodeKeyAt(doc, mains.badge, ['Label'])), 'Popular')
      }
      const button = createInstance(
        doc,
        {
          componentKey: team ? keys.button : keys.secondary,
          parentId: id,
          styles: { width: '100%' },
        },
        opts,
      )
      const label = nodeKeyAt(doc, team ? mains.button : mains.secondary, ['Label'])
      if (team) {
        setStylesAt(doc, button, { backgroundColor: '#1F7A50' })
        setTextAt(doc, virtualId(button, label), 'Start free trial')
      } else setTextAt(doc, virtualId(button, label), 'Start free')
    }
    card(STARTER, false)
    card(TEAM, true)
  } else {
    const starter = createInstance(
      doc,
      { componentKey: cardKey, parentId: plans, name: 'Starter' },
      opts,
    )
    overrideStarter(doc, starter, mains)
    const team = createInstance(doc, { componentKey: cardKey, parentId: plans, name: 'Team' }, opts)
    overrideTeam(doc, team, mains)
  }
  createSpec(doc, plainBoard('Pricing — Mobile', 900, 390, 844), library)

  // Further instances (the counts in the Components panel), on the other page.
  const filler = (key: string, n: number, y: number) => {
    for (let i = 0; i < n; i++) {
      createInstance(
        doc,
        { componentKey: key, parentId: other, styles: { left: 400 + i * 200, top: y } },
        opts,
      )
    }
  }
  if (scene === 'drop') filler(cardKey, 2, 0)
  // Button / Primary: 1 in the card main (+1 per detached card in 33).
  filler(keys.button, scene === 'drop' ? 2 : 3, 400)
  filler(keys.secondary, scene === 'drop' ? 1 : 2, 480)
  filler(keys.badge, scene === 'drop' ? 1 : 2, 560)
  if (mains.input) filler(keyOf(doc, mains.input), 1, 640)
  if (mains.nav) filler(keyOf(doc, mains.nav), 3, 820)
}

/** Ids the layer list shows expanded in a scene (nothing selected in 32). */
export function phase3Expanded(doc: LoroDoc, scene: Phase3Scene): string[] {
  if (scene !== 'picker') return []
  const library = pagesOf(doc)[0]
  if (library === undefined) return []
  const desktop = find(doc, library, 'Pricing — Desktop')
  const plans = find(doc, desktop, 'Plans')
  return [desktop, plans, find(doc, plans, 'Team')]
}

export function seedPhase3(doc: LoroDoc, scene: Phase3Scene, heroAsset: string | null): void {
  transact(
    doc,
    () => {
      switch (scene) {
        case 'rotation':
          if (heroAsset) seedRotationScene(doc, heroAsset)
          return
        case 'pen':
          return seedPenScene(doc)
        default:
          return seedComponentsScene(doc, scene)
      }
    },
    { origin: 'fixture:seed' },
  )
}
