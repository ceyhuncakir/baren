import { MenuBar, MenuBarMenu, MenuItem, MenuSeparator } from '@baren/ui'
import {
  memo,
  useCallback,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type RefObject,
} from 'react'
import { bridge } from '../lib/bridge'
import { isCommandEnabled, isCommandId, subscribeCommand } from '../lib/commands'
import { formatShortcut } from '../lib/shortcuts'
import { updateMenuItem, useUpdates } from '../state/updates'
import { runAppAction } from './actions'
import css from './App.module.css'
import { APP_MENUS, type AppAction, type MenuEntry } from './menuModel'

const noopSubscribe = () => () => undefined
const alwaysEnabled = () => true

/** Re-renders only when this action's enabled state flips (edit/view commands). */
function useActionEnabled(action: AppAction): boolean {
  const tracked = isCommandId(action) && !action.startsWith('help.')
  const subscribe = useCallback(
    (cb: () => void) => (isCommandId(action) ? subscribeCommand(action, cb) : () => undefined),
    [action],
  )
  const getSnapshot = useCallback(
    () => (isCommandId(action) ? isCommandEnabled(action) : true),
    [action],
  )
  return useSyncExternalStore(
    tracked ? subscribe : noopSubscribe,
    tracked ? getSnapshot : alwaysEnabled,
    tracked ? getSnapshot : alwaysEnabled,
  )
}

function ActionItem({ entry }: { entry: Extract<MenuEntry, { kind: 'item' }> }) {
  const enabled = useActionEnabled(entry.action)
  return (
    <MenuItem
      shortcut={entry.shortcut ? formatShortcut(entry.shortcut, bridge.platform) : undefined}
      disabled={!enabled}
      onSelect={() => runAppAction(entry.action)}
    >
      {entry.label}
    </MenuItem>
  )
}

/**
 * Help → "Check for Updates…", with this build's version on the right. While an update is
 * downloading it shows the progress; once ready it becomes "Restart to Update (x)…".
 */
function UpdateItem() {
  const status = useUpdates((s) => s.status)
  const version = useUpdates((s) => s.appVersion)
  const item = updateMenuItem(status)
  return (
    <MenuItem
      shortcut={!item.installs && version ? `v${version}` : undefined}
      disabled={!item.enabled}
      onSelect={() => runAppAction('app.checkForUpdates')}
    >
      {item.label}
    </MenuItem>
  )
}

function Entries({ entries }: { entries: readonly MenuEntry[] }) {
  return entries.map((entry, i) =>
    entry.kind === 'separator' ? (
      <MenuSeparator key={`sep-${i}`} />
    ) : entry.action === 'app.checkForUpdates' ? (
      <UpdateItem key={entry.label} />
    ) : (
      <ActionItem key={entry.label} entry={entry} />
    ),
  )
}

/**
 * Gives each title a whole-pixel width (text rounded up + padding), like the text frames in
 * the reference artboards. With fractional advances the titles drift by a pixel or two along
 * the bar, and the menus anchored under them land between pixels. One measurement per font
 * load.
 */
function useWholePixelTitles(ref: RefObject<HTMLDivElement | null>): void {
  useLayoutEffect(() => {
    const bar = ref.current
    if (!bar) return
    const snap = () => {
      const items = Array.from(bar.querySelectorAll<HTMLElement>('[data-menubar-item]'))
      const range = document.createRange()
      const widths = items.map((item) => {
        item.style.width = ''
        range.selectNodeContents(item)
        const style = getComputedStyle(item)
        const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
        return Math.ceil(range.getBoundingClientRect().width) + padding
      })
      items.forEach((item, i) => (item.style.width = `${widths[i]}px`))
    }
    snap()
    let alive = true
    void document.fonts.ready.then(() => alive && snap())
    return () => {
      alive = false
    }
  }, [ref])
}

/**
 * File · Edit · View · Window · Help (artboards 09–13, 25). Menu contents only mount while
 * open, so the enabled-state subscriptions exist only then.
 */
export const AppMenuBar = memo(function AppMenuBar() {
  const ref = useRef<HTMLDivElement>(null)
  useWholePixelTitles(ref)
  // Artboard 25: a blue dot on "Help" while a downloaded update waits for a restart.
  const updateReady = useUpdates((s) => s.status.state === 'ready')
  return (
    <div ref={ref} className={css.menuBarSlot} data-update-ready={updateReady ? '' : undefined}>
      <MenuBar aria-label="Application menu">
        {APP_MENUS.map((menu) => (
          <MenuBarMenu key={menu.label} label={menu.label} width={menu.width}>
            <Entries entries={menu.entries} />
          </MenuBarMenu>
        ))}
      </MenuBar>
    </div>
  )
})
