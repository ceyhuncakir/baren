/**
 * Plain (non-CRDT) snapshot types shared by every renderer, plus the
 * constants that describe the Loro document layout. The Rust core
 * (`crates/core`) mirrors these names exactly — change them only through
 * a contract request.
 */

export const SCHEMA_VERSION = 1

/** Root container names inside a design file's `LoroDoc`. */
export const CONTAINER = {
  meta: 'meta',
  nodes: 'nodes',
  tokens: 'tokens',
  /** Component registry: `componentKey` → mergeable `{ mainId }` (Phase 3). */
  components: 'components',
  /** Comment threads: `threadId` → mergeable thread map (`comments.ts`). */
  comments: 'comments',
  /** Version history: `versionId` → mergeable version map (`versions.ts`). */
  versions: 'versions',
} as const

/** Keys of a tree node's `data` map. */
export const NODE_KEY = {
  type: 'type',
  name: 'name',
  styles: 'styles',
  text: 'text',
  svg: 'svg',
  assetId: 'assetId',
  assetName: 'assetName',
  locked: 'locked',
  hidden: 'hidden',
  background: 'background',
  /** Frame: this frame is a main component with this key. Instance: the component it shows. */
  componentKey: 'componentKey',
  /** Stable address of a node inside a main component (override paths). */
  nodeKey: 'nodeKey',
  /** Instance: TreeID hint of its main component (never authoritative). */
  mainId: 'mainId',
  /** Instance: mergeable map of per-instance overrides. */
  overrides: 'overrides',
  /** Vector: mergeable map with the path geometry. */
  vector: 'vector',
} as const

export const NODE_TYPES = [
  'page',
  'frame',
  'text',
  'rect',
  'svg',
  'image',
  'group',
  'vector',
  'instance',
] as const
export type NodeType = (typeof NODE_TYPES)[number]

/** Node types that may contain children. Pages hold artboards; frames and groups hold layers. */
export const CONTAINER_NODE_TYPES: ReadonlySet<NodeType> = new Set<NodeType>([
  'page',
  'frame',
  'group',
])

/** Deepest nesting of instances inside instances before resolution stops (`status: 'depth'`). */
export const MAX_INSTANCE_DEPTH = 16
/** Page that receives main components created by paste / restore. */
export const COMPONENTS_PAGE_NAME = 'Components'
/** Placeholder fill for unresolved instances (design content, like missing images). */
export const MISSING_FILL_COLOR = '#E3E3E3'

/** Style keys an instance always owns (never inherited from the main root). */
export const PLACEMENT_KEYS: ReadonlySet<string> = new Set([
  'left',
  'top',
  'right',
  'bottom',
  'inset',
  'position',
  'rotate',
  'transform',
  'margin',
  'marginTop',
  'marginRight',
  'marginBottom',
  'marginLeft',
  'alignSelf',
  'justifySelf',
  'flex',
  'flexGrow',
  'flexShrink',
  'flexBasis',
  'order',
  'zIndex',
  'gridArea',
  'gridColumn',
  'gridColumnStart',
  'gridColumnEnd',
  'gridRow',
  'gridRowStart',
  'gridRowEnd',
])

/** Size keys an instance may own (absent = the main's size). */
export const SIZE_KEYS: ReadonlySet<string> = new Set([
  'width',
  'height',
  'minWidth',
  'minHeight',
  'maxWidth',
  'maxHeight',
  'aspectRatio',
])

/** True for keys stored in an instance's own `styles` (placement and size). */
export function isInstanceOwnKey(key: string): boolean {
  return PLACEMENT_KEYS.has(key) || SIZE_KEYS.has(key)
}

export type StyleValue = string | number
/** camelCase CSS property → value, e.g. `{ display: 'flex', gap: '12px', left: 40 }`. */
export type Styles = Record<string, StyleValue>
/** A style patch: `null` removes the property. */
export type StylePatch = Record<string, StyleValue | null>

/** Override styles: `null` = "property removed in this instance". */
export type OverrideStyles = Record<string, StyleValue | null>

/** One override entry of an instance (absent field = not overridden). */
export interface OverrideEntry {
  styles?: OverrideStyles
  text?: string
  hidden?: boolean
  assetId?: string
  assetName?: string
}

export type VectorPointMode = 'corner' | 'smooth' | 'mirrored'

/** An anchor in node-local px; handles are relative to the anchor. */
export interface VectorPoint {
  x: number
  y: number
  in?: [number, number]
  out?: [number, number]
  /** Absent = `corner`. */
  mode?: VectorPointMode
}

export interface VectorSubpath {
  id: string
  closed: boolean
  points: VectorPoint[]
}

export interface VectorData {
  fillRule: 'nonzero' | 'evenodd'
  /** Sorted by (order, id) when decoded. */
  subpaths: VectorSubpath[]
}

export interface DesignNode {
  id: string
  type: NodeType
  name: string
  parentId: string | null
  children: string[]
  styles: Styles
  text?: string
  svg?: string
  assetId?: string
  /** Original file name of the node's image (image layer source or image fill), for display. */
  assetName?: string
  locked?: boolean
  hidden?: boolean
  background?: string
  /** Frame: main component key. Instance: the component it shows. */
  componentKey?: string
  /** Address of the node inside a main component. */
  nodeKey?: string
  /** Instance: TreeID hint of its main. */
  mainId?: string
  /** Instance overrides; empty entries and empty maps are omitted. */
  overrides?: Record<string, OverrideEntry>
  /** Vector geometry (vectors only). */
  vector?: VectorData
}

export interface Token {
  type: string
  value: string | number
  description?: string
}

export interface DocSnapshot {
  name: string
  pageIds: string[]
  nodes: Record<string, DesignNode>
  tokens: Record<string, Token>
  /** Component registry (omitted when empty). */
  components?: Record<string, { mainId: string }>
}

/** Scalar node properties that live directly on the node's data map. */
export interface NodeProps {
  name?: string
  svg?: string
  assetId?: string
  assetName?: string
  locked?: boolean
  hidden?: boolean
  background?: string
  componentKey?: string
  nodeKey?: string
  mainId?: string
}

/** A props patch: `null` removes the property (except `name`, which is reset to ''). */
export type NodePropsPatch = { [K in keyof NodeProps]?: NodeProps[K] | null }

export const DEFAULT_PAGE_NAME = 'Page 1'
export const DEFAULT_PAGE_BACKGROUND = '#EEEEEE'

export const DEFAULT_NODE_NAMES: Record<NodeType, string> = {
  page: 'Page',
  frame: 'Frame',
  text: 'Text',
  rect: 'Rectangle',
  svg: 'Vector',
  image: 'Image',
  group: 'Group',
  vector: 'Vector',
  /** An instance with an empty name displays the current name of its main. */
  instance: '',
}

export function isNodeType(value: unknown): value is NodeType {
  return typeof value === 'string' && (NODE_TYPES as readonly string[]).includes(value)
}

// ---------------------------------------------------------------------------
// Geometry (Phase 3)
// ---------------------------------------------------------------------------

export interface Point {
  x: number
  y: number
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * World geometry of a node: the unrotated border box placed so that rotating it by `rotation`
 * (degrees, accumulated over all ancestors) about its centre gives the node's actual shape.
 */
export interface NodeFrame extends Rect {
  rotation: number
}

/** Where helpers get world frames from (the canvas measures the DOM; `docGeometry` reads styles). */
export interface GeometrySource {
  frameOf(id: string): NodeFrame | null
}
