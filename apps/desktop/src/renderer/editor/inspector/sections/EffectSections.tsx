/**
 * Outline, Border, Shadow, Inner shadow and Filters (artboards 06/14 show them collapsed:
 * "Outline +"). Clicking a collapsed row adds a first entry; each entry can be edited
 * and removed. Values are written as plain CSS (outline, border*, box-shadow, filter).
 */
import {
  CollapsedSection,
  InspectorRow,
  InspectorSection,
  MinusIcon,
  NumberField,
  PlusIcon,
  SectionHeaderAction,
} from '@baren/ui'
import type { DesignNode } from '@baren/schema'
import {
  FILTER_KINDS,
  borderPatch,
  defaultShadow,
  formatFilters,
  formatShadows,
  parseFilters,
  parseShadows,
  readBorder,
  readOutline,
  outlinePatch,
  type Filter,
  type FilterFn,
  type Shadow,
  type Stroke,
} from '../../model/effects'
import { common } from '../../model/styles'
import type { NodesSnapshot } from '../../session/docEvents'
import { MenuSelect, PaintField, paintFromValues } from '../controls'
import { useStyleEdit } from '../hooks'
import { nullable } from './LayoutSection'
import css from '../Inspector.module.css'

const STROKE_STYLES = ['solid', 'dashed', 'dotted'] as const

function StrokeSection({
  title,
  nodes,
  read,
  write,
}: {
  title: string
  nodes: readonly DesignNode[]
  read: (n: DesignNode) => Stroke | null
  write: (next: Stroke | null) => Record<string, string | number | null>
}) {
  const edit = useStyleEdit()
  const strokes = nodes.map(read)
  const present = strokes.filter((s): s is Stroke => s !== null)
  if (present.length === 0) {
    return (
      <CollapsedSection
        title={title}
        onClick={() =>
          edit(() => write({ width: 1, style: 'solid', color: null, colorText: '#000000' }))
        }
      />
    )
  }
  const width = common(present.map((s) => s.width))
  const style = common(present.map((s) => s.style))
  const update = (fn: (s: Stroke) => Stroke, final = true) =>
    edit((styles, id) => {
      const node = nodes.find((n) => n.id === id)
      const cur = node ? read({ ...node, styles }) : null
      return cur ? write(fn(cur)) : null
    }, final)
  return (
    <InspectorSection
      title={title}
      actions={
        <SectionHeaderAction
          label={`Remove ${title.toLowerCase()}`}
          onClick={() => edit(() => write(null))}
        >
          <MinusIcon size={13} />
        </SectionHeaderAction>
      }
    >
      <PaintField
        value={paintFromValues(present.map((s) => s.color))}
        tokens={false}
        onChange={(cssValue, final) => update((s) => ({ ...s, colorText: cssValue }), final)}
      />
      <InspectorRow>
        <NumberField
          prefix="W"
          value={nullable(width)}
          min={0}
          step={1}
          onChange={(v, m) => update((s) => ({ ...s, width: v }), m.final)}
          aria-label={`${title} width`}
        />
        <MenuSelect
          value={style}
          options={STROKE_STYLES.map((s) => ({
            value: s,
            label: s.charAt(0).toUpperCase() + s.slice(1),
          }))}
          onChange={(v) => update((s) => ({ ...s, style: v }))}
          aria-label={`${title} style`}
        />
      </InspectorRow>
    </InspectorSection>
  )
}

function ShadowSection({ nodes, inset }: { nodes: readonly DesignNode[]; inset: boolean }) {
  const edit = useStyleEdit()
  const title = inset ? 'Inner shadow' : 'Shadow'
  const lists = nodes.map((n) =>
    parseShadows(n.styles['boxShadow']).filter((s) => s.inset === inset),
  )
  const first = lists[0] ?? []
  const consistent = lists.every((l) => l.length === first.length)
  const rewrite = (fn: (own: Shadow[]) => Shadow[], final = true) =>
    edit((styles) => {
      const all = parseShadows(styles['boxShadow'])
      const own = all.filter((s) => s.inset === inset)
      const other = all.filter((s) => s.inset !== inset)
      const next = fn(own)
      return { boxShadow: formatShadows(inset ? [...other, ...next] : [...next, ...other]) }
    }, final)

  if (lists.every((l) => l.length === 0)) {
    return (
      <CollapsedSection
        title={title}
        onClick={() => rewrite((own) => [...own, defaultShadow(inset)])}
      />
    )
  }
  return (
    <InspectorSection
      title={title}
      actions={
        <SectionHeaderAction
          label={`Add ${title.toLowerCase()}`}
          onClick={() => rewrite((own) => [...own, defaultShadow(inset)])}
        >
          <PlusIcon size={13} />
        </SectionHeaderAction>
      }
    >
      {!consistent && <div className={css.statusLine}>Mixed shadows</div>}
      {consistent &&
        first.map((_shadow, index) => {
          const at = (fn: (s: Shadow) => Shadow, final = true) =>
            rewrite((own) => own.map((s, i) => (i === index ? fn(s) : s)), final)
          const num = (key: 'x' | 'y' | 'blur' | 'spread', label: string) => (
            <NumberField
              prefix={label}
              value={nullable(common(lists.map((l) => l[index]?.[key] ?? 0)))}
              {...(key === 'blur' ? { min: 0 } : {})}
              onChange={(v, m) => at((s) => ({ ...s, [key]: v }), m.final)}
              aria-label={`${title} ${key}`}
            />
          )
          return (
            <div key={index} className={css.effectRow}>
              <InspectorRow>
                <div style={{ flex: '1 1 0', minWidth: 0 }}>
                  <PaintField
                    value={paintFromValues(lists.map((l) => l[index]?.color ?? null))}
                    tokens={false}
                    onChange={(cssValue, final) =>
                      at((s) => ({ ...s, colorText: cssValue }), final)
                    }
                  />
                </div>
                <button
                  type="button"
                  className={css.removeButton}
                  aria-label={`Remove ${title.toLowerCase()}`}
                  onClick={() => rewrite((own) => own.filter((_, i) => i !== index))}
                >
                  <MinusIcon size={13} />
                </button>
              </InspectorRow>
              <div className={css.effectGrid}>
                {num('x', 'X')}
                {num('y', 'Y')}
                {num('blur', 'B')}
                {num('spread', 'S')}
              </div>
            </div>
          )
        })}
    </InspectorSection>
  )
}

function FiltersSection({ nodes }: { nodes: readonly DesignNode[] }) {
  const edit = useStyleEdit()
  const lists = nodes.map((n) => parseFilters(n.styles['filter']))
  const first = lists[0] ?? []
  const consistent = lists.every((l) => l.length === first.length)
  const rewrite = (fn: (list: Filter[]) => Filter[], final = true) =>
    edit((styles) => ({ filter: formatFilters(fn(parseFilters(styles['filter']))) }), final)
  const add = () =>
    rewrite((list) => {
      const used = new Set(list.map((f) => f.fn))
      const kind = FILTER_KINDS.find((k) => !used.has(k.fn)) ?? FILTER_KINDS[0]
      return [...list, { fn: kind.fn, amount: kind.initial }]
    })
  if (lists.every((l) => l.length === 0)) return <CollapsedSection title="Filters" onClick={add} />
  return (
    <InspectorSection
      title="Filters"
      actions={
        <SectionHeaderAction label="Add filter" onClick={add}>
          <PlusIcon size={13} />
        </SectionHeaderAction>
      }
    >
      {!consistent && <div className={css.statusLine}>Mixed filters</div>}
      {consistent &&
        first.map((f, index) => {
          const kind = FILTER_KINDS.find((k) => k.fn === f.fn) ?? FILTER_KINDS[0]
          return (
            <InspectorRow key={`${f.fn}-${index}`}>
              <MenuSelect<FilterFn>
                value={f.fn}
                options={FILTER_KINDS.map((k) => ({ value: k.fn, label: k.label }))}
                onChange={(fn) => {
                  const next = FILTER_KINDS.find((k) => k.fn === fn) ?? kind
                  rewrite((list) =>
                    list.map((x, i) => (i === index ? { fn, amount: next.initial } : x)),
                  )
                }}
                aria-label="Filter"
              />
              <NumberField
                value={nullable(common(lists.map((l) => l[index]?.amount ?? 0)))}
                unit={kind.unit === '%' ? '%' : ''}
                min={0}
                max={kind.max}
                width={72}
                onChange={(v, m) =>
                  rewrite(
                    (list) => list.map((x, i) => (i === index ? { ...x, amount: v } : x)),
                    m.final,
                  )
                }
                aria-label={`${kind.label} amount`}
              />
              <button
                type="button"
                className={css.removeButton}
                aria-label="Remove filter"
                onClick={() => rewrite((list) => list.filter((_, i) => i !== index))}
              >
                <MinusIcon size={13} />
              </button>
            </InspectorRow>
          )
        })}
    </InspectorSection>
  )
}

export type EffectKind = 'outline' | 'border' | 'shadow' | 'inner' | 'filters'

/**
 * The five effect sections, in reference order. Vectors and groups get Shadow and Filters only
 * (artboard 30): box outlines and borders do not follow a path or a group's content.
 */
export function EffectSections({
  snapshot,
  only,
}: {
  snapshot: NodesSnapshot
  only?: readonly EffectKind[]
}) {
  const nodes = snapshot.nodes
  const show = (k: EffectKind) => !only || only.includes(k)
  return (
    <div>
      {show('outline') && (
        <StrokeSection
          title="Outline"
          nodes={nodes}
          read={(n) => readOutline(n.styles)}
          write={outlinePatch}
        />
      )}
      {show('border') && (
        <StrokeSection
          title="Border"
          nodes={nodes}
          read={(n) => readBorder(n.styles)}
          write={borderPatch}
        />
      )}
      {show('shadow') && <ShadowSection nodes={nodes} inset={false} />}
      {show('inner') && <ShadowSection nodes={nodes} inset />}
      {show('filters') && <FiltersSection nodes={nodes} />}
    </div>
  )
}
