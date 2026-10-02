/**
 * The "acme" component library shown in artboards 05, 06, 08, 14 and 15:
 * pages "Component library", "Logo", "Cloud posture"; the 12 numbered artboards; and the
 * "03 Forms" artboard with the real subtree and text of artboard 14 (values from its
 * "Board / 03 Forms" node at 1:1).
 */
import {
  createNode,
  getChildIds,
  getNode,
  setNodeProps,
  transact,
  type Styles,
  type Token,
} from '@baren/schema'
import type { LoroDoc } from 'loro-crdt'
import { upsertTokens } from '../model/tokenOps'
import { BOARD_WIDTH, mockBoardStyles, mockBoards } from './boards'
import { createSpec, frame, orderOf, svg, text, type NodeSpec } from './build'

export const COMPONENT_LIBRARY_PAGES = ['Component library', 'Logo', 'Cloud posture'] as const

export const ARTBOARD_NAMES = [
  '01 Foundations',
  '02 Actions',
  '03 Forms',
  '04 Labels & Status',
  '05 Feedback',
  '06 Navigation',
  '07 Overlays',
  '08 Data Display',
  '09 Brand & Composer',
  '10 App Shell',
  '11 Dashboard Patterns',
  '12 Settings, Billing & Auth',
] as const

/** World positions: 03 Forms sits at X 2320, Y −600 as in the artboard 06 inspector. */
export const ARTBOARD_TOP = -600
export const ARTBOARD_STEP = 900
export const ARTBOARD_LEFT0 = 2320 - 2 * ARTBOARD_STEP

export function artboardLeft(index: number): number {
  return ARTBOARD_LEFT0 + index * ARTBOARD_STEP
}

export const COMPONENT_LIBRARY_TOKENS: Record<string, Token> = {
  '--color-background': {
    type: 'color',
    value: '#FFFFFF',
    description: 'Artboard and card background',
  },
  '--color-foreground': { type: 'color', value: '#111111', description: 'Primary text' },
  '--color-gray-900': { type: 'color', value: '#1A1A1A' },
  '--color-gray-500': { type: 'color', value: '#6B6B6B', description: 'Secondary text' },
  '--color-gray-400': { type: 'color', value: '#8A8A8A' },
  '--color-gray-300': { type: 'color', value: '#D0D0D0' },
  '--color-gray-200': { type: 'color', value: '#E6E6E6' },
  '--color-border': { type: 'color', value: '#DADADA', description: 'Input borders' },
  '--color-lime-400': { type: 'color', value: '#C8F230', description: 'Brand accent' },
  '--color-red-500': {
    type: 'color',
    value: '#D7263D',
    description: 'Errors and destructive actions',
  },
  '--color-green-700': { type: 'color', value: '#16833F' },
  '--font-sans': { type: 'fontFamily', value: 'Inter' },
  '--font-mono': { type: 'fontFamily', value: 'JetBrains Mono' },
  '--text-sm': { type: 'fontSize', value: '12px' },
  '--text-base': { type: 'fontSize', value: '13px' },
  '--text-2xl': { type: 'fontSize', value: '26px' },
  '--spacing-2': { type: 'spacing', value: '8px' },
  '--spacing-6': { type: 'spacing', value: '24px' },
  '--spacing-10': { type: 'spacing', value: '40px' },
  '--radius-md': { type: 'radius', value: '6px' },
}

const FG = 'var(--color-foreground)'
const MUTED = 'var(--color-gray-500)'
const SUBTLE = 'var(--color-gray-400)'

const sans = (size: number, line: number, color: string, extra: Styles = {}): Styles => ({
  color,
  fontFamily: 'Inter',
  fontSize: `${size}px`,
  lineHeight: `${line}px`,
  ...extra,
})

const label = (content: string, color = FG) =>
  text('Label', content, sans(13, 16, color, { fontWeight: 500 }))

const MAIL_SVG =
  '<svg width="15" height="15" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><rect width="20" height="16" x="2" y="4" rx="2" fill="none" stroke="#8A8A8A" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" fill="none" stroke="#8A8A8A" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/></svg>'

const chevronSvg = (stroke: string) =>
  `<svg width="14" height="14" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="m6 9 6 6 6-6" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`

const CHECK_SVG =
  '<svg width="11" height="11" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M20 6 9 17l-5-5" fill="none" stroke="#C8F230" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'

const inputBox = (name: string, extra: Styles, children: NodeSpec[]) =>
  frame(
    name,
    {
      alignItems: 'center',
      borderColor: 'var(--color-border)',
      borderRadius: '6px',
      borderStyle: 'solid',
      borderWidth: '1px',
      display: 'flex',
      flexShrink: 0,
      height: '38px',
      paddingLeft: '12px',
      paddingRight: '12px',
      ...extra,
    },
    children,
  )

const fieldColumn = (name: string, children: NodeSpec[], extra: Styles = {}) =>
  frame(name, { display: 'flex', flexDirection: 'column', gap: '6px', ...extra }, children)

/** Section title + description pinned to the left column (absolutely positioned). */
const sectionDescription = (heading: string, body: string, top: number) =>
  frame(
    'Description',
    {
      display: 'flex',
      flexDirection: 'column',
      gap: '6px',
      left: '0px',
      position: 'absolute',
      top: `${top}px`,
      width: '180px',
    },
    [
      text('Title', heading, sans(13, 16, FG, { fontWeight: 600 })),
      text('Body', body, sans(12, 18, MUTED)),
    ],
  )

const section = (name: string, divider: boolean, children: NodeSpec[], extra: Styles = {}) =>
  frame(
    name,
    {
      display: 'flex',
      flexDirection: 'column',
      gap: '24px',
      paddingLeft: '220px',
      position: 'relative',
      ...(divider
        ? {
            borderTopColor: '#EDEDED',
            borderTopStyle: 'solid',
            borderTopWidth: '1px',
            paddingTop: '28px',
          }
        : {}),
      ...extra,
    },
    children,
  )

function checkRow(name: string, checked: boolean, caption: string, radio: boolean): NodeSpec {
  const control: NodeSpec = radio
    ? frame(radio && checked ? 'Radio / on' : 'Radio', {
        borderColor: checked ? '#111111' : '#CFCFCF',
        borderRadius: '8px',
        borderStyle: 'solid',
        borderWidth: checked ? '5px' : '1px',
        flexShrink: 0,
        height: '16px',
        width: '16px',
      })
    : checked
      ? frame(
          'Checkbox / on',
          {
            alignItems: 'center',
            backgroundColor: '#111111',
            borderRadius: '4px',
            display: 'flex',
            flexShrink: 0,
            height: '16px',
            justifyContent: 'center',
            width: '16px',
          },
          [svg('Check', CHECK_SVG, { width: '11px', height: '11px' })],
        )
      : frame('Checkbox', {
          borderColor: '#CFCFCF',
          borderRadius: '4px',
          borderStyle: 'solid',
          borderWidth: '1px',
          flexShrink: 0,
          height: '16px',
          width: '16px',
        })
  return frame(name, { alignItems: 'center', display: 'flex', gap: '10px' }, [
    control,
    text('Caption', caption, sans(13, 16, FG)),
  ])
}

/** 03 Forms is 520px tall in the 112px-wide overview of artboard 06. */
export const FORMS_MIN_HEIGHT = Math.round((520 * BOARD_WIDTH) / 112)

/** The 03 Forms artboard (artboard 14), 800px wide, height Fit. */
export function formsBoard(): NodeSpec {
  return frame(
    '03 Forms',
    {
      left: artboardLeft(2),
      top: ARTBOARD_TOP,
      width: BOARD_WIDTH,
      // Height stays "Fit"; the minimum matches the 03 Forms board in the overview (06).
      minHeight: `${FORMS_MIN_HEIGHT}px`,
      backgroundColor: 'var(--color-background)',
      display: 'flex',
      flexDirection: 'column',
      gap: '36px',
      paddingTop: '40px',
      paddingBottom: '40px',
      paddingLeft: '48px',
      paddingRight: '48px',
      overflow: 'hidden',
    },
    [
      frame(
        'Header',
        {
          alignItems: 'end',
          borderBottomColor: '#EDEDED',
          borderBottomStyle: 'solid',
          borderBottomWidth: '1px',
          display: 'flex',
          justifyContent: 'space-between',
          paddingBottom: '20px',
        },
        [
          fieldColumn('Title', [
            text(
              'Heading',
              'Inputs',
              sans(26, 32, FG, { fontWeight: 600, letterSpacing: '-0.02em' }),
            ),
            text(
              'Description',
              'Text fields, selects and toggles used across baren.',
              sans(13, 16, MUTED),
            ),
          ]),
          text('Breadcrumb', '03 / Forms', {
            color: SUBTLE,
            fontFamily: 'JetBrains Mono',
            fontSize: '11px',
            lineHeight: '14px',
          }),
        ],
      ),
      section('Section / Text input', false, [
        fieldColumn(
          'Field / Email',
          [
            label('Email'),
            inputBox('Input', { alignSelf: 'stretch', gap: '8px' }, [
              svg('Icon / mail', MAIL_SVG, { width: '15px', height: '15px', flexShrink: 0 }),
              text('Placeholder', 'you@company.com', sans(13, 16, '#9A9A9A')),
            ]),
            text('Hint', "We'll only use this for sign-in alerts.", sans(12, 16, MUTED)),
          ],
          { alignItems: 'start' },
        ),
        fieldColumn('Field / Password', [
          label('Password'),
          inputBox(
            'Input',
            {
              borderColor: FG,
              boxShadow: '0px 0px 0px 3px #C8F2308C',
              justifyContent: 'space-between',
            },
            [
              text('Value', '••••••••••', sans(15, 18, FG, { letterSpacing: '0.2em' })),
              text('Action', 'Show', sans(12, 16, MUTED, { fontWeight: 500 })),
            ],
          ),
        ]),
        fieldColumn('Field / Error state', [
          label('Workspace URL'),
          inputBox('Input', { backgroundColor: '#FFF7F8', borderColor: 'var(--color-red-500)' }, [
            text('Prefix', 'example.com/', sans(13, 16, SUBTLE)),
            text('Value', 'acme corp', sans(13, 16, FG)),
          ]),
          text('Error', 'Use lowercase letters, numbers and dashes only.', sans(12, 16, '#C21F35')),
        ]),
        sectionDescription(
          'Text input',
          'Single-line entry. Label sits above, hint or error below.',
          0,
        ),
      ]),
      section('Section / Select', true, [
        frame('Fields', { display: 'flex', gap: '16px' }, [
          fieldColumn(
            'Field / Region',
            [
              label('Region'),
              inputBox('Select', { justifyContent: 'space-between' }, [
                text('Value', 'eu-central-1', sans(13, 16, FG)),
                svg('Chevron', chevronSvg('#6B6B6B'), {
                  width: '14px',
                  height: '14px',
                  flexShrink: 0,
                }),
              ]),
            ],
            { flexBasis: '0%', flexGrow: 1 },
          ),
          fieldColumn(
            'Field / Scan frequency',
            [
              label('Scan frequency', '#9A9A9A'),
              inputBox(
                'Select',
                {
                  backgroundColor: '#F7F7F7',
                  borderColor: '#EAEAEA',
                  justifyContent: 'space-between',
                },
                [
                  text('Value', 'Daily', sans(13, 16, '#9A9A9A')),
                  svg('Chevron', chevronSvg('#BDBDBD'), {
                    width: '14px',
                    height: '14px',
                    flexShrink: 0,
                  }),
                ],
              ),
            ],
            { flexBasis: '0%', flexGrow: 1 },
          ),
        ]),
        sectionDescription('Select', 'Pick one option from a short list.', 28),
      ]),
      section('Section / Checkbox & radio', true, [
        frame('Options', { display: 'flex', gap: '48px' }, [
          fieldColumn(
            'Checkboxes',
            [
              checkRow('Checkbox / Email alerts', true, 'Email alerts', false),
              checkRow('Checkbox / Weekly digest', false, 'Weekly digest', false),
            ],
            { gap: '12px' },
          ),
          fieldColumn(
            'Radios',
            [
              checkRow('Radio / Critical only', true, 'Critical only', true),
              checkRow('Radio / All findings', false, 'All findings', true),
            ],
            { gap: '12px' },
          ),
        ]),
        sectionDescription('Checkbox & radio', 'Binary and single-choice controls.', 28),
      ]),
      frame(
        'Footer',
        {
          borderTopColor: '#EDEDED',
          borderTopStyle: 'solid',
          borderTopWidth: '1px',
          display: 'flex',
          justifyContent: 'space-between',
          paddingTop: '20px',
        },
        [
          text('Credit', 'acme design system', {
            color: SUBTLE,
            fontFamily: 'JetBrains Mono',
            fontSize: '11px',
            lineHeight: '14px',
          }),
          text('Version', 'v1.4', {
            color: SUBTLE,
            fontFamily: 'JetBrains Mono',
            fontSize: '11px',
            lineHeight: '14px',
          }),
        ],
      ),
    ],
  )
}

function logoBoard(): NodeSpec {
  return frame(
    'Logo',
    {
      left: 0,
      top: 0,
      width: 640,
      height: 400,
      alignItems: 'center',
      backgroundColor: '#FFFFFF',
      display: 'flex',
      justifyContent: 'center',
      gap: '16px',
    },
    [
      frame(
        'Mark',
        {
          alignItems: 'center',
          backgroundColor: '#1A1A1A',
          borderRadius: '16px',
          display: 'flex',
          height: '96px',
          justifyContent: 'center',
          width: '96px',
        },
        [
          text(
            'a',
            'a',
            sans(40, 40, '#FFFFFF', { fontFamily: 'JetBrains Mono', fontWeight: 600 }),
          ),
        ],
      ),
      text(
        'Wordmark',
        'acme',
        sans(56, 64, '#1A1A1A', { fontWeight: 600, letterSpacing: '-0.03em' }),
      ),
    ],
  )
}

function postureBoard(): NodeSpec {
  const stat = (name: string, value: string, caption: string) =>
    frame(
      name,
      {
        backgroundColor: '#F7F7F7',
        borderRadius: '8px',
        display: 'flex',
        flexBasis: '0%',
        flexDirection: 'column',
        flexGrow: 1,
        gap: '4px',
        paddingTop: '16px',
        paddingBottom: '16px',
        paddingLeft: '16px',
        paddingRight: '16px',
      },
      [
        text('Value', value, sans(28, 34, '#1A1A1A', { fontWeight: 600 })),
        text('Caption', caption, sans(12, 16, '#666666')),
      ],
    )
  return frame(
    'Cloud posture',
    {
      left: 0,
      top: 0,
      width: 1200,
      backgroundColor: '#FFFFFF',
      display: 'flex',
      flexDirection: 'column',
      gap: '24px',
      paddingTop: '40px',
      paddingBottom: '40px',
      paddingLeft: '40px',
      paddingRight: '40px',
    },
    [
      text('Title', 'Cloud posture', sans(24, 30, '#1A1A1A', { fontWeight: 600 })),
      frame('Stats', { display: 'flex', gap: '16px' }, [
        stat('Stat / Critical', '12', 'Critical findings'),
        stat('Stat / High', '48', 'High findings'),
        stat('Stat / Resolved', '312', 'Resolved this month'),
      ]),
    ],
  )
}

/** True when `doc` still has exactly the empty default page (nothing to lose by seeding). */
export function isPristine(doc: LoroDoc): boolean {
  const pages = getChildIds(doc, null)
  if (pages.length !== 1) return false
  const page = pages[0] as string
  return (
    getChildIds(doc, page).length === 0 && Object.keys(doc.getMap('tokens').toJSON()).length === 0
  )
}

export interface SeedResult {
  /** Page shown first. */
  pageId: string
  /** Initial viewports by page id (world x/y at the canvas' top-left, zoom). */
  viewports: Record<string, { x: number; y: number; zoom: number }>
  /** Layer rows shown expanded (instances included). */
  expanded?: readonly string[]
}

/** Overview viewport of artboard 05: 112px-wide artboards, 01 Foundations at (24, 131). */
export const OVERVIEW_ZOOM = 112 / BOARD_WIDTH

/**
 * Populate an (empty) document with the component library. One commit. `posture` replaces
 * the "Cloud posture" page content (the image scene puts the landing artboards there).
 */
export function seedComponentLibrary(
  doc: LoroDoc,
  posture: (doc: LoroDoc, pageId: string) => void = (d, page) =>
    void createSpec(d, postureBoard(), page),
): void {
  transact(
    doc,
    () => {
      const pages = getChildIds(doc, null)
      const existing = pages[0]
      const pageIds: string[] = []
      COMPONENT_LIBRARY_PAGES.forEach((name, i) => {
        if (i === 0 && existing !== undefined) {
          setNodeProps(doc, existing, { name, background: '#EEEEEE' })
          pageIds.push(existing)
        } else {
          pageIds.push(
            createNode(doc, { type: 'page', parentId: null, name, background: '#EEEEEE' }),
          )
        }
      })
      upsertTokens(doc, COMPONENT_LIBRARY_TOKENS, {
        orders: orderOf(COMPONENT_LIBRARY_TOKENS),
        origin: 'fixture:seed',
      })
      const library = pageIds[0] as string
      const boards = mockBoards()
      ARTBOARD_NAMES.forEach((name, i) => {
        if (name === '03 Forms') {
          createSpec(doc, formsBoard(), library)
          return
        }
        const board = boards[name]
        if (!board) return
        createSpec(
          doc,
          frame(name, mockBoardStyles(board, artboardLeft(i), ARTBOARD_TOP), board.children),
          library,
        )
      })
      createSpec(doc, logoBoard(), pageIds[1] as string)
      posture(doc, pageIds[2] as string)
    },
    { origin: 'fixture:seed' },
  )
}

/** Name of a node, for tests. */
export function nameOf(doc: LoroDoc, id: string): string {
  return getNode(doc, id)?.name ?? ''
}
