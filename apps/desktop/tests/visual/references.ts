import { readFileSync, writeFileSync } from 'node:fs'

/**
 * `UPDATE_REFERENCES=1 pnpm test:visual` rewrites design/reference/*.png from the current
 * captures. Use it only after an intentional design change, and review the new PNGs.
 */
export const UPDATE_REFERENCES = process.env['UPDATE_REFERENCES'] === '1'

/** The reference PNG at `path`; in update mode `actual` is written there first. */
export function readReference(path: string, actual: Buffer): Buffer {
  if (UPDATE_REFERENCES) writeFileSync(path, actual)
  return readFileSync(path)
}
