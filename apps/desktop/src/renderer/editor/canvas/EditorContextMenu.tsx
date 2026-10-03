/**
 * Context menu for the canvas and the layers panel (artboard 15), with the "Copy as"
 * submenu. Opened by the canvas `onContextMenu` callback or a right-click on a layer row.
 *
 * Phase 3 (contract §6): Paste in place, Group selection and Create component are always
 * listed; Ungroup appears for groups, and Go to main component / Reset overrides / Detach
 * instance for instances and their content. Structure items are disabled for expanded
 * instance content (it cannot be restructured).
 */
import { ContextMenu, MenuItem, MenuSeparator, Submenu } from '@baren/ui'
import { formatShortcut } from '../commands/shortcutLabels'
import { useEditor, useEditorState, useSelectedNodes } from '../session/context'

export function EditorContextMenu() {
  const session = useEditor()
  const { store, actions } = session
  const menu = useEditorState((s) => s.contextMenu)
  const selection = useEditorState((s) => s.selection)
  // Re-reads the facts when the selected nodes change (type, flags, overrides).
  const nodes = useSelectedNodes().nodes
  const close = () => store.setState({ contextMenu: null })
  const has = selection.length > 0
  const info = actions.info(selection)
  const structural = info.real.length > 0 && !info.virtual
  const anyFrame = nodes.some((n) => n.type === 'frame')
  const locked = has && nodes.every((n) => n.locked === true)
  const hidden = has && nodes.every((n) => n.hidden === true)
  const component = info.overridable.length > 0
  const k = formatShortcut

  return (
    <ContextMenu
      open={menu !== null}
      x={menu?.x ?? 0}
      y={menu?.y ?? 0}
      onClose={close}
      aria-label="Layer actions"
    >
      <MenuItem shortcut={k('Mod+C')} disabled={!has} onSelect={() => void actions.copy()}>
        Copy
      </MenuItem>
      <MenuItem
        shortcut={k('Mod+V')}
        onSelect={() =>
          void actions.paste(
            menu?.world ? 'here' : 'paste',
            menu?.world
              ? { world: menu.world, client: { clientX: menu.x, clientY: menu.y } }
              : null,
          )
        }
      >
        Paste here
      </MenuItem>
      <MenuItem shortcut={k('Mod+Shift+V')} onSelect={() => void actions.pasteInPlace()}>
        Paste in place
      </MenuItem>
      <MenuItem shortcut={k('Mod+D')} disabled={!has} onSelect={() => actions.duplicate()}>
        Duplicate
      </MenuItem>
      <Submenu label="Copy as" width={220} disabled={!has}>
        <MenuItem shortcut={k('Mod+Alt+C')} onSelect={() => void actions.copyAs('html')}>
          HTML
        </MenuItem>
        <MenuItem onSelect={() => void actions.copyAs('jsx')}>React (JSX)</MenuItem>
        <MenuItem onSelect={() => void actions.copyAs('css')}>CSS</MenuItem>
        <MenuItem onSelect={() => void actions.copyAs('svg')}>SVG</MenuItem>
        <MenuSeparator />
        <MenuItem shortcut="1×" onSelect={() => void actions.copyAs('png1')}>
          PNG
        </MenuItem>
        <MenuItem shortcut="2×" onSelect={() => void actions.copyAs('png2')}>
          PNG
        </MenuItem>
        <MenuSeparator />
        <MenuItem onSelect={() => void actions.copyAs('link')}>Link to selection</MenuItem>
        <MenuItem shortcut={k('Mod+Shift+C')} onSelect={() => void actions.copyAs('agent')}>
          Agent context
        </MenuItem>
      </Submenu>
      <MenuSeparator />
      <MenuItem
        shortcut={k('Shift+A')}
        disabled={!anyFrame || info.virtual}
        onSelect={() => actions.addFlex()}
      >
        Add flex layout
      </MenuItem>
      <MenuItem
        shortcut={k('Mod+Alt+G')}
        disabled={!structural}
        onSelect={() => actions.wrapInFrame()}
      >
        Wrap in frame
      </MenuItem>
      <MenuItem shortcut={k('Mod+G')} disabled={!structural} onSelect={() => actions.group()}>
        Group selection
      </MenuItem>
      {info.groups.length > 0 && (
        <MenuItem shortcut={k('Mod+Shift+G')} onSelect={() => actions.ungroup()}>
          Ungroup
        </MenuItem>
      )}
      <MenuItem
        shortcut={k('Mod+Alt+K')}
        disabled={!structural}
        onSelect={() => actions.createComponent()}
      >
        Create component
      </MenuItem>
      {component && (
        <>
          <MenuItem onSelect={() => actions.goToMainComponent()}>Go to main component</MenuItem>
          <MenuItem onSelect={() => actions.resetOverrides()}>Reset overrides</MenuItem>
          {info.instances.length > 0 && (
            <MenuItem shortcut={k('Mod+Alt+B')} onSelect={() => actions.detachInstance()}>
              Detach instance
            </MenuItem>
          )}
        </>
      )}
      <MenuItem
        shortcut={k('Mod+]')}
        disabled={!structural}
        onSelect={() => actions.bringToFront()}
      >
        Bring to front
      </MenuItem>
      <MenuItem shortcut={k('Mod+[')} disabled={!structural} onSelect={() => actions.sendToBack()}>
        Send to back
      </MenuItem>
      <MenuSeparator />
      <MenuItem
        shortcut="F2"
        disabled={selection.length !== 1 || info.virtual}
        onSelect={() => actions.rename()}
      >
        Rename
      </MenuItem>
      <MenuItem
        shortcut={k('Mod+Shift+L')}
        disabled={!structural}
        onSelect={() => actions.toggleLock()}
      >
        {locked ? 'Unlock' : 'Lock'}
      </MenuItem>
      <MenuItem shortcut={k('Mod+Shift+H')} disabled={!has} onSelect={() => actions.toggleHide()}>
        {hidden ? 'Show' : 'Hide'}
      </MenuItem>
      <MenuSeparator />
      <MenuItem shortcut="Del" destructive disabled={!has} onSelect={() => actions.delete()}>
        Delete
      </MenuItem>
    </ContextMenu>
  )
}
