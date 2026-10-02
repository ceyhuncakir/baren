/**
 * Fill and Stroke for vector layers (artboard 30). Paint lives in ordinary style keys on the
 * vector (`fill`, `stroke`, `strokeWidth`, `strokeLinecap`, `strokeLinejoin`,
 * `strokeDasharray`; contract §2.6); tokens work like any colour.
 */
import {
  CollapsedSection,
  EyeIcon,
  EyeOffIcon,
  IconToggleGroup,
  ImageIcon,
  InspectorRow,
  InspectorSection,
  MinusIcon,
  NumberField,
  PlusIcon,
  SectionHeaderAction,
  StrokeWeightIcon,
  toast,
} from '@baren/ui'
import { MIXED, common } from '../../model/styles'
import {
  addVectorPaintPatch,
  dashPatch,
  readCap,
  readDash,
  readJoin,
  readStrokeWidth,
  readVectorPaint,
  removeVectorPaintPatch,
  toggleVectorPaintPatch,
  vectorPaintColorPatch,
  type PaintProp,
  type StrokeCap,
  type StrokeDash,
  type StrokeJoin,
} from '../../model/vectorPaint'
import type { NodesSnapshot } from '../../session/docEvents'
import { MenuSelect, PaintField, paintFromValues } from '../controls'
import { useStyleEdit } from '../hooks'
import { SectionTitle } from '../marks'
import { nullable } from './LayoutSection'
import css from '../Inspector.module.css'

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

function PaintTools({
  prop,
  hidden,
  edit,
}: {
  prop: PaintProp
  hidden: boolean
  edit: ReturnType<typeof useStyleEdit>
}) {
  const label = prop === 'fill' ? 'fill' : 'stroke'
  return (
    <span className={css.fillTools}>
      <SectionHeaderAction
        label={hidden ? `Show ${label}` : `Hide ${label}`}
        active={hidden}
        style={{ marginRight: 0 }}
        onClick={() =>
          edit((styles) => {
            const p = readVectorPaint(styles, prop)
            return p ? toggleVectorPaintPatch(p) : null
          })
        }
      >
        {hidden ? <EyeOffIcon size={13} /> : <EyeIcon size={13} />}
      </SectionHeaderAction>
      <SectionHeaderAction
        label={`Remove ${label}`}
        style={{ width: 18, marginRight: 0 }}
        onClick={() => edit(() => removeVectorPaintPatch(prop))}
      >
        <MinusIcon size={13} />
      </SectionHeaderAction>
    </span>
  )
}

export function VectorFillSection({ snapshot }: { snapshot: NodesSnapshot }) {
  const edit = useStyleEdit()
  const paints = snapshot.nodes.map((n) => readVectorPaint(n.styles, 'fill'))
  const present = paints.filter((p) => p !== null)
  const add = (
    <SectionHeaderAction label="Add fill" onClick={() => edit(() => addVectorPaintPatch('fill'))}>
      <PlusIcon size={13} />
    </SectionHeaderAction>
  )
  if (present.length === 0) {
    return <InspectorSection title={<SectionTitle name="Fill" />} actions={add} />
  }
  const hidden = present.every((p) => p.hidden)
  return (
    <InspectorSection title={<SectionTitle name="Fill" />} actions={add}>
      <InspectorRow>
        <IconToggleGroup
          itemWidth={26}
          value="solid"
          onChange={(k) => {
            if (k !== 'solid') toast('Vector fills are solid colours for now.')
          }}
          options={FILL_KINDS}
        />
        <span className={css.spacer} />
        <PaintTools prop="fill" hidden={hidden} edit={edit} />
      </InspectorRow>
      <PaintField
        value={paintFromValues(present.map((p) => p.color))}
        onChange={(value, final) =>
          edit(
            (styles) => vectorPaintColorPatch(readVectorPaint(styles, 'fill'), 'fill', value),
            final,
          )
        }
      />
    </InspectorSection>
  )
}

const CAPS: { value: StrokeCap; label: string; cap: 'butt' | 'round' | 'square' }[] = [
  { value: 'butt', label: 'Butt cap', cap: 'butt' },
  { value: 'round', label: 'Round cap', cap: 'round' },
  { value: 'square', label: 'Square cap', cap: 'square' },
]
const JOINS: { value: StrokeJoin; label: string }[] = [
  { value: 'miter', label: 'Miter join' },
  { value: 'round', label: 'Round join' },
  { value: 'bevel', label: 'Bevel join' },
]

/** A thick bar ending at the path end (selection-colour guide line), drawn with each cap. */
function CapGlyph({ cap, active }: { cap: StrokeCap; active: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden>
      <path
        d="M1 12H12"
        fill="none"
        stroke={active ? 'var(--color-foreground)' : 'var(--color-foreground-muted)'}
        strokeWidth="10"
        strokeLinecap={cap}
      />
      <path d="M12 2V22" fill="none" stroke="var(--color-selection)" strokeWidth="1.5" />
    </svg>
  )
}

function JoinGlyph({ join, active }: { join: StrokeJoin; active: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden>
      <path
        d="M7 22V7H22"
        fill="none"
        stroke={active ? 'var(--color-foreground)' : 'var(--color-foreground-muted)'}
        strokeWidth="7"
        strokeLinejoin={join}
      />
    </svg>
  )
}

const DASHES: { value: StrokeDash; label: string }[] = [
  { value: 'solid', label: 'Solid' },
  { value: 'dashed', label: 'Dashed' },
  { value: 'dotted', label: 'Dotted' },
]

export function VectorStrokeSection({ snapshot }: { snapshot: NodesSnapshot }) {
  const edit = useStyleEdit()
  const nodes = snapshot.nodes
  const paints = nodes.map((n) => readVectorPaint(n.styles, 'stroke'))
  const present = paints.filter((p) => p !== null)
  if (present.length === 0) {
    return (
      <CollapsedSection title="Stroke" onClick={() => edit(() => addVectorPaintPatch('stroke'))} />
    )
  }
  const hidden = present.every((p) => p.hidden)
  const width = common(nodes.map((n) => readStrokeWidth(n.styles)))
  const cap = common(nodes.map((n) => readCap(n.styles)))
  const join = common(nodes.map((n) => readJoin(n.styles)))
  const dash = common(nodes.map((n) => readDash(n.styles)))
  return (
    <InspectorSection
      title={<SectionTitle name="Stroke" />}
      actions={
        <SectionHeaderAction
          label="Add stroke"
          onClick={() =>
            edit((s) => (readVectorPaint(s, 'stroke') ? null : addVectorPaintPatch('stroke')))
          }
        >
          <PlusIcon size={13} />
        </SectionHeaderAction>
      }
    >
      <InspectorRow>
        <div className={css.strokeField}>
          <PaintField
            value={paintFromValues(present.map((p) => p.color))}
            onChange={(value, final) =>
              edit(
                (styles) =>
                  vectorPaintColorPatch(readVectorPaint(styles, 'stroke'), 'stroke', value),
                final,
              )
            }
          />
        </div>
        <PaintTools prop="stroke" hidden={hidden} edit={edit} />
      </InspectorRow>
      <InspectorRow>
        <NumberField
          prefix={<StrokeWeightIcon size={11} />}
          value={nullable(width)}
          min={0}
          onChange={(v, m) => edit(() => ({ strokeWidth: Math.max(0, v) }), m.final)}
          aria-label="Stroke weight"
        />
        <MenuSelect<StrokeDash>
          prefix={
            <svg width="11" height="11" viewBox="0 0 24 24" aria-hidden>
              <path
                d="M3 12h18"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeDasharray={dash === 'dashed' ? '5 4' : dash === 'dotted' ? '0 5' : undefined}
              />
            </svg>
          }
          value={dash}
          options={DASHES}
          onChange={(d) => edit((styles) => dashPatch(styles, d))}
          aria-label="Stroke dash"
        />
      </InspectorRow>
      <InspectorRow>
        <span className={css.strokeLabel}>Cap</span>
        <div className={css.strokeField}>
          <IconToggleGroup<StrokeCap>
            fullWidth
            value={cap === MIXED || cap === undefined ? 'butt' : cap}
            onChange={(c) => edit(() => ({ strokeLinecap: c === 'butt' ? null : c }))}
            options={CAPS.map((c) => ({
              value: c.value,
              'aria-label': c.label,
              icon: <CapGlyph cap={c.cap} active={cap === c.value} />,
            }))}
          />
        </div>
      </InspectorRow>
      <InspectorRow>
        <span className={css.strokeLabel}>Join</span>
        <div className={css.strokeField}>
          <IconToggleGroup<StrokeJoin>
            fullWidth
            value={join === MIXED || join === undefined ? 'miter' : join}
            onChange={(j) => edit(() => ({ strokeLinejoin: j === 'miter' ? null : j }))}
            options={JOINS.map((j) => ({
              value: j.value,
              'aria-label': j.label,
              icon: <JoinGlyph join={j.value} active={join === j.value} />,
            }))}
          />
        </div>
      </InspectorRow>
    </InspectorSection>
  )
}
