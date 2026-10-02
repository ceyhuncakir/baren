/**
 * Runtime switches read from the environment before `app.ready`.
 *
 * BAREN_SMOKE=1               hidden window, print startup timings as JSON on stdout, quit
 * BAREN_SMOKE_TIMEOUT_MS      give up (exit 1) after this long (default 20000)
 * BAREN_SMOKE_READY_GRACE_MS  after first paint, wait this long for `baren:ready` (default 1500)
 * BAREN_USER_DATA_DIR         override app.getPath('userData') (tests, smoke, portable runs)
 * BAREN_CORE=auto|native|js   backend selection (default auto: native, else JS fallback)
 * BAREN_NATIVE_PATH           explicit path to the napi `.node` file
 * BAREN_DISABLE_GPU=1         disable hardware acceleration (broken drivers, VMs)
 * BAREN_IGNORE_GPU_BLOCKLIST=1  force GPU paths on blocklisted drivers
 * BAREN_REGISTER_PROTOCOL=1   register baren:// in dev builds too (packaged builds always do)
 * BAREN_FORCE_UPDATES=1       run auto-update in dev builds and smoke runs too
 * BAREN_UPDATE_URL            override the build-time update feed URL (staging, tests)
 * BAREN_SMOKE_UPDATES=<state> smoke runs also check for updates right away and wait (up to
 *                                BAREN_SMOKE_TIMEOUT_MS) for the check/download to settle; the
 *                                run passes only if it ends in <state> (`1` = ready). Never installs.
 * BAREN_SMOKE_INSTALL=1       test only: when that smoke update check ended in `ready`, quit and
 *                                install it (replaces $APPIMAGE) instead of exiting; the relaunched
 *                                version inherits the environment, so it runs hidden too.
 *
 * MCP server (Phase 4, docs/phase4/contract.md §3.4):
 * BAREN_MCP=0|1               force the MCP server off/on for this run (default: the saved
 *                                `enabled` setting; smoke runs: off unless BAREN_MCP=1)
 * BAREN_MCP_PORT=<n>          port for this run (`0` = ephemeral), never persisted
 * BAREN_MCP_ALLOWED_ORIGINS=<a,b>  extra allowed `Origin` values (debugging with the MCP Inspector)
 * BAREN_EXPORT_DIR=<dir>      where the `export` tool writes (default <Downloads>/Baren)
 * BAREN_MCP_TOOL_TIMEOUT_MS=<n>  override every tool deadline (tests)
 */
import type { UpdateState } from '../../renderer/types/bridge'

export type CoreMode = 'auto' | 'native' | 'js'

export interface RuntimeFlags {
  smoke: boolean
  smokeTimeoutMs: number
  smokeReadyGraceMs: number
  userDataDir: string | null
  coreMode: CoreMode
  nativeModulePath: string | null
  disableGpu: boolean
  ignoreGpuBlocklist: boolean
  registerProtocolInDev: boolean
  forceUpdates: boolean
  updateUrl: string | null
  /** The update state a smoke run must end in, or null to skip the update check. */
  smokeUpdates: UpdateState | null
  smokeInstall: boolean
  /** BAREN_MCP: `true`/`false` forces the MCP server on/off; `null` = the saved setting. */
  mcp: boolean | null
  /** BAREN_MCP_PORT: this run's port (0 = ephemeral), or null for the saved port. */
  mcpPort: number | null
  /** BAREN_MCP_ALLOWED_ORIGINS, split on commas. */
  mcpAllowedOrigins: string[]
  /** BAREN_EXPORT_DIR. */
  exportDir: string | null
  /** BAREN_MCP_TOOL_TIMEOUT_MS: one deadline for every tool (tests). */
  mcpToolTimeoutMs: number | null
}

export type Env = Readonly<Record<string, string | undefined>>

export function isTruthy(value: string | undefined): boolean {
  if (value === undefined) return false
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const n = Number(value)
  return Number.isInteger(n) && n >= 0 ? n : fallback
}

function coreMode(value: string | undefined): CoreMode {
  const v = value?.trim().toLowerCase()
  return v === 'native' || v === 'js' ? v : 'auto'
}

function tristate(value: string | undefined): boolean | null {
  const v = value?.trim().toLowerCase()
  if (!v) return null
  if (isTruthy(v)) return true
  return ['0', 'false', 'no', 'off'].includes(v) ? false : null
}

function port(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null
  const n = Number(value)
  return Number.isInteger(n) && n >= 0 && n <= 65_535 ? n : null
}

function positiveIntOrNull(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : null
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0)
}

const SMOKE_UPDATE_STATES: readonly UpdateState[] = ['ready', 'none', 'error', 'disabled']

function smokeUpdates(value: string | undefined): UpdateState | null {
  const v = value?.trim().toLowerCase()
  if (!v || v === '0' || v === 'false' || v === 'off' || v === 'no') return null
  if (isTruthy(v)) return 'ready'
  return (SMOKE_UPDATE_STATES as readonly string[]).includes(v) ? (v as UpdateState) : null
}

export function parseRuntimeFlags(env: Env): RuntimeFlags {
  return {
    smoke: isTruthy(env['BAREN_SMOKE']),
    smokeTimeoutMs: positiveInt(env['BAREN_SMOKE_TIMEOUT_MS'], 20_000),
    smokeReadyGraceMs: positiveInt(env['BAREN_SMOKE_READY_GRACE_MS'], 1_500),
    userDataDir: nonEmpty(env['BAREN_USER_DATA_DIR']),
    coreMode: coreMode(env['BAREN_CORE']),
    nativeModulePath: nonEmpty(env['BAREN_NATIVE_PATH']),
    disableGpu: isTruthy(env['BAREN_DISABLE_GPU']),
    ignoreGpuBlocklist: isTruthy(env['BAREN_IGNORE_GPU_BLOCKLIST']),
    registerProtocolInDev: isTruthy(env['BAREN_REGISTER_PROTOCOL']),
    forceUpdates: isTruthy(env['BAREN_FORCE_UPDATES']),
    updateUrl: nonEmpty(env['BAREN_UPDATE_URL']),
    smokeUpdates: smokeUpdates(env['BAREN_SMOKE_UPDATES']),
    smokeInstall: isTruthy(env['BAREN_SMOKE_INSTALL']),
    mcp: tristate(env['BAREN_MCP']),
    mcpPort: port(env['BAREN_MCP_PORT']),
    mcpAllowedOrigins: list(env['BAREN_MCP_ALLOWED_ORIGINS']),
    exportDir: nonEmpty(env['BAREN_EXPORT_DIR']),
    mcpToolTimeoutMs: positiveIntOrNull(env['BAREN_MCP_TOOL_TIMEOUT_MS']),
  }
}
