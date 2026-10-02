/**
 * Component-library artboards as drawn in the overview (artboards 05/06/08/15).
 * The overview shows them as 112px-wide wireframe thumbnails; here they are real 800px-wide
 * artboards built from the same blocks, scaled up (mock px × 800/112), so the canvas'
 * low-zoom thumbnails reproduce the reference. Values come from the "Board / …" nodes of
 * artboard 06.
 */
import type { Styles } from '@baren/schema'
import { frame, rect, type NodeSpec } from './build'

export const BOARD_WIDTH = 800
/** World px per mock px. */
export const MOCK_SCALE = BOARD_WIDTH / 112

/** Scale a mock length to world px. */
export const s = (n: number): number => Math.round(n * MOCK_SCALE)

const C = {
  ink: 'var(--color-gray-900)',
  line: 'var(--color-gray-300)',
  chip: 'var(--color-gray-200)',
  lime: 'var(--color-lime-400)',
  red: 'var(--color-red-500)',
  green: 'var(--color-green-700)',
}

const bar = (name: string, w: number | null, h: number, color: string, extra: Styles = {}) =>
  rect(name, {
    backgroundColor: color,
    flexShrink: 0,
    height: s(h),
    ...(w === null ? {} : { width: s(w) }),
    ...extra,
  })

const box = (name: string, w: number | null, h: number, border: string, extra: Styles = {}) =>
  rect(name, {
    borderColor: border,
    borderStyle: 'solid',
    borderWidth: s(1),
    flexShrink: 0,
    height: s(h),
    ...(w === null ? {} : { width: s(w) }),
    ...extra,
  })

const grow: Styles = { flexBasis: '0%', flexGrow: 1 }

const row = (name: string, gap: number, children: NodeSpec[], extra: Styles = {}) =>
  frame(name, { display: 'flex', gap: s(gap), ...extra }, children)

const col = (name: string, gap: number, children: NodeSpec[], extra: Styles = {}) =>
  frame(name, { display: 'flex', flexDirection: 'column', gap: s(gap), ...extra }, children)

const title = (w = 30) => bar('Title', w, 4, C.ink)

function common(withTitle = true): NodeSpec[] {
  return [
    ...(withTitle ? [title()] : []),
    row(
      'Buttons',
      3,
      [
        bar('Primary', 18, 6, C.lime),
        bar('Secondary', 18, 6, C.ink),
        bar('Destructive', 18, 6, C.red),
        box('Destructive outline', 18, 6, C.red),
      ],
      { paddingTop: s(6) },
    ),
    row('Chips', 3, [
      bar('Chip / active', 18, 6, C.lime),
      bar('Chip', 18, 6, C.chip),
      bar('Chip', 18, 6, C.chip),
    ]),
    bar('Body', 70, 2, C.line),
    bar('Body', 52, 2, C.line),
    row(
      'Status',
      3,
      [bar('Dot', 6, 6, C.ink, { borderRadius: s(3) }), bar('Label', 30, 6, C.chip)],
      {
        paddingTop: s(4),
      },
    ),
  ]
}

function labelColumn(widths: number[]): NodeSpec {
  return col(
    'Label',
    3,
    [
      bar('Heading', null, 2, '#9A9A9A'),
      ...widths.map((w, i) => bar(i === 0 ? 'Caption' : 'Caption 2', w, 2, C.line)),
    ],
    { flexShrink: 0, width: s(26) },
  )
}

function docSections(): NodeSpec {
  const specimen = (name: string, label: number[], content: NodeSpec) =>
    row(name, 6, [labelColumn(label), content])
  return col(
    'Doc sections',
    14,
    [
      specimen(
        'Inputs',
        [18, 22],
        col(
          'Specimen',
          4,
          [
            row('Pair', 3, [
              box('Field', null, 7, '#D6D6D6', grow),
              box('Focus', null, 7, '#7FB0FF', grow),
            ]),
            row('Pair', 3, [
              box('Error', null, 7, '#F0A3A3', grow),
              bar('Disabled', null, 7, '#F3F3F3', grow),
            ]),
          ],
          grow,
        ),
      ),
      specimen(
        'Progress',
        [20],
        col(
          'Specimen',
          3,
          [
            bar('Track', null, 2, C.line),
            bar('Warning', 40, 2, '#E8A23A'),
            bar('Track', 30, 2, C.line),
            bar('Done', 44, 2, C.lime),
          ],
          grow,
        ),
      ),
      specimen(
        'Toggles',
        [14],
        row(
          'Specimen',
          5,
          [
            box('Radio', 7, 7, '#BDBDBD', { borderRadius: s(4) }),
            bar('Radio / on', 7, 7, C.ink, { borderRadius: s(4) }),
            bar('Switch / on', 12, 7, C.ink, { borderRadius: s(4) }),
            bar('Switch / off', 12, 7, '#E0E0E0', { borderRadius: s(4) }),
            box('Checkbox', 7, 7, '#BDBDBD'),
          ],
          { ...grow, alignItems: 'center' },
        ),
      ),
      specimen(
        'Selects',
        [18],
        col(
          'Specimen',
          3,
          [
            box('Select', null, 9, '#D6D6D6'),
            bar('Hint', 28, 2, C.line),
            box('Select / disabled', null, 9, '#D6D6D6', { backgroundColor: '#FAFAFA' }),
          ],
          grow,
        ),
      ),
      specimen(
        'Tabs',
        [22],
        row(
          'Specimen',
          3,
          [
            bar('Tab / active', 18, 5, C.ink),
            bar('Tab', 18, 5, '#E0E0E0'),
            bar('Tab', 6, 5, '#E0E0E0'),
          ],
          grow,
        ),
      ),
      specimen(
        'Composer',
        [16],
        col(
          'Specimen',
          3,
          [
            row('Input row', 3, [
              box('Input', null, 7, '#D6D6D6', grow),
              bar('Send', 14, 7, C.lime),
            ]),
            bar('Hint', 50, 2, C.line),
          ],
          grow,
        ),
      ),
    ],
    { flexShrink: 0, paddingTop: s(10) },
  )
}

function foundations(): NodeSpec[] {
  const swatches = (name: string, colors: string[], h: number) =>
    row(
      name,
      2,
      colors.map((c, i) => bar(`Swatch ${i + 1}`, null, h, c, grow)),
    )
  return [
    title(36),
    swatches('Neutrals', ['#F2F2F2', '#D9D9D9', '#A6A6A6', '#595959', C.ink], 10),
    row('Brand', 2, [
      bar('Lime 400', 34, 20, C.lime),
      bar('Lime 600', null, 20, '#9CC21F', grow),
      bar('Lime 900', null, 20, '#3D5A0F', grow),
    ]),
    swatches('Accents', ['#7C3AED', C.red, '#EA580C', '#CA8A04', C.green], 10),
    bar('Display', 60, 5, C.ink),
    bar('Heading', 44, 3, C.ink),
    bar('Body', 80, 2, C.line),
    bar('Body', 70, 2, C.line),
    bar('Body', 84, 2, C.line),
    bar('Body', 56, 2, C.line),
    row(
      'Radii',
      3,
      [
        box('Radius 0', 12, 12, '#DDDDDD'),
        box('Radius 0', 12, 12, '#DDDDDD'),
        box('Radius 0', 12, 12, '#DDDDDD'),
        box('Radius full', 12, 12, '#DDDDDD', { borderRadius: s(6) }),
      ],
      { paddingTop: s(6) },
    ),
  ]
}

function alertStack(): NodeSpec {
  return col(
    'Alerts',
    4,
    [
      bar('Alert / error', null, 8, '#FBE3E3', {
        borderLeftColor: C.red,
        borderLeftStyle: 'solid',
        borderLeftWidth: s(2),
      }),
      bar('Alert / success', null, 8, '#E4F6E8', {
        borderLeftColor: C.green,
        borderLeftStyle: 'solid',
        borderLeftWidth: s(2),
      }),
      bar('Banner', null, 6, C.red),
    ],
    { flexShrink: 0 },
  )
}

function sidebarPreview(): NodeSpec {
  return row(
    'Sidebar preview',
    4,
    [
      col(
        'Sidebar',
        3,
        [
          bar('Nav / active', null, 2, C.lime),
          bar('Nav', null, 2, '#555555'),
          bar('Nav', null, 2, '#555555'),
          bar('Nav', null, 2, '#555555'),
        ],
        {
          backgroundColor: '#111111',
          flexShrink: 0,
          paddingTop: s(4),
          paddingBottom: s(4),
          paddingLeft: s(3),
          paddingRight: s(3),
          width: s(22),
        },
      ),
      col(
        'Content',
        3,
        [bar('Title', 30, 3, C.ink), bar('Body', null, 2, C.line), bar('Body', 40, 2, C.line)],
        { ...grow, paddingTop: s(4) },
      ),
    ],
    { flexShrink: 0, height: s(40) },
  )
}

function modalPreview(): NodeSpec {
  return frame(
    'Modal preview',
    {
      alignItems: 'center',
      backgroundColor: '#8E8E8E',
      display: 'flex',
      flexShrink: 0,
      height: s(46),
      justifyContent: 'center',
    },
    [
      col(
        'Dialog',
        3,
        [
          bar('Title', 24, 3, C.ink),
          bar('Body', null, 2, C.line),
          row('Actions', 2, [bar('Cancel', 10, 4, '#E0E0E0'), bar('Confirm', 10, 4, C.lime)], {
            justifyContent: 'end',
          }),
        ],
        {
          backgroundColor: '#FFFFFF',
          flexShrink: 0,
          paddingTop: s(5),
          paddingBottom: s(5),
          paddingLeft: s(5),
          paddingRight: s(5),
          width: s(52),
        },
      ),
    ],
  )
}

export interface MockBoard {
  name: string
  /** Mock height in px (overview). */
  height: number
  gap: number
  children: NodeSpec[]
}

/** All numbered artboards except 03 Forms (built with real content in componentLibrary.ts). */
export function mockBoards(): Record<string, MockBoard> {
  return {
    '01 Foundations': { name: '01 Foundations', height: 260, gap: 7, children: foundations() },
    '02 Actions': { name: '02 Actions', height: 150, gap: 8, children: common() },
    '04 Labels & Status': {
      name: '04 Labels & Status',
      height: 290,
      gap: 8,
      children: [...common(), docSections()],
    },
    '05 Feedback': {
      name: '05 Feedback',
      height: 320,
      gap: 8,
      children: [title(), alertStack(), ...common(false), docSections()],
    },
    '06 Navigation': {
      name: '06 Navigation',
      height: 326,
      gap: 8,
      children: [title(), sidebarPreview(), ...common(false), docSections()],
    },
    '07 Overlays': {
      name: '07 Overlays',
      height: 440,
      gap: 8,
      children: [title(), modalPreview(), ...common(false), docSections(), docSections()],
    },
    '08 Data Display': {
      name: '08 Data Display',
      height: 300,
      gap: 8,
      children: [...common(), docSections()],
    },
    '09 Brand & Composer': {
      name: '09 Brand & Composer',
      height: 320,
      gap: 8,
      children: [title(), alertStack(), ...common(false), docSections()],
    },
    '10 App Shell': {
      name: '10 App Shell',
      height: 330,
      gap: 8,
      children: [title(), sidebarPreview(), ...common(false), docSections()],
    },
    '11 Dashboard Patterns': {
      name: '11 Dashboard Patterns',
      height: 440,
      gap: 8,
      children: [...common(), docSections(), docSections()],
    },
    '12 Settings, Billing & Auth': {
      name: '12 Settings, Billing & Auth',
      height: 300,
      gap: 8,
      children: [title(), modalPreview(), ...common(false), docSections()],
    },
  }
}

/** Artboard frame styles for a mock board at (left, top). */
export function mockBoardStyles(board: MockBoard, left: number, top: number): Styles {
  return {
    left,
    top,
    width: BOARD_WIDTH,
    height: s(board.height),
    backgroundColor: 'var(--color-background)',
    display: 'flex',
    flexDirection: 'column',
    gap: s(board.gap),
    paddingTop: s(10),
    paddingBottom: s(10),
    paddingLeft: s(8),
    paddingRight: s(8),
    overflow: 'hidden',
  }
}
