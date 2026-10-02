import { randomBytes } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'

export function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

export function isNotFound(error: unknown): boolean {
  return isErrnoException(error) && error.code === 'ENOENT'
}

const RETRYABLE_RENAME = new Set(['EPERM', 'EACCES', 'EBUSY'])

/**
 * Write via a temp file + rename so readers never see a torn file and a crash
 * mid-write keeps the previous version. Windows can transiently refuse the
 * rename (antivirus, indexer), so that is retried briefly.
 */
export async function writeFileAtomic(
  path: string,
  data: string | Uint8Array,
  options: { mode?: number } = {},
): Promise<void> {
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(tmp, data, options.mode === undefined ? {} : { mode: options.mode })
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, path)
      return
    } catch (error) {
      const retry =
        process.platform === 'win32' &&
        attempt < 5 &&
        isErrnoException(error) &&
        RETRYABLE_RENAME.has(error.code ?? '')
      if (!retry) {
        await rm(tmp, { force: true })
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)))
    }
  }
}

/** Read a file, or `null` if it does not exist. */
export async function readFileOrNull(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path)
  } catch (error) {
    if (isNotFound(error)) return null
    throw error
  }
}

/** Read and parse JSON, or `null` if the file does not exist. Throws on malformed JSON. */
export async function readJsonOrNull(path: string): Promise<unknown> {
  const bytes = await readFileOrNull(path)
  return bytes === null ? null : (JSON.parse(bytes.toString('utf8')) as unknown)
}
