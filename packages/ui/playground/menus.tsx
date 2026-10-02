import { MenuBar, MenuBarMenu, MenuItem, MenuSeparator, toast } from '../src'

/** Menu contents from artboards 09–13. `highlight` marks the row the reference shows hovered. */

const say = (what: string) => () => toast(what)

export function FileMenuItems({ highlight = false }: { highlight?: boolean }) {
  return (
    <>
      <MenuItem
        shortcut="Ctrl+Shift+N"
        data-highlighted={highlight ? '' : undefined}
        onSelect={say('New Window')}
      >
        New Window
      </MenuItem>
      <MenuSeparator />
      <MenuItem shortcut="Ctrl+Q" onSelect={say('Quit')}>
        Quit
      </MenuItem>
    </>
  )
}

export function EditMenuItems({ highlight = false }: { highlight?: boolean }) {
  return (
    <>
      <MenuItem shortcut="Ctrl+Z" onSelect={say('Undo')}>
        Undo
      </MenuItem>
      <MenuItem shortcut="Ctrl+Shift+Z" disabled>
        Redo
      </MenuItem>
      <MenuSeparator />
      <MenuItem shortcut="Ctrl+X" onSelect={say('Cut')}>
        Cut
      </MenuItem>
      <MenuItem
        shortcut="Ctrl+C"
        data-highlighted={highlight ? '' : undefined}
        onSelect={say('Copy')}
      >
        Copy
      </MenuItem>
      <MenuItem shortcut="Ctrl+V" onSelect={say('Paste')}>
        Paste
      </MenuItem>
      <MenuItem shortcut="Del" onSelect={say('Delete')}>
        Delete
      </MenuItem>
      <MenuSeparator />
      <MenuItem shortcut="Ctrl+A" onSelect={say('Select All')}>
        Select All
      </MenuItem>
    </>
  )
}

export function ViewMenuItems({ highlight = false }: { highlight?: boolean }) {
  return (
    <>
      <MenuItem shortcut="Ctrl+R">Reload</MenuItem>
      <MenuItem shortcut="Ctrl+Shift+R">Force Reload</MenuItem>
      <MenuItem shortcut="Ctrl+Shift+I" data-highlighted={highlight ? '' : undefined}>
        Toggle Developer Tools
      </MenuItem>
      <MenuSeparator />
      <MenuItem shortcut="F11">Toggle Full Screen</MenuItem>
    </>
  )
}

export function WindowMenuItems({ highlight = false }: { highlight?: boolean }) {
  return (
    <>
      <MenuItem shortcut="Ctrl+M" data-highlighted={highlight ? '' : undefined}>
        Minimize
      </MenuItem>
      <MenuItem>Zoom</MenuItem>
      <MenuItem shortcut="Ctrl+W">Close</MenuItem>
    </>
  )
}

export function HelpMenuItems({ highlight = false }: { highlight?: boolean }) {
  return (
    <>
      <MenuItem>Check for Updates…</MenuItem>
      <MenuSeparator />
      <MenuItem data-highlighted={highlight ? '' : undefined}>Documentation</MenuItem>
      <MenuItem>Video Tutorials</MenuItem>
      <MenuItem>Release Notes</MenuItem>
      <MenuSeparator />
      <MenuItem>Discord</MenuItem>
      <MenuItem>Slack Community</MenuItem>
      <MenuItem>Reddit</MenuItem>
      <MenuItem>X / Twitter</MenuItem>
    </>
  )
}

/** Live HTML menu bar with the real menu contents. */
export function AppMenuBar() {
  return (
    <MenuBar aria-label="Application menu">
      <MenuBarMenu label="File" width={248}>
        <FileMenuItems />
      </MenuBarMenu>
      <MenuBarMenu label="Edit" width={248}>
        <EditMenuItems />
      </MenuBarMenu>
      <MenuBarMenu label="View" width={300}>
        <ViewMenuItems />
      </MenuBarMenu>
      <MenuBarMenu label="Window" width={200}>
        <WindowMenuItems />
      </MenuBarMenu>
      <MenuBarMenu label="Help" width={220}>
        <HelpMenuItems />
      </MenuBarMenu>
    </MenuBar>
  )
}
