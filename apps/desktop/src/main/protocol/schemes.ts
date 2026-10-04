/**
 * Privileged custom schemes. `protocol.registerSchemesAsPrivileged` may only be called once,
 * before `app.ready`, so every scheme is registered here together.
 */
import { protocol } from 'electron'
import { ASSET_SCHEME_PRIVILEGES } from './assetProtocol'
import { FONT_SCHEME_PRIVILEGES } from './fontProtocol'
import { RENDERER_SCHEME_PRIVILEGES } from './rendererProtocol'

export function registerPrivilegedSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    RENDERER_SCHEME_PRIVILEGES,
    ASSET_SCHEME_PRIVILEGES,
    FONT_SCHEME_PRIVILEGES,
  ])
}
