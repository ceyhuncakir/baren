import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createLogger } from '../log'
import { TokenStore, safeStorageCipher, type SecretCipher } from './tokenStore'

/** Reversible fake "encryption" so tests can tell encrypted from plain storage. */
function fakeCipher(options: {
  available: boolean
  backend?: string
  reEncrypt?: boolean
}): SecretCipher & {
  available: boolean
} {
  const cipher = {
    available: options.available,
    isAvailable: async () => cipher.available,
    backendName: () => options.backend ?? 'gnome_libsecret',
    encrypt: async (plain: string) => Buffer.from(`enc:${plain}`),
    decrypt: async (data: Buffer) => {
      const text = data.toString()
      if (!text.startsWith('enc:')) throw new Error('bad key')
      return { result: text.slice(4), shouldReEncrypt: options.reEncrypt ?? false }
    },
  }
  return cipher
}

describe('TokenStore', () => {
  let dir: string
  let file: string
  const warnings: string[] = []
  const log = createLogger('test', { sink: (line) => warnings.push(line) })

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'baren-auth-'))
    file = join(dir, 'auth.json')
    warnings.length = 0
  })
  afterEach(() => rm(dir, { recursive: true, force: true }))

  it('encrypts with safeStorage and round-trips across instances', async () => {
    await new TokenStore(file, fakeCipher({ available: true }), log).setToken('secret-token')
    const stored = JSON.parse(await readFile(file, 'utf8')) as { scheme: string; data: string }
    expect(stored.scheme).toBe('safeStorage')
    expect(Buffer.from(stored.data, 'base64').toString()).toBe('enc:secret-token')
    expect(await new TokenStore(file, fakeCipher({ available: true }), log).getToken()).toBe(
      'secret-token',
    )
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600)
  })

  it('returns null when signed out and deletes the file on setToken(null)', async () => {
    const store = new TokenStore(file, fakeCipher({ available: true }), log)
    expect(await store.getToken()).toBeNull()
    await store.setToken('t')
    await store.setToken(null)
    expect(await store.getToken()).toBeNull()
    await expect(stat(file)).rejects.toThrow()
  })

  it('falls back to plain storage with a warning when no secret store exists (Linux)', async () => {
    const store = new TokenStore(file, fakeCipher({ available: false }), log)
    await store.setToken('plain-token')
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ scheme: 'plain' })
    expect(warnings.join('\n')).toMatch(/unencrypted/)
    expect(await new TokenStore(file, fakeCipher({ available: false }), log).getToken()).toBe(
      'plain-token',
    )
  })

  it('upgrades a plain token to encryption once a keyring is available', async () => {
    await new TokenStore(file, fakeCipher({ available: false }), log).setToken('t1')
    expect(await new TokenStore(file, fakeCipher({ available: true }), log).getToken()).toBe('t1')
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ scheme: 'safeStorage' })
  })

  it('warns that basic_text is not real encryption', async () => {
    await new TokenStore(
      file,
      fakeCipher({ available: true, backend: 'basic_text' }),
      log,
    ).setToken('t')
    expect(warnings.join('\n')).toMatch(/basic_text/)
  })

  it('signs out when the token cannot be decrypted or the file is corrupt', async () => {
    await writeFile(
      file,
      JSON.stringify({
        v: 1,
        scheme: 'safeStorage',
        data: Buffer.from('garbage').toString('base64'),
      }),
    )
    expect(await new TokenStore(file, fakeCipher({ available: true }), log).getToken()).toBeNull()
    await writeFile(file, '{oops')
    expect(await new TokenStore(file, fakeCipher({ available: true }), log).getToken()).toBeNull()
  })

  it('re-encrypts when safeStorage rotated its key', async () => {
    await new TokenStore(file, fakeCipher({ available: true }), log).setToken('t')
    const rotated = fakeCipher({ available: true, reEncrypt: true })
    let encrypts = 0
    const encrypt = rotated.encrypt
    rotated.encrypt = async (plain) => {
      encrypts++
      return encrypt(plain)
    }
    expect(await new TokenStore(file, rotated, log).getToken()).toBe('t')
    expect(encrypts).toBe(1)
  })

  it('rejects oversized tokens', async () => {
    await expect(
      new TokenStore(file, fakeCipher({ available: true }), log).setToken('x'.repeat(20_000)),
    ).rejects.toThrow()
  })
})

describe('safeStorageCipher', () => {
  it('uses the async safeStorage API and reports the Linux backend', async () => {
    const cipher = safeStorageCipher(
      {
        isAsyncEncryptionAvailable: async () => true,
        getSelectedStorageBackend: () => 'kwallet6',
        encryptStringAsync: async (s) => Buffer.from(s),
        decryptStringAsync: async (b) => ({ result: b.toString(), shouldReEncrypt: false }),
      },
      'linux',
    )
    expect(await cipher.isAvailable()).toBe(true)
    expect(cipher.backendName()).toBe('kwallet6')
    expect((await cipher.decrypt(await cipher.encrypt('x'))).result).toBe('x')
  })

  it('treats a throwing availability check as unavailable', async () => {
    const cipher = safeStorageCipher(
      {
        isAsyncEncryptionAvailable: async () => {
          throw new Error('dbus')
        },
        encryptStringAsync: async (s) => Buffer.from(s),
        decryptStringAsync: async (b) => ({ result: b.toString(), shouldReEncrypt: false }),
      },
      'darwin',
    )
    expect(await cipher.isAvailable()).toBe(false)
    expect(cipher.backendName()).toBe('darwin')
  })
})
