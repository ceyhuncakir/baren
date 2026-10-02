import type { MenuItemConstructorOptions } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { MENU_COMMANDS, macMenuTemplate, type MenuActions } from './appMenu'

function actions() {
  return {
    newWindow: vi.fn<() => void>(),
    reload: vi.fn<() => void>(),
    forceReload: vi.fn<() => void>(),
    toggleDevTools: vi.fn<() => void>(),
    toggleFullScreen: vi.fn<() => void>(),
    checkForUpdates: vi.fn<() => void>(),
    command: vi.fn<(id: string) => void>(),
  } satisfies MenuActions
}

function items(template: MenuItemConstructorOptions[], menu: string): MenuItemConstructorOptions[] {
  const sub = template.find((m) => m.label === menu)?.submenu
  return Array.isArray(sub) ? sub : []
}

function click(item: MenuItemConstructorOptions | undefined): void {
  ;(item?.click as (() => void) | undefined)?.()
}

describe('macMenuTemplate', () => {
  it('mirrors the HTML menu bar (artboards 09–13)', () => {
    const template = macMenuTemplate('Baren', actions())
    expect(template.map((m) => m.label)).toEqual([
      'Baren',
      'File',
      'Edit',
      'View',
      'Window',
      'Help',
    ])
    expect(
      items(template, 'Edit')
        .filter((i) => i.label)
        .map((i) => i.label),
    ).toEqual(['Undo', 'Redo', 'Cut', 'Copy', 'Paste', 'Delete', 'Select All'])
    expect(
      items(template, 'Help')
        .filter((i) => i.label)
        .map((i) => i.label),
    ).toEqual([
      'Check for Updates…',
      'Documentation',
      'Video Tutorials',
      'Release Notes',
      'Discord',
      'Slack Community',
      'Reddit',
      'X / Twitter',
    ])
  })

  it('sends renderer command ids for document actions', () => {
    const a = actions()
    const template = macMenuTemplate('Baren', a)
    for (const item of items(template, 'Edit')) click(item)
    expect(a.command.mock.calls.map(([id]) => id)).toEqual([
      MENU_COMMANDS.undo,
      MENU_COMMANDS.redo,
      MENU_COMMANDS.cut,
      MENU_COMMANDS.copy,
      MENU_COMMANDS.paste,
      MENU_COMMANDS.delete,
      MENU_COMMANDS.selectAll,
    ])
    expect(items(template, 'Edit').find((i) => i.label === 'Delete')?.accelerator).toBeUndefined()
  })

  it('runs app commands in main', () => {
    const a = actions()
    const template = macMenuTemplate('Baren', a)
    click(items(template, 'File')[0])
    for (const item of items(template, 'View')) click(item)
    expect(a.newWindow).toHaveBeenCalledOnce()
    expect(a.reload).toHaveBeenCalledOnce()
    expect(a.forceReload).toHaveBeenCalledOnce()
    expect(a.toggleDevTools).toHaveBeenCalledOnce()
    expect(a.toggleFullScreen).toHaveBeenCalledOnce()
  })
})
