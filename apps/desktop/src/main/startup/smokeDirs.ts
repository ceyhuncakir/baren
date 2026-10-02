/**
 * Throwaway userData directories for BAREN_SMOKE runs. Chromium writes a
 * few files (Local State, Preferences) while shutting down, after main can
 * delete anything, so each run also removes stale directories left by
 * earlier runs. Fresh ones may belong to a smoke run in progress and stay.
 */
import { mkdirSync, mkdtempSync } from 'node:fs'
import { readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const SMOKE_ROOT = join(tmpdir(), 'baren-smoke')
const STALE_AFTER_MS = 10 * 60 * 1000

export function createSmokeUserDataDir(root: string = SMOKE_ROOT): string {
  mkdirSync(root, { recursive: true })
  return mkdtempSync(join(root, 'run-'))
}

/** Remove `run-*` directories under `root` older than `maxAgeMs`, except `keep`. */
export async function removeStaleSmokeDirs(
  keep: string,
  root: string = SMOKE_ROOT,
  maxAgeMs: number = STALE_AFTER_MS,
  now: number = Date.now(),
): Promise<string[]> {
  const removed: string[] = []
  let entries: string[]
  try {
    entries = await readdir(root)
  } catch {
    return removed
  }
  await Promise.all(
    entries
      .filter((name) => name.startsWith('run-'))
      .map(async (name) => {
        const dir = join(root, name)
        if (dir === keep) return
        try {
          if (now - (await stat(dir)).mtimeMs < maxAgeMs) return
          await rm(dir, { recursive: true, force: true })
          removed.push(dir)
        } catch {
          // Raced with another run's cleanup: nothing to do.
        }
      }),
  )
  return removed
}
