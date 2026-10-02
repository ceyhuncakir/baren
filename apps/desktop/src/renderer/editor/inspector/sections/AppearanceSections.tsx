/**
 * Radius, Blending and Fill sections (artboards 06 and 14).
 */
import {
  CornersIcon,
  DropdownMenu,
  DropletIcon,
  EyeIcon,
  EyeOffIcon,
  IconToggleGroup,
  ImageIcon,
  InspectorRow,
  InspectorSection,
  MenuItem,
  MinusIcon,
  NumberField,
  OpacityIcon,
  PlusIcon,
  SectionHeaderAction,
  Slider,
  toast,
} from '@baren/ui'
import type { StylePatch, Styles } from '@baren/schema'
import { useRef, useState } from 'react'
import {
  addFillPatch,
  fillKindPatch,
  gradientWithColor,
  readFill,
  removeFillPatch,
  solidFillPatch,
  toggleFillPatch,
  type FillKind,
} from '../../model/effects'
import { setFlag } from '../../model/docOps'
import {
  BLEND_MODES,
  MIXED,
  blendLabel,
  common,
  opacityPatch,
  pxValue,
  radiusPatch,
  readBlendMode,
  readOpacity,
  readRadius,
  toPx,
  type BlendMode,
} from '../../model/styles'
import { useEditor } from '../../session/context'
import type { NodesSnapshot } from '../../session/docEvents'
import { MenuSelect, PaintField, paintFromValues } from '../controls'
import { useStyleEdit } from '../hooks'
import { ImageFillBody, chooseImageFill } from './ImageSections'
import { nullable } from './LayoutSection'
import { SectionTitle } from '../marks'
import css from '../Inspector.module.css'

const RADIUS_PRESETS = [0, 2, 4, 6, 8, 12, 16, 24, 9999]

export function RadiusSection({ snapshot }: { snapshot: NodesSnapshot }) {
  const edit = useStyleEdit()
  const [individual, setIndividual] = useState(false)
  const radius = common(
    snapshot.nodes.map((n) => readRadius(n.styles)).map((r) => (r === MIXED ? -1 : r)),
  )
  const value = typeof radius === 'number' && radius >= 0 ? radius : null
  const corner = (key: string, label: string) => (
    <NumberField
      prefix={label}
      value={nullable(common(snapshot.nodes.map((n) => readCorner(n.styles, key) ?? 0)))}
      min={0}
      onChange={(v, m) => edit((styles) => cornerPatch(styles, key, v), m.final)}
      aria-label={`${label} radius`}
    />
  )
  return (
    <InspectorSection
      title={<SectionTitle name="Radius" />}
      actions={
        <SectionHeaderAction
          label="Individual corners"
          active={individual}
          onClick={() => setIndividual((v) => !v)}
        >
          <CornersIcon size={12} />
        </SectionHeaderAction>
      }
    >
      {individual ? (
        <>
          <InspectorRow>
            {corner('borderTopLeftRadius', 'TL')}
            {corner('borderTopRightRadius', 'TR')}
          </InspectorRow>
          <InspectorRow>
            {corner('borderBottomLeftRadius', 'BL')}
            {corner('borderBottomRightRadius', 'BR')}
          </InspectorRow>
        </>
      ) : (
        <InspectorRow style={{ gap: 10 }}>
          <Slider
            aria-label="Radius"
            value={Math.min(100, value ?? 0)}
            max={100}
            onChange={(v) => edit((styles) => radiusPatch(styles, v), false)}
            onChangeEnd={(v) => edit((styles) => radiusPatch(styles, v), true)}
          />
          <MenuNumber
            value={value}
            presets={RADIUS_PRESETS}
            onChange={(v, final) => edit((styles) => radiusPatch(styles, v), final)}
          />
        </InspectorRow>
      )}
    </InspectorSection>
  )
}

const CORNER_KEYS = [
  'borderTopLeftRadius',
  'borderTopRightRadius',
  'borderBottomRightRadius',
  'borderBottomLeftRadius',
] as const

/** Set one corner, writing all four as longhands (the shorthand is removed). */
function cornerPatch(styles: Styles, key: string, value: number): StylePatch {
  const patch: StylePatch = { borderRadius: null }
  for (const k of CORNER_KEYS)
    patch[k] = pxValue(undefined, k === key ? value : (readCorner(styles, k) ?? 0))
  return patch
}

function readCorner(styles: Styles, key: string): number | null {
  const v = styles[key]
  if (v === undefined) {
    const r = readRadius(styles)
    return typeof r === 'number' ? r : null
  }
  return toPx(v) ?? 0
}

/** Radius number field with a presets menu on its chevron. */
function MenuNumber({
  value,
  presets,
  onChange,
}: {
  value: number | null
  presets: readonly number[]
  onChange: (v: number, final: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLElement | null>(null)
  return (
    <>
      <NumberField
        value={value}
        min={0}
        width={72}
        chevron
        onChevronClick={() => setOpen((v) => !v)}
        inputRef={(el) => void (anchor.current = el?.parentElement ?? null)}
        onChange={(v, m) => onChange(v, m.final)}
        aria-label="Radius value"
      />
      <DropdownMenu
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchor}
        width={140}
        placement="bottom-end"
      >
        {presets.map((p) => (
          <MenuItem key={p} checked={value === p} onSelect={() => onChange(p, true)}>
            {p === 9999 ? 'Full' : String(p)}
          </MenuItem>
        ))}
      </DropdownMenu>
    </>
  )
}

export function BlendingSection({ snapshot }: { snapshot: NodesSnapshot }) {
  const { doc } = useEditor()
  const edit = useStyleEdit()
  const nodes = snapshot.nodes
  const opacity = common(nodes.map((n) => readOpacity(n.styles)))
  const blend = common(nodes.map((n) => readBlendMode(n.styles)))
  const hidden = nodes.length > 0 && nodes.every((n) => n.hidden === true)
  return (
    <InspectorSection
      title={<SectionTitle name="Blending" />}
      actions={
        <SectionHeaderAction
          label={hidden ? 'Show layer' : 'Hide layer'}
          active={hidden}
          onClick={() =>
            setFlag(
              doc,
              nodes.map((n) => n.id),
              'hidden',
              !hidden,
            )
          }
        >
          {hidden ? <EyeOffIcon size={13} /> : <EyeIcon size={13} />}
        </SectionHeaderAction>
      }
    >
      <InspectorRow>
        <NumberField
          prefix={<OpacityIcon size={11} />}
          value={nullable(opacity)}
          unit="%"
          min={0}
          max={100}
          onChange={(v, m) => edit(() => opacityPatch(v), m.final)}
          aria-label="Opacity"
        />
        <MenuSelect<BlendMode>
          prefix={<DropletIcon size={11} />}
          value={blend}
          options={BLEND_MODES.map((m) => ({ value: m, label: blendLabel(m) }))}
          onChange={(m) => edit(() => ({ mixBlendMode: m === 'normal' ? null : m }))}
          menuWidth={180}
          aria-label="Blend mode"
        />
      </InspectorRow>
    </InspectorSection>
  )
}

const FILL_KINDS = [
  {
    value: 'solid' as const,
    icon: <span className={css.fillTypeIcon} style={{ background: 'var(--color-glyph-muted)' }} />,
    'aria-label': 'Solid',
  },
  {
    value: 'gradient' as const,
    icon: (
      <span
        className={css.fillTypeIcon}
        style={{ background: 'linear-gradient(90deg, #E8E8E8, #9A9A9A)' }}
      />
    ),
    'aria-label': 'Gradient',
  },
  { value: 'image' as const, icon: <ImageIcon size={12} />, 'aria-label': 'Image' },
]

export function FillSection({ snapshot }: { snapshot: NodesSnapshot }) {
  const session = useEditor()
  const edit = useStyleEdit()
  const nodes = snapshot.nodes
  const fills = nodes.map((n) => readFill(n.styles, n.type))
  const present = fills.filter((f) => f !== null)
  const typeOf = (id: string) => nodes.find((n) => n.id === id)?.type ?? 'frame'

  if (present.length === 0) {
    return (
      <InspectorSection
        title={<SectionTitle name="Fill" />}
        actions={
          <SectionHeaderAction
            label="Add fill"
            onClick={() => edit((_s, id) => addFillPatch(typeOf(id)))}
          >
            <PlusIcon size={13} />
          </SectionHeaderAction>
        }
      />
    )
  }

  const kind = common(present.map((f) => f.kind))
  const hidden = present.every((f) => f.hidden)
  const paint = paintFromValues(present.map((f) => f.color))
  const isText = nodes.every((n) => n.type === 'text')

  const setColor = (cssValue: string, final: boolean) =>
    edit((styles, id) => {
      const fill = readFill(styles, typeOf(id))
      if (fill?.kind === 'gradient')
        return { backgroundImage: gradientWithColor(fill.value, cssValue) }
      return solidFillPatch(fill, typeOf(id), cssValue)
    }, final)

  const setKind = async (k: FillKind) => {
    if (isText && k !== 'solid') {
      toast('Text fills are solid colors for now.')
      return
    }
    if (k === 'image') {
      if (kind !== 'image')
        await chooseImageFill(
          session,
          nodes.map((n) => n.id),
        )
      return
    }
    edit((styles, id) => fillKindPatch(readFill(styles, typeOf(id)), typeOf(id), k))
  }

  return (
    <InspectorSection
      title={<SectionTitle name="Fill" />}
      actions={
        <SectionHeaderAction
          label="Add fill"
          onClick={() =>
            edit((s, id) => (readFill(s, typeOf(id)) ? null : addFillPatch(typeOf(id))))
          }
        >
          <PlusIcon size={13} />
        </SectionHeaderAction>
      }
    >
      <InspectorRow>
        <IconToggleGroup<FillKind>
          itemWidth={26}
          value={kind === MIXED || kind === undefined ? 'solid' : kind}
          onChange={(k) => void setKind(k)}
          options={FILL_KINDS}
        />
        <span className={css.spacer} />
        <span className={css.fillTools}>
          <SectionHeaderAction
            label={hidden ? 'Show fill' : 'Hide fill'}
            active={hidden}
            style={{ marginRight: 0 }}
            onClick={() =>
              edit((styles, id) => {
                const f = readFill(styles, typeOf(id))
                return f ? toggleFillPatch(f) : null
              })
            }
          >
            {hidden ? <EyeOffIcon size={13} /> : <EyeIcon size={13} />}
          </SectionHeaderAction>
          <SectionHeaderAction
            label="Remove fill"
            style={{ width: 18, marginRight: 0 }}
            onClick={() =>
              edit((styles, id) => {
                const f = readFill(styles, typeOf(id))
                return f ? removeFillPatch(f) : null
              })
            }
          >
            <MinusIcon size={13} />
          </SectionHeaderAction>
        </span>
      </InspectorRow>
      {kind === 'image' ? (
        <ImageFillBody snapshot={snapshot} />
      ) : (
        <PaintField value={paint} onChange={setColor} />
      )}
    </InspectorSection>
  )
}
