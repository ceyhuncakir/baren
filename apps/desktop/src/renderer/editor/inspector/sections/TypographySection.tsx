/**
 * Typography (artboard 14): family (bundled fonts and Google Fonts), weight, size, line
 * height, letter spacing, alignment and text options. Token references (`var(--text-xl)`) are
 * resolved for display; edits write plain values.
 */
import {
  DropdownMenu,
  IconButton,
  IconToggleGroup,
  InspectorRow,
  InspectorSection,
  LetterSpacingIcon,
  LineHeightIcon,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  NumberField,
  SectionHeaderAction,
  SlidersIcon,
  TextAlignCenterIcon,
  TextAlignLeftIcon,
  TextAlignRightIcon,
  TokensIcon,
} from '@baren/ui'
import { useMemo, useRef, useState } from 'react'
import { findGoogleFont, weightList } from '../../../lib/googleFonts'
import {
  FONT_FAMILIES,
  FONT_WEIGHTS,
  familyLabel,
  primaryFamily,
  weightLabel,
} from '../../lib/fonts'
import {
  MIXED,
  common,
  letterSpacingPatch,
  readTypography,
  type Typography,
} from '../../model/styles'
import { tokenGroup } from '../../model/tokens'
import { useTokens } from '../../session/context'
import type { NodesSnapshot } from '../../session/docEvents'
import { MenuSelect } from '../controls'
import { FontFamilyPicker } from '../FontFamilyPicker'
import { resolveStyles, useStyleEdit } from '../hooks'
import { nullable } from './LayoutSection'
import { SectionTitle } from '../marks'
import css from '../Inspector.module.css'

const SIZE_PRESETS = [10, 11, 12, 13, 14, 16, 18, 20, 22, 24, 28, 32, 40, 48, 64, 72, 96]

const ALIGN_OPTIONS = [
  { value: 'left' as const, icon: <TextAlignLeftIcon size={12} />, 'aria-label': 'Align left' },
  {
    value: 'center' as const,
    icon: <TextAlignCenterIcon size={12} />,
    'aria-label': 'Align center',
  },
  { value: 'right' as const, icon: <TextAlignRightIcon size={12} />, 'aria-label': 'Align right' },
]

export function TypographySection({ snapshot }: { snapshot: NodesSnapshot }) {
  const edit = useStyleEdit()
  const tokens = useTokens()
  const texts = snapshot.nodes.filter((n) => n.type === 'text')
  const typos: Typography[] = useMemo(
    () => texts.map((n) => readTypography(resolveStyles(n.styles, tokens))),
    [texts, tokens],
  )
  const [sizeMenu, setSizeMenu] = useState(false)
  const [optionsMenu, setOptionsMenu] = useState(false)
  const [tokenMenu, setTokenMenu] = useState(false)
  const sizeRef = useRef<HTMLElement | null>(null)
  const optionsRef = useRef<HTMLSpanElement>(null)
  const tokenRef = useRef<HTMLSpanElement>(null)
  if (texts.length === 0) return null

  const family = common(typos.map((t) => primaryFamily(t.family)))
  const weight = common(typos.map((t) => t.weight))
  const size = common(typos.map((t) => t.size))
  const lineHeight = common(typos.map((t) => t.lineHeight))
  const spacing = common(typos.map((t) => t.letterSpacing))
  const align = common(typos.map((t) => (t.align === 'justify' ? 'left' : t.align)))
  const decoration = common(texts.map((n) => String(n.styles['textDecoration'] ?? 'none')))
  const transform = common(texts.map((n) => String(n.styles['textTransform'] ?? 'none')))

  const typoTokens = Object.entries(tokens).filter(
    ([name, t]) => tokenGroup(name, t) === 'typography',
  )

  // A Google Fonts family offers the weights it has (plus the current one, whatever it is).
  const google = typeof family === 'string' ? findGoogleFont(family) : null
  const available = google
    ? new Set([
        ...weightList(google.weights),
        ...(google.italic === null ? [] : weightList(google.italic)),
      ])
    : null
  const weightOptions = FONT_WEIGHTS.filter(
    (w) => available === null || available.has(w.value) || w.value === weight,
  )
  const familyValue =
    family === MIXED || family === undefined
      ? family
      : (FONT_FAMILIES.find(
          (f) =>
            primaryFamily(f.value) === family ||
            (family === 'Inter Variable' && f.value === 'Inter'),
        )?.value ?? family)

  return (
    <InspectorSection
      title={<SectionTitle name="Typography" />}
      tight
      actions={
        <span ref={tokenRef} style={{ display: 'flex' }}>
          <SectionHeaderAction label="Text tokens" onClick={() => setTokenMenu((v) => !v)}>
            <TokensIcon size={12} />
          </SectionHeaderAction>
        </span>
      }
    >
      <FontFamilyPicker
        value={familyValue}
        display={
          family === MIXED ? 'Mixed' : familyLabel(typeof family === 'string' ? family : 'Inter')
        }
        onChange={(v) => edit(() => ({ fontFamily: v }))}
      />
      <InspectorRow>
        <MenuSelect
          value={weight === MIXED || weight === undefined ? weight : String(weight)}
          display={
            weight === MIXED ? 'Mixed' : weightLabel(typeof weight === 'number' ? weight : 400)
          }
          options={weightOptions.map((w) => ({ value: String(w.value), label: w.label }))}
          onChange={(v) => edit(() => ({ fontWeight: Number(v) }))}
          aria-label="Font weight"
        />
        <NumberField
          value={nullable(size)}
          min={1}
          width={80}
          chevron
          onChevronClick={() => setSizeMenu((v) => !v)}
          inputRef={(el) => void (sizeRef.current = el?.parentElement ?? null)}
          onChange={(v, m) => edit(() => ({ fontSize: `${v}px` }), m.final)}
          aria-label="Font size"
        />
      </InspectorRow>
      <InspectorRow>
        <NumberField
          prefix={<LineHeightIcon size={11} />}
          value={lineHeight === MIXED || lineHeight === undefined ? null : lineHeight}
          placeholder={lineHeight === MIXED ? 'Mixed' : 'Auto'}
          className={lineHeight === null ? css.modeField : undefined}
          min={0}
          onChange={(v, m) => edit(() => ({ lineHeight: `${v}px` }), m.final)}
          aria-label="Line height"
        />
        <NumberField
          prefix={<LetterSpacingIcon size={11} />}
          value={nullable(spacing)}
          unit="%"
          onChange={(v, m) => edit(() => letterSpacingPatch(v), m.final)}
          aria-label="Letter spacing"
        />
      </InspectorRow>
      <InspectorRow>
        <IconToggleGroup
          fullWidth
          value={align === MIXED || align === undefined ? 'left' : align}
          onChange={(a) => edit(() => ({ textAlign: a === 'left' ? null : a }))}
          style={{ flex: '1 1 0' }}
          options={ALIGN_OPTIONS}
        />
        <span ref={optionsRef} style={{ display: 'flex' }}>
          <IconButton
            label="Text options"
            size={26}
            style={{ background: 'var(--color-input)', borderRadius: 5 }}
            aria-expanded={optionsMenu}
            onClick={() => setOptionsMenu((v) => !v)}
          >
            <SlidersIcon size={12} />
          </IconButton>
        </span>
      </InspectorRow>
      <DropdownMenu
        open={sizeMenu}
        onOpenChange={setSizeMenu}
        anchorRef={sizeRef}
        width={120}
        placement="bottom-end"
      >
        {SIZE_PRESETS.map((p) => (
          <MenuItem
            key={p}
            checked={size === p}
            onSelect={() => edit(() => ({ fontSize: `${p}px` }))}
          >
            {p}
          </MenuItem>
        ))}
      </DropdownMenu>
      <DropdownMenu
        open={optionsMenu}
        onOpenChange={setOptionsMenu}
        anchorRef={optionsRef}
        width={200}
        placement="bottom-end"
      >
        <MenuLabel>Decoration</MenuLabel>
        <MenuItem
          checked={decoration === 'underline'}
          keepOpen
          onSelect={() =>
            edit(() => ({ textDecoration: decoration === 'underline' ? null : 'underline' }))
          }
        >
          Underline
        </MenuItem>
        <MenuItem
          checked={decoration === 'line-through'}
          keepOpen
          onSelect={() =>
            edit(() => ({ textDecoration: decoration === 'line-through' ? null : 'line-through' }))
          }
        >
          Strikethrough
        </MenuItem>
        <MenuSeparator />
        <MenuLabel>Case</MenuLabel>
        {(['none', 'uppercase', 'lowercase', 'capitalize'] as const).map((t) => (
          <MenuItem
            key={t}
            checked={transform === t}
            keepOpen
            onSelect={() => edit(() => ({ textTransform: t === 'none' ? null : t }))}
          >
            {t === 'none' ? 'As typed' : t.charAt(0).toUpperCase() + t.slice(1)}
          </MenuItem>
        ))}
      </DropdownMenu>
      <DropdownMenu
        open={tokenMenu}
        onOpenChange={setTokenMenu}
        anchorRef={tokenRef}
        width={220}
        placement="bottom-end"
      >
        <MenuLabel>Typography tokens</MenuLabel>
        {typoTokens.length === 0 && <MenuItem disabled>No typography tokens</MenuItem>}
        {typoTokens.map(([name, t]) => {
          const prop =
            t.type === 'fontFamily' || name.startsWith('--font-')
              ? 'fontFamily'
              : name.startsWith('--leading-')
                ? 'lineHeight'
                : name.startsWith('--tracking-')
                  ? 'letterSpacing'
                  : 'fontSize'
          return (
            <MenuItem
              key={name}
              shortcut={String(t.value)}
              onSelect={() => edit(() => ({ [prop]: `var(${name})` }))}
            >
              {name.replace(/^--/, '')}
            </MenuItem>
          )
        })}
      </DropdownMenu>
    </InspectorSection>
  )
}
