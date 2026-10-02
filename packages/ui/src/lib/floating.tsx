import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { useStableCallback } from './hooks'
import type { Point, Size } from './position'

/**
 * Floating layers (menus, submenus, popovers, context menus) render into a portal on
 * document.body with `position: fixed` and are positioned once per open by writing a
 * transform straight to the DOM — no React state, so opening a menu costs one commit.
 *
 * Nested layers (a submenu inside a context menu) join the same "tree" through context,
 * so a click inside any of them is not an outside click for the others.
 */

export type DismissReason = 'outside' | 'escape' | 'blur' | 'resize' | 'select'

class FloatingTree {
  readonly elements = new Set<HTMLElement>()
  contains(target: EventTarget | null): boolean {
    if (!(target instanceof Node)) return false
    for (const el of this.elements) if (el.contains(target)) return true
    return false
  }
}

const FloatingTreeContext = createContext<FloatingTree | null>(null)

export interface FloatingLayerProps {
  open: boolean
  /** Computes the top-left corner from the layer's measured size and the viewport size. */
  position: (size: Size, viewport: Size) => Point
  /** Called by the root layer of a tree for outside clicks, window blur and resize. */
  onDismiss?: (reason: DismissReason) => void
  /** Elements that count as inside (the trigger), so clicking them can toggle. */
  anchorRef?: RefObject<HTMLElement | null>
  children: ReactNode
  className?: string
  style?: CSSProperties
  onPointerEnter?: () => void
  onPointerLeave?: () => void
}

const LAYER_STYLE: CSSProperties = {
  position: 'fixed',
  left: 0,
  top: 0,
  zIndex: 1000,
  // Hidden until measured and placed in the layout effect (same frame, no flash).
  visibility: 'hidden',
}

export function FloatingLayer(props: FloatingLayerProps) {
  if (!props.open || typeof document === 'undefined') return null
  return <OpenFloatingLayer {...props} />
}

function OpenFloatingLayer({
  position,
  onDismiss,
  anchorRef,
  children,
  className,
  style,
  onPointerEnter,
  onPointerLeave,
}: FloatingLayerProps) {
  const parentTree = useContext(FloatingTreeContext)
  const ownTree = useMemo(() => new FloatingTree(), [])
  const tree = parentTree ?? ownTree
  const isRoot = parentTree === null
  const layerRef = useRef<HTMLDivElement>(null)
  const dismiss = useStableCallback(onDismiss)
  const computePosition = useStableCallback(position)

  // Measure and place before paint.
  useLayoutEffect(() => {
    const el = layerRef.current
    if (!el) return
    tree.elements.add(el)
    const rect = el.getBoundingClientRect()
    const p = computePosition(
      { width: rect.width, height: rect.height },
      { width: window.innerWidth, height: window.innerHeight },
    )
    if (p) el.style.transform = `translate3d(${Math.round(p.x)}px, ${Math.round(p.y)}px, 0)`
    el.style.visibility = 'visible'
    return () => {
      tree.elements.delete(el)
    }
  }, [tree, computePosition])

  // Only the root layer listens for global dismissal; nested layers are closed by it.
  useLayoutEffect(() => {
    if (!isRoot) return
    const onPointerDown = (e: PointerEvent) => {
      if (tree.contains(e.target)) return
      if (anchorRef?.current?.contains(e.target as Node)) return
      dismiss('outside')
    }
    const onBlur = () => dismiss('blur')
    const onResize = () => dismiss('resize')
    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('blur', onBlur)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('resize', onResize)
    }
  }, [isRoot, tree, anchorRef, dismiss])

  return createPortal(
    <FloatingTreeContext.Provider value={tree}>
      <div
        ref={layerRef}
        className={className}
        style={style ? { ...LAYER_STYLE, ...style } : LAYER_STYLE}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        data-floating-layer=""
      >
        {children}
      </div>
    </FloatingTreeContext.Provider>,
    document.body,
  )
}
