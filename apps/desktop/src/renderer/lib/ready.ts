/**
 * Cold-start signal for desktop-shell: dispatched once, when the first screen is
 * interactive (Recents with its real file list, or the sign-in form). The preload forwards
 * it to main as the startup milestone measured by BAREN_SMOKE.
 *
 * Called from a passive effect, i.e. after React committed the screen. No requestAnimationFrame:
 * hidden windows (smoke runs) throttle frames and would inflate the number by ~1 s.
 */
let signalled = false

export function signalAppReady(): void {
  if (signalled || typeof window === 'undefined') return
  signalled = true
  window.dispatchEvent(new Event('baren:ready'))
}
