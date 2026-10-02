import {
  useCallback,
  useMemo,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react'
import { FloatingLayer } from '../../lib/floating'
import { useStableCallback } from '../../lib/hooks'
import { placeAtPoint, type Size } from '../../lib/position'
import { Menu, MenuContext, type MenuContextValue } from './Menu'

export interface ContextMenuProps {
  open: boolean
  /** Cursor position in viewport coordinates. */
  x: number
  y: number
  onClose: () => void
  /** Context menu width: 244. */
  width?: number
  'aria-label'?: string
  children: ReactNode
}

/**
 * Menu opened at the cursor (artboard 15). Flips to the other side of the cursor at the
 * viewport edges; closes on outside click, Escape, selection, window blur or resize.
 */
export function ContextMenu({
  open,
  x,
  y,
  onClose,
  width = 244,
  children,
  ...aria
}: ContextMenuProps) {
  const close = useStableCallback(onClose)
  const ctx = useMemo<MenuContextValue>(() => ({ close: () => close() }), [close])
  const position = (size: Size, viewport: Size) => placeAtPoint({ x, y }, size, viewport)

  return (
    <FloatingLayer open={open} position={position} onDismiss={() => close()}>
      <MenuContext.Provider value={ctx}>
        <Menu width={width} autoFocus="menu" aria-label={aria['aria-label']}>
          {children}
        </Menu>
      </MenuContext.Provider>
    </FloatingLayer>
  )
}

export interface ContextMenuState {
  open: boolean
  x: number
  y: number
}

/**
 * State helper: spread `onContextMenu` on the target, render
 * `<ContextMenu {...menu} onClose={menu.close}>`.
 */
export function useContextMenu() {
  const [state, setState] = useState<ContextMenuState>({ open: false, x: 0, y: 0 })
  const onContextMenu = useCallback((e: ReactMouseEvent | MouseEvent) => {
    e.preventDefault()
    setState({ open: true, x: e.clientX, y: e.clientY })
  }, [])
  const openAt = useCallback((x: number, y: number) => setState({ open: true, x, y }), [])
  const close = useCallback(() => setState((s) => (s.open ? { ...s, open: false } : s)), [])
  return { ...state, onContextMenu, openAt, close }
}
