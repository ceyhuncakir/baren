/**
 * What the server offers for sign-in help (`GET /api/auth/providers`). Accounts are email +
 * password only; `email` says whether codes and invites are really emailed (SMTP) or only
 * written to the server log, which changes the copy ("check your email" vs "ask the server
 * admin for your code"). Fetched once per window and cached; a failed request is retried on
 * the next call.
 */
import { useEffect, useSyncExternalStore } from 'react'
import { api } from './api'

/** null = not known yet (request in flight, or the server is unreachable). */
let emailDelivery: boolean | null = null
let pending: Promise<boolean | null> | null = null
const listeners = new Set<() => void>()

/** Ask the server (once); resolves with the cached answer afterwards. */
export function loadProviders(): Promise<boolean | null> {
  if (emailDelivery !== null) return Promise.resolve(emailDelivery)
  if (pending) return pending
  pending = api
    .providers()
    .then((res) => {
      emailDelivery = res.email === true
      for (const cb of [...listeners]) cb()
      return emailDelivery
    })
    .catch(() => null)
    .finally(() => {
      pending = null
    })
  return pending
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

const snapshot = () => emailDelivery

/**
 * Whether the server emails codes and invites. `null` while unknown; screens show the
 * email copy (the designed one) until the server says otherwise.
 */
export function useEmailDelivery(): boolean | null {
  const value = useSyncExternalStore(subscribe, snapshot, snapshot)
  useEffect(() => {
    if (value === null) void loadProviders()
  }, [value])
  return value
}

/** True unless the server said it has no email delivery. */
export function useSendsEmail(): boolean {
  return useEmailDelivery() !== false
}

/** Test hook: forget the cached answer. */
export function resetProvidersForTests(): void {
  emailDelivery = null
  pending = null
}
