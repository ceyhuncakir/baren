import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RENDERER_ORIGIN, resolveRendererFile } from '../protocol/rendererPaths'
import { buildCsp, serverOrigins } from './csp'
import { isPermissionAllowed } from './guards'
import { isAppUrl, isSafeExternalUrl, originOf } from './urls'

const origins = [RENDERER_ORIGIN, 'http://localhost:5173']

describe('urls', () => {
  it('computes origins for custom schemes too', () => {
    expect(originOf('app://renderer/index.html')).toBe('app://renderer')
    expect(originOf('http://localhost:5173/src/main.tsx')).toBe('http://localhost:5173')
    expect(originOf('not a url')).toBeNull()
  })

  it('recognises app URLs only on the exact origin', () => {
    expect(isAppUrl('app://renderer/index.html', origins)).toBe(true)
    expect(isAppUrl('http://localhost:5173/', origins)).toBe(true)
    expect(isAppUrl('http://localhost:5174/', origins)).toBe(false)
    expect(isAppUrl('app://evil/index.html', origins)).toBe(false)
    expect(isAppUrl('file:///etc/passwd', origins)).toBe(false)
  })

  it('only lets http(s) links leave the app', () => {
    expect(isSafeExternalUrl('https://baren.dev/docs')).toBe(true)
    expect(isSafeExternalUrl('http://127.0.0.1:8787/device?code=1')).toBe(true)
    for (const url of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'smb://host/share',
      'baren://invite/x',
      'https://',
      42,
    ]) {
      expect(isSafeExternalUrl(url)).toBe(false)
    }
    expect(isSafeExternalUrl(`https://a.b/${'x'.repeat(9000)}`)).toBe(false)
  })
})

describe('permissions', () => {
  it('allows clipboard and fullscreen for the app only', () => {
    expect(
      isPermissionAllowed('clipboard-sanitized-write', 'app://renderer/index.html', origins),
    ).toBe(true)
    expect(isPermissionAllowed('clipboard-read', 'http://localhost:5173/', origins)).toBe(true)
    expect(isPermissionAllowed('clipboard-read', 'https://evil.example/', origins)).toBe(false)
    expect(isPermissionAllowed('media', 'app://renderer/index.html', origins)).toBe(false)
    expect(isPermissionAllowed('geolocation', 'app://renderer/index.html', origins)).toBe(false)
  })
})

describe('csp', () => {
  it('derives HTTP and WebSocket origins from the server URL', () => {
    expect(serverOrigins('http://127.0.0.1:8787')).toEqual([
      'http://127.0.0.1:8787',
      'ws://127.0.0.1:8787',
    ])
    expect(serverOrigins('https://api.baren.dev/base')).toEqual([
      'https://api.baren.dev',
      'wss://api.baren.dev',
    ])
    expect(serverOrigins('ftp://x')).toEqual([])
    expect(serverOrigins('nope')).toEqual([])
  })

  it('is strict: same-origin scripts, wasm allowed, no eval, no plugins or framing', () => {
    const csp = buildCsp('http://127.0.0.1:8787')
    const directive = (name: string) => csp.split('; ').find((d) => d.startsWith(`${name} `))
    expect(directive('script-src')).toBe("script-src 'self' 'wasm-unsafe-eval'")
    expect(directive('connect-src')).toBe(
      "connect-src 'self' baren-asset: http://127.0.0.1:8787 ws://127.0.0.1:8787",
    )
    expect(directive('object-src')).toBe("object-src 'none'")
    expect(directive('frame-ancestors')).toBe("frame-ancestors 'none'")
    expect(csp).not.toContain("'unsafe-eval'")
    expect(directive('script-src')).not.toContain("'unsafe-inline'")
  })
})

describe('csp: image assets', () => {
  it('lets the renderer load baren-asset:// as images, media and via fetch', () => {
    const csp = buildCsp('https://api.baren.dev')
    const directive = (name: string) => csp.split('; ').find((d) => d.startsWith(`${name} `))
    expect(directive('img-src')).toBe(
      "img-src 'self' data: blob: baren-asset: https://api.baren.dev",
    )
    expect(directive('media-src')).toBe("media-src 'self' data: blob: baren-asset:")
    expect(directive('connect-src')).toContain(' baren-asset: ')
  })
})

describe('resolveRendererFile', () => {
  const root = join('/', 'opt', 'app', 'out', 'renderer')

  it('maps app:// URLs into the renderer directory', () => {
    expect(resolveRendererFile(root, 'app://renderer/index.html')).toBe(join(root, 'index.html'))
    expect(resolveRendererFile(root, 'app://renderer/')).toBe(join(root, 'index.html'))
    expect(resolveRendererFile(root, 'app://renderer/assets/a%20b.js?v=1#x')).toBe(
      join(root, 'assets', 'a b.js'),
    )
  })

  it('keeps dot segments inside the root (the URL parser resolves them first)', () => {
    expect(resolveRendererFile(root, 'app://renderer/../main/index.js')).toBe(
      join(root, 'main', 'index.js'),
    )
    expect(resolveRendererFile(root, 'app://renderer/%2e%2e/%2e%2e/etc/passwd')).toBe(
      join(root, 'etc', 'passwd'),
    )
  })

  it.each([
    'app://renderer/..%2F..%2Fmain%2Findex.js',
    'app://renderer/%2E%2E%5C..%5Cmain',
    'app://other/index.html',
    'file:///etc/passwd',
    'app://renderer/%E0%A4%A',
    'app://renderer/a%00b',
  ])('refuses %s', (url) => {
    expect(resolveRendererFile(root, url)).toBeNull()
  })
})
