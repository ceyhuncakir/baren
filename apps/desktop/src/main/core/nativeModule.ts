/**
 * Locating the napi addon built from crates/napi (`napi build --platform`
 * names it `baren-core.<platform>-<arch>[-abi].node`).
 *
 * - dev:        <repo>/crates/napi/
 * - production: <resources>/app.asar.unpacked/native/ (electron-builder copies
 *               crates/napi/*.node to native/ and unpacks *.node from the asar)
 */
import { join, resolve } from 'node:path'

export const NATIVE_BINARY_NAME = 'baren-core'

/** napi-rs platform suffix for the targets listed in crates/napi/package.json. */
export function napiPlatformSuffix(platform: string, arch: string): string | null {
  switch (platform) {
    case 'linux':
      return arch === 'x64' || arch === 'arm64' ? `linux-${arch}-gnu` : null
    case 'darwin':
      return arch === 'x64' || arch === 'arm64' ? `darwin-${arch}` : null
    case 'win32':
      return arch === 'x64' || arch === 'arm64' ? `win32-${arch}-msvc` : null
    default:
      return null
  }
}

export interface NativeLocation {
  platform: string
  arch: string
  isPackaged: boolean
  /** `app.getAppPath()`: apps/desktop in dev, …/resources/app.asar when packaged. */
  appPath: string
  /** `process.resourcesPath`. */
  resourcesPath: string
  /** BAREN_NATIVE_PATH, if set: the only candidate. */
  override: string | null
}

/** Candidate `.node` paths, most specific first. */
export function nativeModuleCandidates(loc: NativeLocation): string[] {
  if (loc.override) return [resolve(loc.override)]
  const suffix = napiPlatformSuffix(loc.platform, loc.arch)
  const names = [
    ...(suffix ? [`${NATIVE_BINARY_NAME}.${suffix}.node`] : []),
    ...(loc.platform === 'darwin' ? [`${NATIVE_BINARY_NAME}.darwin-universal.node`] : []),
    // Windows installers built on Linux carry a MinGW build of the core (same N-API exports).
    ...(loc.platform === 'win32' ? [`${NATIVE_BINARY_NAME}.win32-${loc.arch}-gnu.node`] : []),
    `${NATIVE_BINARY_NAME}.node`,
  ]
  const dirs = loc.isPackaged
    ? [join(loc.resourcesPath, 'app.asar.unpacked', 'native'), join(loc.resourcesPath, 'native')]
    : [resolve(loc.appPath, '..', '..', 'crates', 'napi')]
  return dirs.flatMap((dir) => names.map((name) => join(dir, name)))
}
