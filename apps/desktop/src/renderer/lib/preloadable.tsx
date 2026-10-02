/**
 * Code-split screens without Suspense. React 19 throttles Suspense reveals (up to ~300 ms
 * after a fallback), which made the first sign-in screen and the first trip to a team page
 * visibly late. A preloadable renders nothing until its chunk arrives, and renders
 * synchronously once preload() has finished — so warming chunks on idle makes navigation
 * instant.
 */
import { useEffect, useState, type ComponentType } from 'react'

export interface Preloadable<P extends object> {
  Component: ComponentType<P>
  preload(): Promise<ComponentType<P>>
}

export function preloadable<P extends object>(
  load: () => Promise<ComponentType<P>>,
): Preloadable<P> {
  let loaded: ComponentType<P> | null = null
  let pending: Promise<ComponentType<P>> | null = null

  const preload = () => {
    pending ??= load().then(
      (component) => (loaded = component),
      (error: unknown) => {
        pending = null // let a later render retry (e.g. after a transient chunk error)
        throw error
      },
    )
    return pending
  }

  function Loader(props: P) {
    const [Loaded, setLoaded] = useState<ComponentType<P> | null>(() => loaded)
    useEffect(() => {
      if (Loaded) return
      let alive = true
      preload().then(
        (component) => alive && setLoaded(() => component),
        (error: unknown) => console.error('Failed to load screen', error),
      )
      return () => {
        alive = false
      }
    }, [Loaded])
    return Loaded ? <Loaded {...props} /> : null
  }

  return { Component: Loader, preload }
}

/** Runs `fn` when the main thread is idle (or soon, where idle callbacks are missing). */
export function whenIdle(fn: () => void): void {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(() => fn(), { timeout: 2000 })
  else setTimeout(fn, 200)
}
