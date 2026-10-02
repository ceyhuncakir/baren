import { describe, expect, it, vi } from 'vitest'
import {
  COMMAND_IDS,
  isCommandEnabled,
  isCommandId,
  registerCommand,
  runCommand,
  subscribeCommand,
} from './commands'

describe('command registry', () => {
  it('runs the active handler and reports whether anything ran', () => {
    expect(runCommand('edit.undo')).toBe(false)
    const undo = vi.fn()
    const off = registerCommand('edit.undo', undo)
    expect(runCommand('edit.undo')).toBe(true)
    expect(undo).toHaveBeenCalledTimes(1)
    off()
    expect(runCommand('edit.undo')).toBe(false)
  })

  it('stacks registrations: the latest wins, unregistering restores the previous', () => {
    const editor = vi.fn()
    const input = vi.fn()
    const offEditor = registerCommand('edit.selectAll', editor)
    const offInput = registerCommand('edit.selectAll', input)
    runCommand('edit.selectAll')
    expect(input).toHaveBeenCalledTimes(1)
    expect(editor).not.toHaveBeenCalled()
    offInput()
    offInput() // idempotent: must not remove the editor's registration
    runCommand('edit.selectAll')
    expect(editor).toHaveBeenCalledTimes(1)
    offEditor()
    expect(isCommandEnabled('edit.selectAll')).toBe(false)
  })

  it('handles the same function registered twice independently', () => {
    const fn = vi.fn()
    const a = registerCommand('view.zoomIn', fn)
    const b = registerCommand('view.zoomIn', fn)
    a()
    expect(isCommandEnabled('view.zoomIn')).toBe(true)
    b()
    expect(isCommandEnabled('view.zoomIn')).toBe(false)
  })

  it('notifies subscribers of the command only', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeCommand('edit.copy', listener)
    const off = registerCommand('edit.copy', () => {})
    registerCommand('edit.paste', () => {})()
    off()
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
    registerCommand('edit.copy', () => {})()
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('declares the contract ids, plus the Help links sent by the macOS menu', () => {
    expect(COMMAND_IDS.slice(0, 11)).toEqual([
      'edit.undo',
      'edit.redo',
      'edit.cut',
      'edit.copy',
      'edit.paste',
      'edit.delete',
      'edit.selectAll',
      'view.zoomIn',
      'view.zoomOut',
      'view.zoomToFit',
      'view.zoom100',
    ])
    expect(COMMAND_IDS.slice(11, 19)).toEqual([
      'edit.pasteInPlace',
      'edit.duplicate',
      'object.group',
      'object.ungroup',
      'object.createComponent',
      'object.detachInstance',
      'object.resetOverrides',
      'object.goToMainComponent',
    ])
    expect(COMMAND_IDS.slice(19)).toEqual([
      'help.documentation',
      'help.videoTutorials',
      'help.releaseNotes',
      'help.discord',
      'help.slack',
      'help.reddit',
      'help.twitter',
    ])
  })

  it('narrows untrusted ids', () => {
    expect(isCommandId('edit.copy')).toBe(true)
    expect(isCommandId('help.discord')).toBe(true)
    expect(isCommandId('object.group')).toBe(true)
    expect(isCommandId('edit.pasteInPlace')).toBe(true)
    expect(isCommandId('app.quit')).toBe(false)
    expect(isCommandId(42)).toBe(false)
  })
})
