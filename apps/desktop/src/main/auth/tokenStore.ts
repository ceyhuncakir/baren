/**
 * Session token persistence (`window.baren.auth`). Encrypted with Electron
 * safeStorage (Keychain / DPAPI / libsecret / kwallet) into `auth.json` in
 * userData. When no OS secret store is available (Linux without a keyring),
 * the token is stored base64-encoded with 0600 permissions and a warning, and
 * upgraded to encryption as soon as it becomes available.
 */
import { rm } from 'node:fs/promises'
import type { Logger } from '../log'
import { isNotFound, readJsonOrNull, writeFileAtomic } from '../util/fs'

export interface SecretCipher {
  isAvailable(): Promise<boolean>
  /** Linux secret backend name; 'basic_text' means a hardcoded key (obfuscation only). */
  backendName(): string
  encrypt(plainText: string): Promise<Buffer>
  decrypt(data: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>
}

type Scheme = 'safeStorage' | 'plain'

interface StoredToken {
  v: 1
  scheme: Scheme
  data: string
}

const MAX_TOKEN_LENGTH = 16 * 1024

function parseStored(value: unknown): StoredToken | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (v['v'] !== 1 || (v['scheme'] !== 'safeStorage' && v['scheme'] !== 'plain')) return null
  if (typeof v['data'] !== 'string') return null
  return { v: 1, scheme: v['scheme'], data: v['data'] }
}

export class TokenStore {
  private cache: { token: string | null } | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private warnedPlain = false
  private warnedWeak = false

  constructor(
    private readonly file: string,
    private readonly cipher: SecretCipher,
    private readonly log: Logger,
  ) {}

  getToken(): Promise<string | null> {
    return this.serial(async () => {
      if (this.cache) return this.cache.token
      const token = await this.read()
      this.cache = { token }
      return token
    })
  }

  setToken(token: string | null): Promise<void> {
    if (token !== null && (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH)) {
      return Promise.reject(new Error('Invalid token'))
    }
    return this.serial(async () => {
      if (token === null || token === '') {
        await rm(this.file, { force: true })
        this.cache = { token: null }
        return
      }
      await this.write(token)
      this.cache = { token }
    })
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task)
    this.queue = result.catch(() => undefined)
    return result
  }

  private async read(): Promise<string | null> {
    let stored: StoredToken | null
    try {
      stored = parseStored(await readJsonOrNull(this.file))
    } catch (error) {
      if (!isNotFound(error))
        this.log.warn('unreadable auth token file; signing out', String(error))
      return null
    }
    if (!stored) return null

    if (stored.scheme === 'plain') {
      const token = Buffer.from(stored.data, 'base64').toString('utf8')
      if (await this.cipher.isAvailable()) await this.write(token) // upgrade to encryption
      return token
    }

    if (!(await this.cipher.isAvailable())) {
      this.log.warn('auth token is encrypted but the OS secret store is unavailable; signing out')
      return null
    }
    try {
      const { result, shouldReEncrypt } = await this.cipher.decrypt(
        Buffer.from(stored.data, 'base64'),
      )
      if (shouldReEncrypt) await this.write(result)
      return result
    } catch (error) {
      // Keyring reset or file copied from another machine: the token is unrecoverable.
      this.log.warn('could not decrypt auth token; signing out', String(error))
      return null
    }
  }

  private async write(token: string): Promise<void> {
    let stored: StoredToken
    if (await this.cipher.isAvailable()) {
      if (this.cipher.backendName() === 'basic_text' && !this.warnedWeak) {
        this.warnedWeak = true
        this.log.warn('no OS keyring found; safeStorage is using a hardcoded key (basic_text)')
      }
      const encrypted = await this.cipher.encrypt(token)
      stored = { v: 1, scheme: 'safeStorage', data: encrypted.toString('base64') }
    } else {
      if (!this.warnedPlain) {
        this.warnedPlain = true
        this.log.warn('OS secret storage unavailable; storing the auth token unencrypted (0600)')
      }
      stored = { v: 1, scheme: 'plain', data: Buffer.from(token, 'utf8').toString('base64') }
    }
    await writeFileAtomic(this.file, JSON.stringify(stored), { mode: 0o600 })
  }
}

/** Minimal structural type of Electron's `safeStorage`. */
export interface SafeStorageLike {
  isAsyncEncryptionAvailable(): Promise<boolean>
  getSelectedStorageBackend?(): string
  encryptStringAsync(plainText: string): Promise<Buffer>
  decryptStringAsync(encrypted: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>
}

export function safeStorageCipher(safeStorage: SafeStorageLike, platform: string): SecretCipher {
  let available: Promise<boolean> | null = null
  return {
    isAvailable: () => {
      available ??= safeStorage.isAsyncEncryptionAvailable().catch(() => false)
      return available
    },
    backendName: () =>
      platform === 'linux' ? (safeStorage.getSelectedStorageBackend?.() ?? 'unknown') : platform,
    encrypt: (plainText) => safeStorage.encryptStringAsync(plainText),
    decrypt: (data) => safeStorage.decryptStringAsync(data),
  }
}
