import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEV_DESKTOP_ID, ensureDevDesktopEntry, renderDevDesktopEntry } from './desktopEntry'

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
    expect(entry).toContain(`Exec=${INPUT.execPath} ${INPUT.appPath}\n`)
    expect(entry).toContain('NoDisplay=true\n')
  })

  it('quotes Exec arguments with spaces and reserved characters', () => {
    const entry = renderDevDesktopEntry({ ...INPUT, appPath: '/home/a b/$x "q"' })
    expect(entry).toContain(`Exec=${INPUT.execPath} "/home/a b/\\$x \\"q\\""\n`)
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
})
