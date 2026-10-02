/**
 * Privileged custom schemes. `protocol.registerSchemesAsPrivileged` may only be called once,
 * before `app.ready`, so every scheme is registered here together.
 */
import { protocol } from 'electron'
import { ASSET_SCHEME_PRIVILEGES } from './assetProtocol'
import { RENDERER_SCHEME_PRIVILEGES } from './rendererProtocol'

export function registerPrivilegedSchemes(): void {
  protocol.registerSchemesAsPrivileged([RENDERER_SCHEME_PRIVILEGES, ASSET_SCHEME_PRIVILEGES])
}
