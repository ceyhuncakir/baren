import type { RuntimeFlags } from './flags'

export interface ChromiumSwitch {
  name: string
  value?: string
}

/**
 * Chromium command-line switches, applied before `app.ready`.
 *
 * - `enable-gpu-rasterization`: raster tiles on the GPU even where Chromium's
 *   heuristics would keep them on the CPU. The canvas is a large, paint-heavy
 *   DOM tree whose transforms change every frame during pan/zoom.
 * - `ignore-gpu-blocklist` is opt-in only: forcing GPU paths on blocklisted
 *   drivers trades crashes for speed.
 * - Smoke runs use the basic password store so safeStorage never blocks on a
 *   keyring unlock prompt in CI.
 */
export function chromiumSwitches(
  flags: Pick<RuntimeFlags, 'smoke' | 'disableGpu' | 'ignoreGpuBlocklist'>,
): ChromiumSwitch[] {
  const switches: ChromiumSwitch[] = []
  if (!flags.disableGpu) {
    switches.push({ name: 'enable-gpu-rasterization' })
    if (flags.ignoreGpuBlocklist) switches.push({ name: 'ignore-gpu-blocklist' })
  }
  if (flags.smoke) switches.push({ name: 'password-store', value: 'basic' })
  return switches
}
