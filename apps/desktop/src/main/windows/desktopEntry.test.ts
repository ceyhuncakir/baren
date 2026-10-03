import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEV_DESKTOP_ID,
  type RunCommand,
  claimDevSchemeHandler,
  ensureDevDesktopEntry,
  renderDevDesktopEntry,
} from './desktopEntry'

const INPUT = {
  execPath: '/repo/node_modules/electron/dist/electron',
  appPath: '/repo/apps/desktop',
  iconPath: '/repo/apps/desktop/resources/icon.png',
}

describe('dev desktop entry', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('matches the dev app id and stays out of the app grid', () => {
    const entry = renderDevDesktopEntry(INPUT)
    expect(DEV_DESKTOP_ID).toBe('baren-dev.desktop')
    expect(entry).toContain('StartupWMClass=baren-dev\n')
    expect(entry).toContain(`Icon=${INPUT.iconPath}\n`)
    expect(entry).toContain(`Exec=${INPUT.execPath} ${INPUT.appPath} %U\n`)
    expect(entry).toContain('NoDisplay=true\n')
    expect(entry).toContain('MimeType=x-scheme-handler/baren;\n')
  })

  it('quotes Exec arguments with spaces and reserved characters', () => {
    const entry = renderDevDesktopEntry({ ...INPUT, appPath: '/home/a b/$x "q"' })
    expect(entry).toContain(`Exec=${INPUT.execPath} "/home/a b/\\$x \\"q\\"" %U\n`)
  })

  it('writes once and rewrites only when stale', () => {
    const dataHome = mkdtempSync(join(tmpdir(), 'baren-entry-'))
    dirs.push(dataHome)
    const file = join(dataHome, 'applications', DEV_DESKTOP_ID)
    expect(ensureDevDesktopEntry(INPUT, dataHome)).toBe(file)
    expect(ensureDevDesktopEntry(INPUT, dataHome)).toBeNull()
    expect(ensureDevDesktopEntry({ ...INPUT, iconPath: '/other.png' }, dataHome)).toBe(file)
    expect(readFileSync(file, 'utf8')).toContain('Icon=/other.png\n')
  })

  describe('baren:// handler', () => {
    /** Fake xdg-mime: `query` answers `current`; every call is recorded. */
    function xdgMime(current: string) {
      const calls: string[][] = []
      const run: RunCommand = async (file, args) => {
        calls.push([file, ...args])
        return { stdout: args[0] === 'query' ? `${current}\n` : '' }
      }
      return { run, calls }
    }

    it('claims links nobody handles', async () => {
      const { run, calls } = xdgMime('')
      expect(await claimDevSchemeHandler(false, run)).toBe(true)
      expect(calls.at(-1)).toEqual([
        'xdg-mime',
        'default',
        DEV_DESKTOP_ID,
        'x-scheme-handler/baren',
      ])
    })

    it('leaves an installed build in charge unless forced', async () => {
      const installed = xdgMime('baren.desktop')
      expect(await claimDevSchemeHandler(false, installed.run)).toBe(false)
      expect(installed.calls).toHaveLength(1)
      const forced = xdgMime('baren.desktop')
      expect(await claimDevSchemeHandler(true, forced.run)).toBe(true)
      expect(forced.calls).toHaveLength(2)
    })

    it('rewrites the default when the lookup only falls back to the dev entry', async () => {
      const { run, calls } = xdgMime(DEV_DESKTOP_ID)
      expect(await claimDevSchemeHandler(false, run)).toBe(false)
      expect(calls.at(-1)).toEqual([
        'xdg-mime',
        'default',
        DEV_DESKTOP_ID,
        'x-scheme-handler/baren',
      ])
    })
  })
})
