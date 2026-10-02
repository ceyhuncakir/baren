import { useMemo, type ReactNode, type RefObject } from 'react'
import { FloatingLayer } from '../../lib/floating'
import { useStableCallback } from '../../lib/hooks'
import { placeAnchored, toBox, type Placement, type Size } from '../../lib/position'
import { Menu, MenuContext, type MenuContextValue } from './Menu'

export interface DropdownMenuProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The trigger. Clicks on it are not "outside", so it can toggle the menu. */
  anchorRef: RefObject<HTMLElement | null>
  placement?: Placement
  /** Gap below the anchor. Account menu (17): 2. Zoom menu (16): 5. */
  offset?: number
  alignOffset?: number
  width?: number
  /** 'first' when opened from the keyboard. */
  autoFocus?: 'menu' | 'first'
  'aria-label'?: string
  className?: string
  children: ReactNode
}

/** A menu anchored to a trigger: account menu (17), zoom menu (16), select menus. */
export function DropdownMenu({
  open,
  onOpenChange,
  anchorRef,
  placement = 'bottom-start',
  offset = 4,
  alignOffset = 0,
  width = 248,
  autoFocus = 'menu',
  className,
  children,
  ...aria
}: DropdownMenuProps) {
  const setOpen = useStableCallback(onOpenChange)
  const ctx = useMemo<MenuContextValue>(() => ({ close: () => setOpen(false) }), [setOpen])

  const position = (size: Size, viewport: Size) => {
    const anchor = anchorRef.current
    if (!anchor) return { x: 0, y: 0 }
    return placeAnchored(toBox(anchor.getBoundingClientRect()), size, viewport, {
      placement,
      offset,
      alignOffset,
    })
  }

  return (
    <FloatingLayer
      open={open}
      position={position}
      anchorRef={anchorRef}
      onDismiss={() => setOpen(false)}
    >
      <MenuContext.Provider value={ctx}>
        <Menu
          width={width}
          className={className}
          autoFocus={autoFocus}
          aria-label={aria['aria-label']}
          onEscape={() => {
            setOpen(false)
            anchorRef.current?.focus({ preventScroll: true })
          }}
        >
          {children}
        </Menu>
      </MenuContext.Provider>
    </FloatingLayer>
  )
}
