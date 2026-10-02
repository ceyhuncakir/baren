/**
 * Flex (artboard 06): alignment grid, direction, wrap, gap (with presets and
 * space-between), padding (4 sides or horizontal/vertical) and clip content (Alt+C).
 * Frames without flex layout show a collapsed "Flex +" row that adds it.
 */
import {
  AlignmentGrid,
  ArrowDownIcon,
  ArrowRightIcon,
  Checkbox,
  CollapsedSection,
  DropdownMenu,
  FieldIconButton,
  GapIcon,
  IconToggleGroup,
  InspectorColumn,
  InspectorRow,
  InspectorSection,
  MenuItem,
  MenuSeparator,
  MinusIcon,
  NumberField,
  PaddingBottomIcon,
  PaddingIndividualIcon,
  PaddingLeftIcon,
  PaddingRightIcon,
  PaddingTopIcon,
  SectionHeaderAction,
  WrapIcon,
  type NumberChangeMeta,
} from '@baren/ui'
import type { StylePatch } from '@baren/schema'
import { useRef, useState, type ReactNode } from 'react'
import {
  MIXED,
  addFlexPatch,
  alignmentPatch,
  common,
  flexDirection,
  isFlex,
  paddingPatch,
  pxValue,
  readAlignment,
  readGap,
  readPadding,
  removeFlexPatch,
  type FlexDirection,
  type Sides,
} from '../../model/styles'
import type { NodesSnapshot } from '../../session/docEvents'
import { useStyleEdit } from '../hooks'
import { nullable } from './LayoutSection'
import css from '../Inspector.module.css'

const GAP_PRESETS = [0, 4, 8, 12, 16, 24, 32, 48, 64, 72, 96]

const DIRECTIONS = [
  {
    value: 'column' as const,
    icon: <ArrowDownIcon size={12} strokeWidth={2.25} />,
    'aria-label': 'Vertical',
  },
  {
    value: 'row' as const,
    icon: <ArrowRightIcon size={12} strokeWidth={2.25} />,
    'aria-label': 'Horizontal',
  },
]

export function FlexSection({ snapshot }: { snapshot: NodesSnapshot }) {
  const edit = useStyleEdit()
  const frames = snapshot.nodes.filter((n) => n.type === 'frame')
  const flexNodes = frames.filter((n) => isFlex(n.styles))
  const [individual, setIndividual] = useState(true)
  const [gapMenu, setGapMenu] = useState(false)
  const gapRef = useRef<HTMLElement | null>(null)

  if (frames.length === 0) return null
  if (flexNodes.length !== frames.length) {
    return (
      <CollapsedSection
        title="Flex"
        onClick={() => edit((s) => (isFlex(s) ? null : addFlexPatch()))}
      />
    )
  }

  const first = flexNodes[0]?.styles ?? {}
  const direction = common(flexNodes.map((n) => flexDirection(n.styles)))
  const dir: FlexDirection = direction === MIXED || direction === undefined ? 'column' : direction
  const alignment = readAlignment(first)
  const gap = common(flexNodes.map((n) => readGap(n.styles)))
  const spread = flexNodes.every((n) => readAlignment(n.styles).distribution === 'space-between')
  const pads = flexNodes.map((n) => readPadding(n.styles))
  const side = (k: keyof Sides) => common(pads.map((p) => p[k]))
  const wraps = flexNodes.every((n) => n.styles['flexWrap'] === 'wrap')
  const clips = common(
    flexNodes.map((n) => n.styles['overflow'] === 'hidden' || n.styles['overflow'] === 'clip'),
  )

  const setSide = (k: keyof Sides | 'x' | 'y', v: number, meta: NumberChangeMeta) =>
    edit((styles) => {
      const cur = readPadding(styles)
      const next = { ...cur }
      if (k === 'x') next.left = next.right = v
      else if (k === 'y') next.top = next.bottom = v
      else next[k] = v
      return paddingPatch(styles, next)
    }, meta.final)

  const setGap = (v: number, meta: NumberChangeMeta) =>
    edit(
      (styles) => ({
        gap: pxValue(styles['gap'], Math.max(0, v)),
        rowGap: null,
        columnGap: null,
        ...(styles['justifyContent'] === 'space-between' ? { justifyContent: null } : {}),
      }),
      meta.final,
    )

  const padField = (k: keyof Sides, icon: ReactNode, label: string) => (
    <NumberField
      prefix={icon}
      prefixStrong
      value={nullable(side(k))}
      min={0}
      onChange={(v, m) => setSide(k, v, m)}
      aria-label={label}
    />
  )

  return (
    <InspectorSection
      title="Flex"
      actions={
        <SectionHeaderAction
          label="Remove flex layout"
          onClick={() => edit(() => removeFlexPatch())}
        >
          <MinusIcon size={13} />
        </SectionHeaderAction>
      }
    >
      <InspectorRow>
        <AlignmentGrid
          value={{ x: alignment.x, y: alignment.y }}
          direction={dir}
          distribution={spread ? 'space-between' : 'packed'}
          onChange={(a) => edit((styles) => alignmentPatch(styles, a, true))}
          aria-label="Alignment"
        />
        <InspectorColumn>
          <InspectorRow>
            <IconToggleGroup
              fullWidth
              value={dir}
              onChange={(d) => edit(() => ({ flexDirection: d === 'row' ? null : 'column' }))}
              options={DIRECTIONS}
              style={{ flex: '1 1 0' }}
            />
            <FieldIconButton
              label={wraps ? 'Do not wrap' : 'Wrap'}
              active={wraps}
              onClick={() => edit(() => ({ flexWrap: wraps ? null : 'wrap' }))}
            >
              <WrapIcon size={12} />
            </FieldIconButton>
          </InspectorRow>
          <NumberField
            prefix={<GapIcon size={11} />}
            value={spread ? null : nullable(gap)}
            placeholder={spread ? 'Auto' : 'Mixed'}
            className={spread ? css.modeField : undefined}
            min={0}
            chevron
            onChevronClick={() => setGapMenu(true)}
            inputRef={(el) => void (gapRef.current = el?.parentElement ?? null)}
            onChange={setGap}
            aria-label="Gap"
          />
        </InspectorColumn>
      </InspectorRow>
      {individual ? (
        <InspectorRow alignTop>
          <InspectorColumn>
            <InspectorRow>
              {padField('left', <PaddingLeftIcon size={11} />, 'Padding left')}
              {padField('top', <PaddingTopIcon size={11} />, 'Padding top')}
            </InspectorRow>
            <InspectorRow>
              {padField('right', <PaddingRightIcon size={11} />, 'Padding right')}
              {padField('bottom', <PaddingBottomIcon size={11} />, 'Padding bottom')}
            </InspectorRow>
          </InspectorColumn>
          <FieldIconButton label="Uniform padding" active onClick={() => setIndividual(false)}>
            <PaddingIndividualIcon size={12} />
          </FieldIconButton>
        </InspectorRow>
      ) : (
        <InspectorRow>
          <NumberField
            prefix={<PaddingLeftIcon size={11} />}
            prefixStrong
            value={pair(side('left'), side('right'))}
            min={0}
            onChange={(v, m) => setSide('x', v, m)}
            aria-label="Horizontal padding"
          />
          <NumberField
            prefix={<PaddingTopIcon size={11} />}
            prefixStrong
            value={pair(side('top'), side('bottom'))}
            min={0}
            onChange={(v, m) => setSide('y', v, m)}
            aria-label="Vertical padding"
          />
          <FieldIconButton label="Individual padding" onClick={() => setIndividual(true)}>
            <PaddingIndividualIcon size={12} />
          </FieldIconButton>
        </InspectorRow>
      )}
      <div className={css.clipRow}>
        <Checkbox
          size="sm"
          label="Clip content"
          shortcut="Alt+C"
          checked={clips === true}
          indeterminate={clips === MIXED}
          onCheckedChange={(on) => edit(() => ({ overflow: on ? 'hidden' : null }))}
        />
      </div>
      <DropdownMenu open={gapMenu} onOpenChange={setGapMenu} anchorRef={gapRef} width={160}>
        <MenuItem
          checked={spread}
          onSelect={() =>
            edit((): StylePatch =>
              spread ? { justifyContent: null } : { justifyContent: 'space-between', gap: null },
            )
          }
        >
          Auto (space between)
        </MenuItem>
        <MenuSeparator />
        {GAP_PRESETS.map((g) => (
          <MenuItem
            key={g}
            checked={!spread && gap === g}
            onSelect={() => setGap(g, { final: true })}
          >
            {g}
          </MenuItem>
        ))}
      </DropdownMenu>
    </InspectorSection>
  )
}

/** Shared value of two sides, or null ("Mixed") when they differ. */
function pair(
  a: number | typeof MIXED | undefined,
  b: number | typeof MIXED | undefined,
): number | null {
  return typeof a === 'number' && a === b ? a : null
}
