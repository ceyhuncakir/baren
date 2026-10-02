import { useEffect, useLayoutEffect, useRef, type CSSProperties, type Ref } from 'react'
import { createCanvas } from './controller.ts'
import type { CanvasController, CanvasOptions } from './types.ts'

export interface DesignCanvasProps extends Omit<CanvasOptions, 'container'> {
  className?: string
  style?: CSSProperties
  /** Receives the controller after mount and `null` on unmount. */
  ref?: Ref<CanvasController | null>
  onReady?: (controller: CanvasController | null) => void
}

function assignRef<T>(ref: Ref<T> | undefined, value: T): void {
  if (typeof ref === 'function') ref(value)
  else if (ref && typeof ref === 'object') (ref as { current: T }).current = value
}

/**
 * Mounts a canvas controller into a div. The controller is created once per
 * `doc` and never re-rendered by React: page, tool and read-only changes are
 * forwarded imperatively, and callbacks always see the latest props.
 */
export function DesignCanvas(props: DesignCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const controllerRef = useRef<CanvasController | null>(null)
  const propsRef = useRef(props)
  propsRef.current = props

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return
    const p = propsRef.current
    const options: CanvasOptions = {
      container,
      doc: p.doc,
      pageId: p.pageId,
      ...(p.readOnly !== undefined ? { readOnly: p.readOnly } : {}),
      ...(p.tool !== undefined ? { tool: p.tool } : {}),
      ...(p.viewport !== undefined ? { viewport: p.viewport } : {}),
      ...(p.keyboard !== undefined ? { keyboard: p.keyboard } : {}),
      ...(p.undo !== undefined ? { undo: p.undo } : {}),
      ...(p.undoExcludeOriginPrefixes !== undefined
        ? { undoExcludeOriginPrefixes: p.undoExcludeOriginPrefixes }
        : {}),
      ...(p.theme !== undefined ? { theme: p.theme } : {}),
      ...(p.viewportChangeThrottleMs !== undefined
        ? { viewportChangeThrottleMs: p.viewportChangeThrottleMs }
        : {}),
      // Callbacks always read the latest props, so re-renders never re-create the canvas.
      resolveAsset: (assetId) => propsRef.current.resolveAsset?.(assetId) ?? null,
      onSelectionChange: (ids) => propsRef.current.onSelectionChange?.(ids),
      onHoverChange: (id) => propsRef.current.onHoverChange?.(id),
      onViewportChange: (v) => propsRef.current.onViewportChange?.(v),
      onToolChange: (tool) => propsRef.current.onToolChange?.(tool),
      onTransientChange: (t) => propsRef.current.onTransientChange?.(t),
      onCursorMove: (p) => propsRef.current.onCursorMove?.(p),
      onContextMenu: (r) => propsRef.current.onContextMenu?.(r),
      onHistoryChange: (h) => propsRef.current.onHistoryChange?.(h),
      onTextEditChange: (id) => propsRef.current.onTextEditChange?.(id),
      onVectorEditChange: (id) => propsRef.current.onVectorEditChange?.(id),
    }
    const controller = createCanvas(options)
    controllerRef.current = controller
    assignRef(propsRef.current.ref, controller)
    propsRef.current.onReady?.(controller)
    return () => {
      controller.destroy()
      controllerRef.current = null
      assignRef(propsRef.current.ref, null)
      propsRef.current.onReady?.(null)
    }
  }, [props.doc])

  useEffect(() => {
    controllerRef.current?.setPage(props.pageId)
  }, [props.pageId])

  useEffect(() => {
    controllerRef.current?.setReadOnly(props.readOnly === true)
  }, [props.readOnly])

  useEffect(() => {
    if (props.tool !== undefined) controllerRef.current?.setTool(props.tool)
  }, [props.tool])

  return (
    <div
      ref={containerRef}
      className={props.className}
      style={{ position: 'relative', overflow: 'hidden', ...props.style }}
    />
  )
}

export type { CanvasController, CanvasOptions } from './types.ts'
