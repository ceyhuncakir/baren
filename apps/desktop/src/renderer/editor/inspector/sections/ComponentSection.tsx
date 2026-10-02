/**
 * Component section (artboard 31), at the top of the inspector for instances, their content
 * and main components: the component's name, what this instance overrides ("2 overrides ·
 * Text, Fill" + Reset overrides), Go to main component and Detach. States for a deleted main
 * (Restore), a component that cannot be found and a component cycle (contract §6).
 */
import {
  ChevronDownIcon,
  DetachIcon,
  DropdownMenu,
  InspectorSection,
  InstanceIcon,
  MainComponentIcon,
  MenuItem,
  ResetIcon,
  TargetIcon,
} from '@baren/ui'
import { useRef, useState } from 'react'
import { isTreeId, parseVirtualId, type ResolvedNode } from '@baren/schema'
import { summarizeOverrides } from '../../model/overrides'
import { useComponents, useEditor } from '../../session/context'
import { selectIds } from '../../session/selection'
import type { NodesSnapshot } from '../../session/docEvents'
import css from '../Inspector.module.css'

/** True when the inspector shows the Component section for `node`. */
export function hasComponentSection(node: ResolvedNode): boolean {
  return (
    node.type === 'instance' ||
    node.source !== undefined ||
    (node.type === 'frame' && node.componentKey !== undefined && isTreeId(node.id))
  )
}

function instanceStatus(node: ResolvedNode): string | null {
  switch (node.status) {
    case 'cycle':
    case 'depth':
      return 'Component cycle'
    case 'unresolved':
      return 'Component not found'
    default:
      return node.mainDeleted ? 'Main component deleted' : null
  }
}

/** Real instances of `key` on `pageId` (the well's "Select instances on this page"). */
function instancesOnPage(
  tree: {
    children(id: string): readonly string[]
    meta(id: string): { type: string; componentKey: string | null } | null
  },
  pageId: string,
  key: string,
): string[] {
  const out: string[] = []
  const stack = [...tree.children(pageId)]
  for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
    const meta = tree.meta(id)
    if (!meta) continue
    if (meta.type === 'instance') {
      if (meta.componentKey === key) out.push(id)
      continue
    }
    stack.push(...tree.children(id))
  }
  return out
}

export function ComponentSection({ snapshot }: { snapshot: NodesSnapshot }) {
  const session = useEditor()
  const { actions, resolver } = session
  const { list } = useComponents()
  const wellRef = useRef<HTMLButtonElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const node = snapshot.nodes.find(hasComponentSection)
  if (!node) return null
  const isMain = node.type === 'frame' && node.componentKey !== undefined && isTreeId(node.id)
  const isInstance = node.type === 'instance'
  // The component this node shows: an instance's own, else the one its content comes from.
  const key = isInstance || isMain ? node.componentKey : node.source?.componentKey
  const name = (key !== undefined && list.find((c) => c.key === key)?.name) || node.name

  if (isMain) {
    return (
      <InspectorSection
        title="Component"
        actions={<span className={css.componentKind}>Main component</span>}
      >
        <div className={css.componentWell}>
          <MainComponentIcon
            size={12}
            strokeWidth={2.25}
            fill="currentColor"
            className={css.componentIcon}
          />
          <span className={css.componentName}>{node.name}</span>
        </div>
      </InspectorSection>
    )
  }

  const instanceId = isTreeId(node.id) ? node.id : parseVirtualId(node.id)?.instanceId
  const expansion = instanceId ? resolver.expandInstance(instanceId) : null
  const summary = expansion ? summarizeOverrides(expansion.nodes, node.id) : { count: 0, kinds: [] }
  const status = isInstance ? instanceStatus(node) : null
  const canDetach = isInstance && isTreeId(node.id)
  const deleted = node.mainDeleted === true && key !== undefined

  return (
    <InspectorSection
      title="Component"
      actions={<span className={css.componentKind}>{isInstance ? 'Instance' : 'In instance'}</span>}
    >
      <button
        ref={wellRef}
        type="button"
        className={css.componentWell}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((v) => !v)}
      >
        <InstanceIcon size={12} strokeWidth={2.25} className={css.componentIcon} />
        <span className={css.componentName}>{name}</span>
        <ChevronDownIcon size={10} strokeWidth={2.5} className={css.componentChevron} />
      </button>
      <DropdownMenu
        open={menuOpen}
        onOpenChange={setMenuOpen}
        anchorRef={wellRef}
        width={220}
        aria-label={name}
      >
        <MenuItem onSelect={() => actions.goToMainComponent(node.id)}>
          Go to main component
        </MenuItem>
        <MenuItem
          disabled={key === undefined}
          onSelect={() => {
            if (key === undefined) return
            const pageId = session.store.getState().pageId
            selectIds(session, instancesOnPage(session.tree, pageId, key))
          }}
        >
          Select instances on this page
        </MenuItem>
      </DropdownMenu>
      <div className={css.overridesRow}>
        {status ? (
          <span className={css.componentStatus}>{status}</span>
        ) : summary.count > 0 ? (
          <>
            <span className={css.overridesDot} />
            <span className={css.overridesCount}>
              {summary.count === 1 ? '1 override' : `${summary.count} overrides`}
            </span>
            <span className={css.overridesKinds}>{summary.kinds.join(', ')}</span>
          </>
        ) : (
          <span className={css.overridesNone}>No overrides</span>
        )}
        {deleted ? (
          <button
            type="button"
            className={css.resetButton}
            onClick={() => key && actions.restoreMainComponent(key)}
          >
            Restore
          </button>
        ) : (
          <button
            type="button"
            className={css.resetButton}
            disabled={summary.count === 0}
            onClick={() => actions.resetOverrides()}
          >
            <ResetIcon size={11} />
            Reset overrides
          </button>
        )}
      </div>
      <div className={css.componentActions}>
        <button
          type="button"
          className={css.componentButton}
          disabled={node.status === 'unresolved'}
          onClick={() => actions.goToMainComponent(node.id)}
        >
          <TargetIcon size={11} />
          Go to main component
        </button>
        <button
          type="button"
          className={css.detachButton}
          disabled={!canDetach}
          title={canDetach ? 'Detach instance (Ctrl+Alt+B)' : 'Detach the outer instance first'}
          onClick={() => actions.detachInstance()}
        >
          <DetachIcon size={11} />
          Detach
        </button>
      </div>
    </InspectorSection>
  )
}
