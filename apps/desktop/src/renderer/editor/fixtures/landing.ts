/**
 * The image scene (artboard 24 "Editor — Image fill"): the "Cloud posture" page holds a
 * "Summit" landing page whose hero is a rectangle with an image fill
 * (`dolomites-dawn.jpg`, 2400 × 1200). Values come from the artboard's mock board, which
 * is drawn at 55%: world px = mock px / 0.55.
 *
 * The hero photo is generated at fixture time (gradients + ridges from the same mock) and
 * stored through the bridge like any inserted image, so the fill goes through the real
 * asset path (bridge → blob URL resolver → canvas, inspector preview, natural size).
 */
import type { Styles } from '@baren/schema'
import type { LoroDoc } from 'loro-crdt'
import { frame, rect, svg, text, createSpec, type NodeSpec } from './build'

export const LANDING_ZOOM = 0.55
const z = (mock: number): number => Math.round((mock / LANDING_ZOOM) * 100) / 100

/** Canvas viewport of artboard 24: "Landing — Desktop" at container (50, 64), 55%. */
export const LANDING_VIEWPORT = { x: -z(50), y: -z(64), zoom: LANDING_ZOOM }

export const HERO_FILE_NAME = 'dolomites-dawn.jpg'
export const HERO_SIZE = { width: 2400, height: 1200 } as const

const INK = '#14213D'

const inter = (size: number, line: number, color: string, extra: Styles = {}): Styles => ({
  fontFamily: 'Inter',
  fontSize: `${z(size)}px`,
  lineHeight: `${z(line)}px`,
  color,
  ...extra,
})

const pill = (name: string, label: string, filled: boolean, height: number, pad: number) =>
  frame(
    name,
    {
      display: 'flex',
      alignItems: 'center',
      height: z(height),
      paddingLeft: z(pad),
      paddingRight: z(pad),
      borderRadius: z(height / 2),
      flexShrink: 0,
      ...(filled ? { backgroundColor: INK } : { boxShadow: `#D5DAE3 0px 0px 0px ${z(1)}px inset` }),
    },
    [text('Label', label, inter(8, 10, filled ? '#FFFFFF' : INK, { fontWeight: 500 }))],
  )

function nav(): NodeSpec {
  const link = (label: string) => text(label, label, inter(8, 10, '#4A5468'))
  return frame(
    'Nav',
    {
      display: 'flex',
      alignItems: 'center',
      gap: z(20),
      height: z(22),
      paddingLeft: z(44),
      paddingRight: z(44),
      flexShrink: 0,
    },
    [
      frame(
        'Logo',
        { display: 'flex', alignItems: 'center', gap: z(5), flexBasis: '0%', flexGrow: 1 },
        [
          svg(
            'Mark',
            `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M2 20 9 7l4 6 3-4 6 11Z" fill="${INK}"/></svg>`,
            { width: z(11), height: z(11), flexShrink: 0 },
          ),
          text(
            'Summit',
            'Summit',
            inter(10, 12, INK, { fontWeight: 600, letterSpacing: '-0.01em' }),
          ),
        ],
      ),
      link('Product'),
      link('Customers'),
      link('Pricing'),
      link('Docs'),
      pill('Start free', 'Start free', true, 20, 9),
      // The announcement pill sits above the headline; it is positioned against the
      // artboard so the layer tree keeps the artboard's Hero rows.
      frame(
        'Announcement',
        {
          position: 'absolute',
          left: z(44),
          top: z(90),
          width: z(704),
          display: 'flex',
          justifyContent: 'center',
        },
        [
          frame(
            'Badge',
            {
              display: 'flex',
              alignItems: 'center',
              gap: z(5),
              height: z(16),
              paddingLeft: z(8),
              paddingRight: z(8),
              borderRadius: z(8),
              backgroundColor: '#EEF2F8',
            },
            [
              rect('Dot', {
                width: z(4),
                height: z(4),
                borderRadius: z(2),
                backgroundColor: '#2E9E6A',
                flexShrink: 0,
              }),
              text(
                'Label',
                'New — drift alerts for every account',
                inter(7, 9, '#33405A', { fontWeight: 500 }),
              ),
            ],
          ),
        ],
      ),
    ],
  )
}

function hero(heroAsset: string): NodeSpec {
  const image: NodeSpec = {
    ...rect('Hero image', {
      width: 1280,
      height: 640,
      flexShrink: 0,
      marginTop: z(20),
      borderRadius: 12,
      backgroundImage: `url("baren-asset://${heroAsset}")`,
      backgroundSize: 'cover',
      backgroundPosition: 'center',
      backgroundRepeat: 'no-repeat',
    }),
    assetName: HERO_FILE_NAME,
  }
  return frame(
    'Hero',
    {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: z(10),
      paddingTop: z(46 + 16 + 10),
      paddingLeft: z(44),
      paddingRight: z(44),
      flexShrink: 0,
    },
    [
      text(
        'Headline',
        'Clear skies across every cloud account.',
        inter(35, 38, INK, {
          fontWeight: 600,
          letterSpacing: '-0.035em',
          textAlign: 'center',
          width: z(380),
        }),
      ),
      text(
        'Subhead',
        'Summit maps misconfigurations, exposed keys and drift across AWS, GCP and Azure — in minutes, not sprints.',
        inter(10, 15, '#5B6478', { textAlign: 'center', width: z(330) }),
      ),
      frame('CTA row', { display: 'flex', gap: z(6), paddingTop: z(6) }, [
        pill('Primary', 'Start free', true, 24, 12),
        pill('Secondary', 'Book a demo', false, 24, 12),
      ]),
      image,
    ],
  )
}

function logos(): NodeSpec {
  const brand = (name: string, weight: number, tracking: string) =>
    text(name, name, inter(12, 14, '#A3AAB8', { fontWeight: weight, letterSpacing: tracking }))
  return frame(
    'Logos',
    {
      display: 'flex',
      flexWrap: 'wrap',
      justifyContent: 'center',
      rowGap: z(12),
      paddingTop: z(52),
      paddingLeft: z(44),
      paddingRight: z(44),
      flexShrink: 0,
    },
    [
      text(
        'Eyebrow',
        'Trusted by platform teams at',
        inter(7, 9, '#8A92A3', {
          fontWeight: 500,
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          textAlign: 'center',
          width: '100%',
        }),
      ),
      frame('Row', { display: 'flex', alignItems: 'center', gap: z(44) }, [
        brand('Northwind', 700, '-0.02em'),
        brand('HALCYON', 600, '0.04em'),
        brand('lumen/ops', 700, '-0.03em'),
        brand('Tessellate', 600, '0em'),
        brand('Ardent', 700, '-0.01em'),
      ]),
    ],
  )
}

function footer(): NodeSpec {
  return frame(
    'Footer',
    {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginTop: 'auto',
      paddingTop: 48,
      paddingBottom: 48,
      paddingLeft: z(44),
      paddingRight: z(44),
      borderTop: '1px solid #E6E9EF',
      flexShrink: 0,
    },
    [
      text('Copyright', '© 2026 Summit Security', inter(8, 10, '#8A92A3')),
      text('Links', 'Privacy · Terms · Status', inter(8, 10, '#8A92A3')),
    ],
  )
}

function board(
  name: string,
  left: number,
  width: number,
  height: number,
  children: NodeSpec[] = [],
) {
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
      paddingTop: z(22),
      overflow: 'hidden',
    },
    children,
  )
}

/** The landing artboards of the image scene on `pageId` (inside the caller's commit). */
export function seedLanding(doc: LoroDoc, pageId: string, heroAsset: string): void {
  createSpec(
    doc,
    board('Landing — Desktop', 0, 1440, z(900), [nav(), hero(heroAsset), logos(), footer()]),
    pageId,
  )
  // Further artboards sit right of the visible area (collapsed layer rows in 24).
  const others: [string, number, number, string][] = [
    ['Landing — Mobile', 390, 844, 'Clear skies across every cloud account.'],
    ['Pricing', 1440, 1200, 'Simple pricing for every team'],
    ['Changelog', 1440, 1400, 'Changelog'],
    ['Sign up', 1440, 900, 'Create your Summit account'],
  ]
  let left = 1640
  for (const [name, width, height, title] of others) {
    createSpec(
      doc,
      frame(
        name,
        {
          left,
          top: 0,
          width,
          height,
          backgroundColor: '#FFFFFF',
          display: 'flex',
          flexDirection: 'column',
          gap: 24,
          paddingTop: 80,
          paddingLeft: 80,
          paddingRight: 80,
        },
        [
          text('Title', title, inter(24, 28, INK, { fontWeight: 600 })),
          text('Body', 'Summit keeps every cloud account in view.', inter(10, 15, '#5B6478')),
        ],
      ),
      pageId,
    )
    left += width + 200
  }
}

/**
 * The hero photo as JPEG bytes (2400 × 1200): dawn sky gradients and three ridge layers,
 * drawn from the mock's 704 × 352 geometry.
 */
export async function renderHeroPhoto(): Promise<Uint8Array> {
  const { width: W, height: H } = HERO_SIZE
  const canvas = new OffscreenCanvas(W, H)
  const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D
  const sky = ctx.createLinearGradient(0, 0, 0, H)
  for (const [at, color] of [
    [0, '#DDA595'],
    [0.22, '#EDBC9F'],
    [0.4, '#F6D4AE'],
    [0.5, '#EBC1A8'],
    [0.62, '#B79DAE'],
    [0.8, '#6E6F91'],
    [1, '#3A4262'],
  ] as const)
    sky.addColorStop(at, color)
  ctx.fillStyle = sky
  ctx.fillRect(0, 0, W, H)
  // circle farthest-corner at 63% 36%
  const cx = W * 0.63
  const cy = H * 0.36
  const r = Math.hypot(cx, H - cy)
  const sun = ctx.createRadialGradient(cx, cy, 0, cx, cy, r)
  sun.addColorStop(0, 'rgba(255, 248, 234, 1)')
  sun.addColorStop(0.026, 'rgba(255, 241, 214, 1)')
  sun.addColorStop(0.042, 'rgba(255, 224, 182, 0.75)')
  sun.addColorStop(0.26, 'rgba(255, 208, 164, 0)')
  ctx.fillStyle = sun
  ctx.fillRect(0, 0, W, H)
  ctx.scale(W / 704, H / 352)
  const ridges: [string, string][] = [
    [
      'M0 212 L40 198 L78 174 L104 182 L140 152 L168 162 L196 130 L222 144 L250 122 L282 148 L318 138 L352 162 L392 146 L430 170 L470 154 L512 172 L560 156 L604 178 L648 164 L704 184 V352 H0 Z',
      '#A592AD',
    ],
    [
      'M0 238 L36 224 L70 232 L112 198 L150 216 L190 190 L224 208 L262 184 L300 212 L340 202 L380 226 L424 200 L462 216 L500 188 L540 206 L584 180 L620 198 L660 188 L704 206 V352 H0 Z',
      '#62628A',
    ],
    [
      'M0 272 L50 252 L96 264 L140 238 L188 260 L236 248 L282 272 L330 258 L380 278 L430 256 L482 268 L530 246 L580 264 L628 252 L670 268 L704 260 V352 H0 Z',
      '#2C3252',
    ],
  ]
  for (const [d, fill] of ridges) {
    ctx.fillStyle = fill
    ctx.fill(new Path2D(d))
  }
  ctx.fillStyle = '#1D2238'
  ctx.fillRect(0, 302, 704, 50)
  for (const [x, y, w, h, alpha] of [
    [412, 308, 62, 2, 0x73],
    [424, 316, 38, 1.5, 0x52],
    [432, 323, 22, 1.2, 0x38],
  ] as const) {
    ctx.fillStyle = `rgba(255, 221, 190, ${alpha / 255})`
    ctx.beginPath()
    ctx.roundRect(x, y, w, h, h / 2)
    ctx.fill()
  }
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 })
  return new Uint8Array(await blob.arrayBuffer())
}
