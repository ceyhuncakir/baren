import { clsx } from 'clsx'
import {
  memo,
  useEffect,
  useRef,
  type CSSProperties,
  type HTMLAttributes,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type Ref,
} from 'react'
import {
  ChevronDownIcon,
  ChevronRightIcon,
  EyeIcon,
  EyeOffIcon,
  FrameColumnsIcon,
  FrameRowsIcon,
  GroupIcon,
  ImageIcon,
  InstanceIcon,
  LockIcon,
  MainComponentIcon,
  RectIcon,
  VectorIcon,
} from '../../icons/icons'
import { TextAaIcon } from '../../icons/TextAaIcon'
import styles from './LayerRow.module.css'

export type LayerRowState = 'idle' | 'selected' | 'ancestor'
export type DropPosition = 'before' | 'after' | 'inside'

export interface LayerRowProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  'onSelect' | 'id' | 'onToggle'
> {
  /** Node id; passed back to every callback so one handler can serve all rows. */
  id: string
  name: string
  /** 0 = artboard (direct child of the page). */
  depth: number
  /** 13px type icon; see <LayerTypeIcon>. */
  icon: ReactNode
  expandable?: boolean
  expanded?: boolean
  state?: LayerRowState
  locked?: boolean
  hidden?: boolean
  dragging?: boolean
  dropPosition?: DropPosition | null
  renaming?: boolean
  /**
   * Show the lock toggle (default true). Expanded instance content (virtual rows) can be
   * hidden but not locked, renamed or dragged.
   */
  lockable?: boolean
  onToggleExpanded?: (id: string) => void
  /** Fired on primary-button pointer down (design tools select on press; read modifiers from e). */
  onSelectRow?: (id: string, e: ReactPointerEvent<HTMLDivElement>) => void
  onStartRename?: (id: string) => void
  onRename?: (id: string, name: string) => void
  onRenameCancel?: (id: string) => void
  onToggleLocked?: (id: string) => void
  onToggleHidden?: (id: string) => void
  ref?: Ref<HTMLDivElement>
}

/**
 * One row of the layer tree. Pure and memoized: give it primitive props and stable
 * callbacks (all callbacks receive the row id), and a virtualized list re-renders only
 * the rows whose props changed.
 */
export const LayerRow = memo(function LayerRow({
  id,
  name,
  depth,
  icon,
  expandable = false,
  expanded = false,
  state = 'idle',
  locked = false,
  hidden = false,
  dragging = false,
  dropPosition = null,
  renaming = false,
  lockable = true,
  onToggleExpanded,
  onSelectRow,
  onStartRename,
  onRename,
  onRenameCancel,
  onToggleLocked,
  onToggleHidden,
  className,
  style,
  onPointerDown,
  onKeyDown,
  ref,
  ...rest
}: LayerRowProps) {
  const rowStyle = { '--depth': depth, ...style } as CSSProperties
  return (
    <div
      ref={ref}
      role="treeitem"
      aria-level={depth + 1}
      aria-selected={state === 'selected'}
      aria-expanded={expandable ? expanded : undefined}
      tabIndex={state === 'selected' ? 0 : -1}
      data-state={state === 'idle' ? undefined : state}
      data-nested={depth > 0 ? '' : undefined}
      data-hidden={hidden ? '' : undefined}
      data-dragging={dragging ? '' : undefined}
      data-drop={dropPosition ?? undefined}
      className={clsx(styles.row, className)}
      style={rowStyle}
      onPointerDown={(e) => {
        onPointerDown?.(e)
        if (e.defaultPrevented || e.button !== 0 || renaming) return
        onSelectRow?.(id, e)
      }}
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest('button')) return
        onStartRename?.(id)
      }}
      onKeyDown={(e) => {
        onKeyDown?.(e)
        if (e.defaultPrevented || renaming) return
        if (e.key === 'F2' || (e.key === 'Enter' && state === 'selected')) {
          e.preventDefault()
          onStartRename?.(id)
        } else if (e.key === 'ArrowRight' && expandable && !expanded) {
          e.preventDefault()
          onToggleExpanded?.(id)
        } else if (e.key === 'ArrowLeft' && expandable && expanded) {
          e.preventDefault()
          onToggleExpanded?.(id)
        }
      }}
      {...rest}
    >
      {expandable ? (
        <button
          type="button"
          tabIndex={-1}
          className={styles.chevron}
          aria-label={expanded ? 'Collapse' : 'Expand'}
          aria-expanded={expanded}
          onPointerDown={(e) => {
            e.stopPropagation()
            e.preventDefault()
          }}
          onClick={() => onToggleExpanded?.(id)}
        >
          {expanded ? (
            <ChevronDownIcon size={11} strokeWidth={2.5} />
          ) : (
            <ChevronRightIcon size={11} strokeWidth={2.5} />
          )}
        </button>
      ) : (
        <span className={styles.chevron} />
      )}
      <span className={styles.typeIcon}>{icon}</span>
      {renaming ? (
        <RenameInput id={id} name={name} onRename={onRename} onCancel={onRenameCancel} />
      ) : (
        <span className={styles.name}>{name}</span>
      )}
      <span className={styles.trailing}>
        {!renaming && (
          <>
            {lockable && (
              <button
                type="button"
                tabIndex={-1}
                className={styles.trailButton}
                aria-label={locked ? 'Unlock' : 'Lock'}
                aria-pressed={locked}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => onToggleLocked?.(id)}
              >
                <LockIcon size={12} strokeWidth={2} />
              </button>
            )}
            <button
              type="button"
              tabIndex={-1}
              className={styles.trailButton}
              aria-label={hidden ? 'Show' : 'Hide'}
              aria-pressed={hidden}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => onToggleHidden?.(id)}
            >
              {hidden ? (
                <EyeOffIcon size={13} strokeWidth={2} />
              ) : (
                <EyeIcon size={13} strokeWidth={2} />
              )}
            </button>
          </>
        )}
      </span>
      {dropPosition === 'before' && <span className={clsx(styles.drop, styles.dropBefore)} />}
      {dropPosition === 'after' && <span className={clsx(styles.drop, styles.dropAfter)} />}
    </div>
  )
})

function RenameInput({
  id,
  name,
  onRename,
  onCancel,
}: {
  id: string
  name: string
  onRename?: (id: string, name: string) => void
  onCancel?: (id: string) => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus({ preventScroll: true })
    el.select()
  }, [])
  const finish = (commit: boolean) => {
    if (done.current) return
    done.current = true
    const value = ref.current?.value.trim() ?? ''
    if (commit && value !== '' && value !== name) onRename?.(id, value)
    else onCancel?.(id)
  }
  return (
    <input
      ref={ref}
      className={styles.renameInput}
      defaultValue={name}
      spellCheck={false}
      aria-label="Layer name"
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') finish(true)
        else if (e.key === 'Escape') finish(false)
      }}
      onBlur={() => finish(true)}
    />
  )
}

export type LayerKind =
  | 'artboard'
  | 'frame-column'
  | 'frame-row'
  | 'frame'
  | 'text'
  | 'rect'
  | 'svg'
  | 'image'
  | 'component'
  | 'group'
  | 'vector'
  | 'instance'

/** The 13px type glyph for a layer row (frames by flex direction, "Aa" for text, …). */
export function LayerTypeIcon({ kind }: { kind: LayerKind }) {
  switch (kind) {
    case 'artboard':
    case 'frame-column':
    case 'frame':
      return <FrameRowsIcon size={13} strokeWidth={2} />
    case 'frame-row':
      return <FrameColumnsIcon size={13} strokeWidth={2} />
    case 'text':
      return <TextAaIcon size={10} weight={600} />
    case 'rect':
      return <RectIcon size={13} strokeWidth={2} />
    case 'svg':
      return <VectorIcon size={13} strokeWidth={2} />
    case 'image':
      return <ImageIcon size={13} strokeWidth={2} />
    case 'component':
      // Main component: the filled four-diamond in the component colour (31).
      return (
        <MainComponentIcon
          size={13}
          strokeWidth={2}
          fill="currentColor"
          style={{ color: 'var(--color-component)' }}
        />
      )
    case 'group':
      return <GroupIcon size={13} strokeWidth={2} />
    case 'vector':
      return <VectorIcon size={13} strokeWidth={2} />
    case 'instance':
      return <InstanceIcon size={13} strokeWidth={2} style={{ color: 'var(--color-component)' }} />
  }
}

/** Fixed row height for virtualizers (@tanstack/react-virtual estimateSize). */
export const LAYER_ROW_HEIGHT = 28
