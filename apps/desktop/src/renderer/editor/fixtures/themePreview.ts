/**
 * The "Baren" file in its Theme-tokens state (artboard 07): the token set
 * listed in the Theme panel and the "Theme preview" artboard (values from the reference
 * artboard at 1:1). Used with `?fixture=design&editorScene=theme`.
 */
import { getChildIds, transact, type Styles, type Token } from '@baren/schema'
import type { LoroDoc } from 'loro-crdt'
import { upsertTokens } from '../model/tokenOps'
import { createSpec, frame, orderOf, text } from './build'

export const THEME_TOKENS: Record<string, Token> = {
  '--color-background': { type: 'color', value: '#FFFFFF', description: 'App and card background' },
  '--color-surface': { type: 'color', value: '#F7F7F7', description: 'Panels and sidebars' },
  '--color-canvas': { type: 'color', value: '#EEEEEE', description: 'Canvas background' },
  '--color-foreground': { type: 'color', value: '#1A1A1A', description: 'Primary text' },
  '--color-selection': {
    type: 'color',
    value: '#2F80FF',
    description: 'Canvas selection, focus rings, active artboard label',
  },
  '--color-primary': { type: 'color', value: '#141414', description: 'Primary buttons' },
  '--color-avatar': { type: 'color', value: '#F04E1E', description: 'Default avatar' },
  '--font-sans': { type: 'fontFamily', value: 'Inter' },
  '--text-base': { type: 'fontSize', value: '13px' },
  '--text-xl': { type: 'fontSize', value: '22px' },
  '--spacing-1': { type: 'spacing', value: '4px' },
  '--spacing-2': { type: 'spacing', value: '8px' },
  '--spacing-3': { type: 'spacing', value: '12px' },
  '--spacing-4': { type: 'spacing', value: '16px' },
  '--spacing-6': { type: 'spacing', value: '24px' },
  '--spacing-8': { type: 'spacing', value: '32px' },
  '--spacing-12': { type: 'spacing', value: '48px' },
  '--radius-sm': { type: 'radius', value: '4px' },
  '--radius-md': { type: 'radius', value: '6px' },
  '--radius-lg': { type: 'radius', value: '8px' },
  '--radius-xl': { type: 'radius', value: '12px' },
  '--radius-full': { type: 'radius', value: '9999px' },
}

const sans = (size: string, line: string, color: string, extra: Styles = {}): Styles => ({
  color,
  fontFamily: 'Inter',
  fontSize: size,
  lineHeight: line,
  ...extra,
})

const avatar = (name: string, initial: string, bg: string) =>
  frame(
    name,
    {
      alignItems: 'center',
      backgroundColor: bg,
      borderRadius: '13px',
      boxShadow: '#FFFFFF 0px 0px 0px 2px',
      display: 'flex',
      flexShrink: 0,
      height: '26px',
      justifyContent: 'center',
      width: '26px',
    },
    [text('Initial', initial, sans('11px', '14px', '#FFFFFF', { fontWeight: 600 }))],
  )

const button = (name: string, label: string, bg: string, color: string) =>
  frame(
    name,
    {
      alignItems: 'center',
      backgroundColor: bg,
      borderRadius: 'var(--radius-md)',
      display: 'flex',
      height: '32px',
      paddingLeft: '12px',
      paddingRight: '12px',
    },
    [text('Label', label, sans('var(--text-base)', '16px', color, { fontWeight: 500 }))],
  )

export function themePreviewBoard() {
  return frame(
    'Theme preview',
    {
      left: 0,
      top: 0,
      width: 520,
      backgroundColor: 'var(--color-background)',
      display: 'flex',
      flexDirection: 'column',
      gap: '22px',
      paddingTop: '32px',
      paddingBottom: '32px',
      paddingLeft: '32px',
      paddingRight: '32px',
    },
    [
      frame('Header', { display: 'flex', flexDirection: 'column', gap: '6px' }, [
        text(
          'Title',
          'Invite your team',
          sans('var(--text-xl)', '28px', 'var(--color-foreground)', {
            fontWeight: 500,
            letterSpacing: '-0.02em',
          }),
        ),
        text(
          'Description',
          'Everyone you add gets edit access to files in this team.',
          sans('var(--text-base)', '20px', '#666666'),
        ),
      ]),
      frame('Field', { display: 'flex', flexDirection: 'column', gap: '6px' }, [
        text(
          'Label',
          'Email',
          sans('12px', '16px', 'var(--color-foreground)', { fontWeight: 500 }),
        ),
        frame(
          'Input',
          {
            alignItems: 'center',
            backgroundColor: 'var(--color-background)',
            borderRadius: 'var(--radius-md)',
            boxShadow: 'var(--color-selection) 0px 0px 0px 1px, #2F80FF2E 0px 0px 0px 4px',
            display: 'flex',
            flexShrink: 0,
            height: '34px',
            paddingLeft: '10px',
            paddingRight: '10px',
          },
          [
            text(
              'Value',
              'defne@example.com',
              sans('var(--text-base)', '16px', 'var(--color-foreground)'),
            ),
          ],
        ),
      ]),
      frame('Footer', { alignItems: 'center', display: 'flex', justifyContent: 'space-between' }, [
        frame('Avatars', { alignItems: 'center', display: 'flex' }, [
          avatar('Avatar / C', 'C', 'var(--color-avatar)'),
          avatar('Avatar / D', 'D', '#1A1A1A'),
        ]),
        frame('Actions', { display: 'flex', gap: '8px' }, [
          button('Button / Cancel', 'Cancel', '#EBEBEB', 'var(--color-foreground)'),
          button('Button / Send invite', 'Send invite', 'var(--color-primary)', '#FFFFFF'),
        ]),
      ]),
    ],
  )
}

/** Artboard 07: the 520px preview sits at (470, 353) in the window → (186, 317) in the canvas. */
export const THEME_PREVIEW_VIEWPORT = { x: -186, y: -317, zoom: 1 }

/** Seed tokens + the preview artboard on the first page (artboard 07 at 100%). */
export function seedThemePreview(doc: LoroDoc): void {
  const page = getChildIds(doc, null)[0] as string
  transact(
    doc,
    () => {
      upsertTokens(doc, THEME_TOKENS, { orders: orderOf(THEME_TOKENS), origin: 'fixture:seed' })
      createSpec(doc, themePreviewBoard(), page)
    },
    { origin: 'fixture:seed' },
  )
}
