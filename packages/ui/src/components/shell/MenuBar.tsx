import { clsx } from 'clsx'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
} from 'react'
import { useStableCallback } from '../../lib/hooks'
import { FloatingLayer } from '../../lib/floating'
import { placeAnchored, toBox, type Size } from '../../lib/position'
import { Menu, MenuContext, type MenuContextValue } from './Menu'
import { MenuBarItem } from './TitleBar'
import styles from './TitleBar.module.css'

type OpenVia = 'pointer' | 'keyboard'

interface MenuBarContextValue {
  openId: string | null
  via: OpenVia
  setOpen: (id: string | null, via?: OpenVia) => void
  barRef: RefObject<HTMLDivElement | null>
}

const MenuBarContext = createContext<MenuBarContextValue | null>(null)

export interface MenuBarProps extends HTMLAttributes<HTMLDivElement> {
  /** Called whenever a menu opens or closes (screens can e.g. pause canvas shortcuts). */
  onOpenChange?: (open: boolean) => void
}

/**
 * HTML menu bar (artboards 09–13). Press a title to open its menu; while one is open,
 * hovering another title switches to it. ArrowLeft/Right move between menus, Escape
 * closes and returns focus to the title.
 */
export function MenuBar({ className, children, onOpenChange, ...rest }: MenuBarProps) {
  const [state, setState] = useState<{ id: string | null; via: OpenVia }>({
    id: null,
    via: 'pointer',
  })
  const barRef = useRef<HTMLDivElement>(null)
  const setOpen = useCallback((id: string | null, via: OpenVia = 'pointer') => {
    setState((prev) => (prev.id === id && prev.via === via ? prev : { id, via }))
  }, [])
  const notify = useStableCallback(onOpenChange)
  const isOpen = state.id !== null
  const wasOpen = useRef(false)
  useEffect(() => {
    if (wasOpen.current !== isOpen) notify(isOpen)
    wasOpen.current = isOpen
  }, [isOpen, notify])
  const ctx = useMemo(
    () => ({ openId: state.id, via: state.via, setOpen, barRef }),
    [state.id, state.via, setOpen],
  )
  return (
    <MenuBarContext.Provider value={ctx}>
      <div ref={barRef} role="menubar" className={clsx(styles.menuBar, className)} {...rest}>
        {children}
      </div>
    </MenuBarContext.Provider>
  )
}

export interface MenuBarMenuProps {
  label: string
  /** Panel width: File/Edit 248, View 300, Window 200, Help 220. */
  width?: number
  children: ReactNode
}

/** A title in the menu bar plus its dropdown. Children are MenuItem/MenuSeparator/Submenu. */
export function MenuBarMenu({ label, width = 248, children }: MenuBarMenuProps) {
  const bar = useContext(MenuBarContext)
  const id = useId()
  const buttonRef = useRef<HTMLButtonElement>(null)
  const setOpenFromBar = bar?.setOpen
  const ctx = useMemo<MenuContextValue>(
    () => ({ close: () => setOpenFromBar?.(null) }),
    [setOpenFromBar],
  )
  if (!bar) throw new Error('MenuBarMenu must be rendered inside <MenuBar>')
  const open = bar.openId === id
  const { setOpen, barRef } = bar

  const siblings = () =>
    Array.from(barRef.current?.querySelectorAll<HTMLButtonElement>('[data-menubar-item]') ?? [])

  const switchMenu = (dir: 1 | -1) => {
    const items = siblings()
    const idx = items.findIndex((b) => b.dataset['menuId'] === id)
    if (idx < 0 || items.length === 0) return
    const next = items[(idx + dir + items.length) % items.length]
    const nextId = next?.dataset['menuId']
    if (nextId) setOpen(nextId, 'keyboard')
  }

  const position = (size: Size, viewport: Size) => {
    const button = buttonRef.current
    if (!button) return { x: 0, y: 0 }
    // Menus sit 2px below the 36px title bar, left-aligned with the title.
    return placeAnchored(toBox(button.getBoundingClientRect()), size, viewport, {
      placement: 'bottom-start',
      offset: 8,
    })
  }

  return (
    <>
      <MenuBarItem
        ref={buttonRef}
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        data-menubar-item=""
        data-menu-id={id}
        onPointerDown={(e) => {
          if (e.button !== 0) return
          e.preventDefault()
          setOpen(open ? null : id, 'pointer')
        }}
        onPointerEnter={() => {
          if (bar.openId !== null && !open) setOpen(id, 'pointer')
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setOpen(id, 'keyboard')
          } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
            e.preventDefault()
            const items = siblings()
            const idx = items.indexOf(e.currentTarget)
            const dir = e.key === 'ArrowRight' ? 1 : -1
            items[(idx + dir + items.length) % items.length]?.focus()
          }
        }}
      >
        {label}
      </MenuBarItem>
      <FloatingLayer
        open={open}
        position={position}
        anchorRef={buttonRef}
        onDismiss={() => setOpen(null)}
      >
        <MenuContext.Provider value={ctx}>
          <Menu
            width={width}
            aria-label={label}
            autoFocus={bar.via === 'keyboard' ? 'first' : 'menu'}
            onEscape={() => {
              setOpen(null)
              buttonRef.current?.focus({ preventScroll: true })
            }}
            onArrowLeft={() => switchMenu(-1)}
            onArrowRight={() => switchMenu(1)}
          >
            {children}
          </Menu>
        </MenuContext.Provider>
      </FloatingLayer>
    </>
  )
}
