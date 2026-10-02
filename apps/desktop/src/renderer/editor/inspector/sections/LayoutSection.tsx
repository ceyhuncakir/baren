/**
 * Layout (artboards 06, 14): X / Y / rotation, W / H with Fixed · Hug (Fit) · Fill modes,
 * aspect lock and flip. Multi-selection shows "Mixed" where values differ.
 */
import {
  DropdownMenu,
  DuplicateIcon,
  FlipIcon,
  InspectorRow,
  InspectorSection,
  MaximizeIcon,
  MenuItem,
  NumberField,
  RotationIcon,
  SectionHeaderAction,
  SplitField,
  type NumberChangeMeta,
} from '@baren/ui'
import {
  fitGroups,
  isTreeId,
  readRotation as readSchemaRotation,
  resizeGroup,
  rotationValue,
  scaleVector,
  setRotation,
  setStylesAt,
  setVectorGeometry,
  transact,
  type DesignNode,
  type StylePatch,
} from '@baren/schema'
import { useRef, useState, type RefObject } from 'react'
import { ORIGIN, realIdOf } from '../../model/docOps'
import { cancelPreview, previewStyles } from '../../model/previewEdits'
import {
  MIXED,
  SIZE_MODE_LABEL,
  common,
  pxValue,
  sizeMode,
  sizeModePatch,
  toPx,
  type SizeContext,
  type SizeMode,
} from '../../model/styles'
import type { NodesSnapshot } from '../../session/docEvents'
import { useEditor } from '../../session/context'
import { sizeContext, useBounds, useStyleEdit, type Bounds } from '../hooks'
import { SectionTitle } from '../marks'
import css from '../Inspector.module.css'

/** Vectors and groups have px sizes only (contract §2.5, §2.6): no Hug/Fill modes. */
function fixedSizeOnly(n: DesignNode): boolean {
  return n.type === 'vector' || n.type === 'group'
}

type Axis = 'x' | 'y'
type Dim = 'width' | 'height'

function isAbsolute(n: DesignNode): boolean {
  return n.styles['position'] === 'absolute' || n.styles['position'] === 'fixed'
}

function positionOf(
  n: DesignNode,
  ctx: SizeContext,
  b: Bounds | null,
  pb: Bounds | null,
  axis: Axis,
): number {
  const declared = toPx(n.styles[axis === 'x' ? 'left' : 'top'])
  if (ctx.isTop) return Math.round(declared ?? b?.[axis] ?? 0)
  if (isAbsolute(n) && declared !== null) return Math.round(declared)
  if (b && pb) return Math.round(b[axis] - pb[axis])
  return Math.round(declared ?? 0)
}

export function LayoutSection({ snapshot }: { snapshot: NodesSnapshot }) {
  const { doc, actions, resolver } = useEditor()
  const edit = useStyleEdit()
  const bounds = useBounds(snapshot)
  const { nodes, parents } = snapshot
  const ctxs = nodes.map((n, i) => sizeContext(n, parents[i] ?? null))
  const [aspectLocked, setAspectLocked] = useState(false)
  const [menu, setMenu] = useState<'layout' | 'width' | 'height' | null>(null)
  const titleRef = useRef<HTMLSpanElement>(null)
  const wRef = useRef<HTMLElement | null>(null)
  const hRef = useRef<HTMLElement | null>(null)

  const ctxOf = (id: string): SizeContext =>
    ctxs[nodes.findIndex((n) => n.id === id)] ?? (ctxs[0] as SizeContext)
  const boundsOf = (id: string): Bounds | null =>
    bounds.nodes[nodes.findIndex((n) => n.id === id)] ?? null

  const pos = (axis: Axis) =>
    common(
      nodes.map((n, i) =>
        positionOf(
          n,
          ctxs[i] as SizeContext,
          bounds.nodes[i] ?? null,
          bounds.parents[i] ?? null,
          axis,
        ),
      ),
    )

  const inFlow = nodes.some((n, i) => !(ctxs[i] as SizeContext).isTop && !isAbsolute(n))

  const setPosition = (axis: Axis, v: number, meta: NumberChangeMeta) => {
    const key = axis === 'x' ? 'left' : 'top'
    if (!inFlow) {
      edit((styles) => ({ [key]: pxValue(styles[key], v) }), meta.final)
      return
    }
    if (!meta.final) return
    // In-flow layers become absolutely positioned inside their (now positioned) parent.
    transact(
      doc,
      () => {
        nodes.forEach((n, i) => {
          const ctx = ctxs[i] as SizeContext
          if (ctx.isTop || isAbsolute(n)) {
            setStylesAt(doc, n.id, { [key]: pxValue(n.styles[key], v) }, { resolver })
            return
          }
          const other = positionOf(
            n,
            ctx,
            bounds.nodes[i] ?? null,
            bounds.parents[i] ?? null,
            axis === 'x' ? 'y' : 'x',
          )
          setStylesAt(
            doc,
            n.id,
            {
              position: 'absolute',
              left: axis === 'x' ? v : other,
              top: axis === 'y' ? v : other,
            },
            { resolver },
          )
          const parent = n.parentId ? resolver.resolveNode(n.parentId) : undefined
          if (parent && parent.type !== 'page' && !parent.styles['position']) {
            setStylesAt(doc, parent.id, { position: 'relative' }, { resolver })
          }
        })
        fitGroups(doc, [...new Set(nodes.map((n) => realIdOf(n.id)))], actions.geometry())
      },
      { origin: ORIGIN.inspector },
    )
  }

  const modeOf = (dim: Dim) =>
    common(nodes.map((n, i) => sizeMode(n.styles, dim, ctxs[i] as SizeContext)))
  const sizeValue = (dim: Dim) => {
    const mode = modeOf(dim)
    if (mode !== 'fixed') return null
    return common(
      nodes.map((n, i) => Math.round(toPx(n.styles[dim]) ?? bounds.nodes[i]?.[dim] ?? 0)),
    )
  }

  const setSize = (dim: Dim, v: number, meta: NumberChangeMeta) => {
    const value = Math.max(0, v)
    if (meta.final && nodes.some((n) => fixedSizeOnly(n) && isTreeId(n.id))) {
      commitFixedSizes(dim, value)
      return
    }
    edit((styles, id) => {
      const ctx = ctxOf(id)
      const patch: StylePatch = sizeModePatch(styles, dim, 'fixed', ctx, value)
      if (aspectLocked) {
        const b = boundsOf(id)
        const w = toPx(styles['width']) ?? b?.width ?? 0
        const h = toPx(styles['height']) ?? b?.height ?? 0
        if (w > 0 && h > 0) {
          const other: Dim = dim === 'width' ? 'height' : 'width'
          const ratio = dim === 'width' ? h / w : w / h
          patch[other] = pxValue(styles[other], Math.round(value * ratio))
        }
      }
      return patch
    }, meta.final)
  }

  /**
   * Final W/H on vectors and groups: vectors rescale their points with the box
   * (`setVectorGeometry`), groups scale their children (`resizeGroup`); other nodes in the
   * selection get the plain size. One commit.
   */
  const commitFixedSizes = (dim: Dim, value: number) => {
    cancelPreview(doc)
    transact(
      doc,
      () => {
        nodes.forEach((n, i) => {
          const b = bounds.nodes[i] ?? null
          const w = toPx(n.styles['width']) ?? b?.width ?? 0
          const h = toPx(n.styles['height']) ?? b?.height ?? 0
          let nw = dim === 'width' ? value : w
          let nh = dim === 'height' ? value : h
          if (aspectLocked && w > 0 && h > 0) {
            if (dim === 'width') nh = Math.round((value * h) / w)
            else nw = Math.round((value * w) / h)
          }
          if (n.type === 'vector' && n.vector && isTreeId(n.id)) {
            const v = w > 0 && h > 0 ? scaleVector(n.vector, nw / w, nh / h) : n.vector
            setVectorGeometry(doc, n.id, v, { width: nw, height: nh })
          } else if (n.type === 'group' && isTreeId(n.id)) {
            resizeGroup(doc, n.id, { width: nw, height: nh })
          } else {
            const patch: StylePatch = sizeModePatch(n.styles, dim, 'fixed', ctxOf(n.id), value)
            if (aspectLocked && w > 0 && h > 0) {
              const other: Dim = dim === 'width' ? 'height' : 'width'
              patch[other] = pxValue(n.styles[other], other === 'width' ? nw : nh)
            }
            setStylesAt(doc, n.id, patch, { resolver })
          }
        })
        fitGroups(doc, [...new Set(nodes.map((n) => realIdOf(n.id)))], actions.geometry())
      },
      { origin: ORIGIN.inspector },
    )
  }

  /** Rotation field: previews while scrubbing, then `setRotation` (each node about its centre). */
  const setRotationValue = (v: number, meta: NumberChangeMeta) => {
    const ids = nodes.map((n) => n.id)
    if (!meta.final) {
      previewStyles(doc, ids, () => ({ rotate: rotationValue(v) }))
      return
    }
    cancelPreview(doc)
    setRotation(doc, ids, v, actions.geometry(), { origin: ORIGIN.inspector })
  }

  const setMode = (dim: Dim, mode: SizeMode) => {
    edit((styles, id) => sizeModePatch(styles, dim, mode, ctxOf(id), boundsOf(id)?.[dim] ?? null))
  }

  const rotation = common(nodes.map((n) => Math.round(readSchemaRotation(n.styles) * 100) / 100))
  const flipped =
    nodes.length > 0 && nodes.every((n) => String(n.styles['scale'] ?? '').startsWith('-1'))

  const sizeField = (dim: Dim, label: string, ref: RefObject<HTMLElement | null>) => {
    const mode = modeOf(dim)
    const value = sizeValue(dim)
    const placeholder = mode === MIXED ? 'Mixed' : mode === undefined ? '' : SIZE_MODE_LABEL[mode]
    return (
      <NumberField
        prefix={label}
        value={value === MIXED || value === undefined ? null : value}
        placeholder={value === MIXED ? 'Mixed' : placeholder}
        className={mode === MIXED || value === MIXED ? css.mixedField : css.modeField}
        min={0}
        chevron
        onChevronClick={() => setMenu(dim)}
        inputRef={(el) => void (ref.current = el?.parentElement ?? null)}
        onChange={(v, meta) => setSize(dim, v, meta)}
        aria-label={dim === 'width' ? 'Width' : 'Height'}
      />
    )
  }

  const top = ctxs.every((c) => c.isTop)
  const allFlexParents = ctxs.every((c) => c.parentFlexDirection !== null)
  const fixedOnly = nodes.some(fixedSizeOnly)
  const modeMenu = (dim: Dim) => {
    const current = modeOf(dim)
    const hugLabel = top ? 'Fit' : 'Hug'
    return (
      <>
        <MenuItem checked={current === 'fixed'} onSelect={() => setMode(dim, 'fixed')}>
          Fixed
        </MenuItem>
        <MenuItem
          checked={current === 'hug' || current === 'fit'}
          disabled={fixedOnly}
          onSelect={() => setMode(dim, top ? 'fit' : 'hug')}
        >
          {hugLabel} contents
        </MenuItem>
        <MenuItem
          checked={current === 'fill'}
          disabled={top || !allFlexParents || fixedOnly}
          onSelect={() => setMode(dim, 'fill')}
        >
          Fill container
        </MenuItem>
      </>
    )
  }

  const allAbsolute = nodes.every((n, i) => (ctxs[i] as SizeContext).isTop || isAbsolute(n))

  return (
    <InspectorSection
      title={
        <span ref={titleRef}>
          <SectionTitle name="Layout" />
        </span>
      }
      titleChevron
      onTitleClick={() => setMenu(menu === 'layout' ? null : 'layout')}
      actions={
        <SectionHeaderAction
          label="Resize to fit content"
          onClick={() => edit(() => ({ width: null, height: null }))}
        >
          <MaximizeIcon size={13} />
        </SectionHeaderAction>
      }
    >
      <InspectorRow>
        <NumberField
          prefix="X"
          value={nullable(pos('x'))}
          onChange={(v, m) => setPosition('x', v, m)}
          aria-label="X"
        />
        <NumberField
          prefix="Y"
          value={nullable(pos('y'))}
          onChange={(v, m) => setPosition('y', v, m)}
          aria-label="Y"
        />
        <NumberField
          prefix={<RotationIcon size={11} />}
          value={nullable(rotation)}
          unit="°"
          width={64}
          style={{ gap: 6 }}
          onChange={setRotationValue}
          aria-label="Rotation"
        />
      </InspectorRow>
      <InspectorRow>
        {sizeField('width', 'W', wRef)}
        {sizeField('height', 'H', hRef)}
        <SplitField
          buttons={[
            {
              label: aspectLocked ? 'Unlock aspect ratio' : 'Lock aspect ratio',
              icon: <DuplicateIcon size={12} />,
              active: aspectLocked,
              onClick: () => setAspectLocked((v) => !v),
            },
            {
              label: 'Flip horizontal',
              icon: <FlipIcon size={12} />,
              active: flipped,
              onClick: () => edit(() => ({ scale: flipped ? null : '-1 1' })),
            },
          ]}
        />
      </InspectorRow>
      <DropdownMenu
        open={menu === 'width' || menu === 'height'}
        onOpenChange={(open) => !open && setMenu(null)}
        anchorRef={menu === 'height' ? hRef : wRef}
        width={180}
      >
        {menu === 'height' ? modeMenu('height') : modeMenu('width')}
      </DropdownMenu>
      <DropdownMenu
        open={menu === 'layout'}
        onOpenChange={(open) => !open && setMenu(null)}
        anchorRef={titleRef}
        width={200}
      >
        <MenuItem
          checked={allAbsolute}
          disabled={top}
          onSelect={() =>
            allAbsolute
              ? edit((s) =>
                  s['position'] === 'absolute' ? { position: null, left: null, top: null } : null,
                )
              : setPosition('x', typeof pos('x') === 'number' ? (pos('x') as number) : 0, {
                  final: true,
                })
          }
        >
          Absolute position
        </MenuItem>
        <MenuItem onSelect={() => actions.rotate90()}>Rotate 90°</MenuItem>
      </DropdownMenu>
    </InspectorSection>
  )
}

/** NumberField value: MIXED/undefined → null ("Mixed"). */
export function nullable(v: number | typeof MIXED | undefined): number | null {
  return typeof v === 'number' ? v : null
}
