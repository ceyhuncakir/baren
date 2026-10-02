/**
 * @baren/canvas — imperative DOM renderer for design documents: real DOM
 * per artboard with virtualization and LOD stand-ins, a Canvas 2D overlay
 * (selection, handles, labels, remote cursors), rbush spatial indexes and
 * the select/move/resize/draw/text tools. Framework-agnostic; the React
 * wrapper lives in `@baren/canvas/react`.
 */
export { createCanvas } from './controller.ts'
export type {
  AssetResolver,
  CanvasController,
  CanvasOptions,
  CanvasStats,
  ContextMenuRequest,
  DropTarget,
  DropTargetOptions,
  GeometrySource,
  Handle,
  HistoryState,
  KeyboardMode,
  NodeFrame,
  OverlayTheme,
  Point,
  Rect,
  RemotePresence,
  Tool,
  TransientChange,
  Viewport,
} from './types.ts'
export { TOOLS } from './types.ts'
export {
  MAX_ZOOM,
  MIN_ZOOM,
  ZOOM_STEPS,
  clampZoom,
  fitRect,
  formatZoom,
  nextZoomStep,
  screenToWorld,
  worldToScreen,
  zoomAt,
} from './math/viewport.ts'
export { DEFAULT_THEME } from './overlay/overlay.ts'
export { ORIGIN } from './doc/ops.ts'
export { sanitizeSvg, sanitizeSvgMarkup } from './render/sanitizeSvg.ts'
export { MISSING_FILL_CSS } from './render/assets.ts'
export { backgroundTileSize, backgroundTiles, fitImage, parsePosition } from './render/imageFit.ts'
export type { DesignNode, DocSnapshot, NodeChangeBatch } from '@baren/schema'
