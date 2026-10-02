/**
 * Native application menu. Linux/Windows have none (`Menu.setApplicationMenu(null)`;
 * the renderer draws the HTML menu bar from artboards 09–13). macOS keeps
 * a native menu bar mirroring those menus: app-level items act in main,
 * document items send the same command ids the HTML menu runs.
 */
import type { MenuItemConstructorOptions } from 'electron'

export interface MenuActions {
  newWindow(): void
  reload(): void
  forceReload(): void
  toggleDevTools(): void
  toggleFullScreen(): void
  checkForUpdates(): void
  /** Forward a renderer command id to the focused window. */
  command(id: string): void
}

/** Renderer command ids the native menu can send (`baren:command` events). */
export const MENU_COMMANDS = {
  undo: 'edit.undo',
  redo: 'edit.redo',
  cut: 'edit.cut',
  copy: 'edit.copy',
  paste: 'edit.paste',
  delete: 'edit.delete',
  selectAll: 'edit.selectAll',
  documentation: 'help.documentation',
  videoTutorials: 'help.videoTutorials',
  releaseNotes: 'help.releaseNotes',
  discord: 'help.discord',
  slack: 'help.slack',
  reddit: 'help.reddit',
  twitter: 'help.twitter',
} as const

export function macMenuTemplate(appName: string, a: MenuActions): MenuItemConstructorOptions[] {
  const cmd = (label: string, id: string, accelerator?: string): MenuItemConstructorOptions => ({
    label,
    ...(accelerator ? { accelerator } : {}),
    click: () => a.command(id),
  })
  return [
    {
      label: appName,
      submenu: [
        { role: 'about' },
        { label: 'Check for Updates…', click: () => a.checkForUpdates() },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [{ label: 'New Window', accelerator: 'Shift+Cmd+N', click: () => a.newWindow() }],
    },
    {
      label: 'Edit',
      submenu: [
        cmd('Undo', MENU_COMMANDS.undo, 'Cmd+Z'),
        cmd('Redo', MENU_COMMANDS.redo, 'Shift+Cmd+Z'),
        { type: 'separator' },
        cmd('Cut', MENU_COMMANDS.cut, 'Cmd+X'),
        cmd('Copy', MENU_COMMANDS.copy, 'Cmd+C'),
        cmd('Paste', MENU_COMMANDS.paste, 'Cmd+V'),
        // No accelerator: Backspace must keep its default meaning in text fields.
        cmd('Delete', MENU_COMMANDS.delete),
        { type: 'separator' },
        cmd('Select All', MENU_COMMANDS.selectAll, 'Cmd+A'),
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Reload', accelerator: 'Cmd+R', click: () => a.reload() },
        { label: 'Force Reload', accelerator: 'Shift+Cmd+R', click: () => a.forceReload() },
        {
          label: 'Toggle Developer Tools',
          accelerator: 'Alt+Cmd+I',
          click: () => a.toggleDevTools(),
        },
        { type: 'separator' },
        {
          label: 'Toggle Full Screen',
          accelerator: 'Ctrl+Cmd+F',
          click: () => a.toggleFullScreen(),
        },
      ],
    },
    {
      label: 'Window',
      role: 'windowMenu',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { role: 'close' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
    {
      label: 'Help',
      role: 'help',
      submenu: [
        { label: 'Check for Updates…', click: () => a.checkForUpdates() },
        { type: 'separator' },
        cmd('Documentation', MENU_COMMANDS.documentation),
        cmd('Video Tutorials', MENU_COMMANDS.videoTutorials),
        cmd('Release Notes', MENU_COMMANDS.releaseNotes),
        { type: 'separator' },
        cmd('Discord', MENU_COMMANDS.discord),
        cmd('Slack Community', MENU_COMMANDS.slack),
        cmd('Reddit', MENU_COMMANDS.reddit),
        cmd('X / Twitter', MENU_COMMANDS.twitter),
      ],
    },
  ]
}
