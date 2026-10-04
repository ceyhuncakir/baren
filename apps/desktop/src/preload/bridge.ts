/**
 * Builds the complete `BarenBridge` (ARCHITECTURE.md, "Desktop bridge") on
 * top of typed IPC. Pure apart from the injected IPC, so it is unit-tested in Node.
 */
import type { BarenBridge, Platform, ResolvedTheme } from '../renderer/types/bridge'
import type { EventChannels } from './channels'
import type { TypedIpc } from './ipc'

type Listener<T> = (value: T) => void

function assertFunction(cb: unknown, name: string): asserts cb is (...args: never[]) => unknown {
  if (typeof cb !== 'function') throw new TypeError(`${name} expects a callback function`)
}

/** Invoke every listener; one throwing listener must not starve the others. */
function dispatch<T>(listeners: Iterable<Listener<T>>, value: T): void {
  for (const listener of [...listeners]) {
    try {
      listener(value)
    } catch (error) {
      console.error('[baren] listener failed', error)
    }
  }
}

/**
 * One IPC listener per event channel, shared by every renderer subscriber (no listener
 * build-up on `ipcRenderer`); attached on the first subscription, removed with the last.
 */
function fanOut<K extends keyof EventChannels>(
  ipc: TypedIpc,
  channel: K,
  name: string,
): (cb: Listener<EventChannels[K][0]>) => () => void {
  type T = EventChannels[K][0]
  const listeners = new Set<Listener<T>>()
  let stop: (() => void) | null = null
  return (cb) => {
    assertFunction(cb, name)
    const listener: Listener<T> = (value) => cb(value)
    listeners.add(listener)
    stop ??= ipc.on(channel, ((value: T) => dispatch(listeners, value)) as never)
    let active = true
    return () => {
      if (!active) return
      active = false
      listeners.delete(listener)
      if (listeners.size === 0 && stop !== null) {
        stop()
        stop = null
      }
    }
  }
}

export function createBridge(
  ipc: TypedIpc,
  platform: Platform,
  initialTheme: ResolvedTheme = 'light',
): BarenBridge {
  // Deep links: one IPC subscription shared by all renderer listeners. Main
  // queues links until the first listener subscribes (cold start, reloads).
  const deepLinkListeners = new Set<Listener<string>>()
  let stopDeepLinks: (() => void) | null = null

  // The latest resolved theme seen since this page loaded. A change that lands between window
  // creation and the renderer's first `theme.onChange` is replayed to new subscribers.
  let latestTheme: ResolvedTheme = initialTheme
  ipc.on('theme:changed', (resolved) => {
    latestTheme = resolved
  })
  const subscribeTheme = fanOut(ipc, 'theme:changed', 'theme.onChange')
  const subscribeUpdates = fanOut(ipc, 'updates:status', 'updates.onStatus')
  const subscribeFilesChanged = fanOut(ipc, 'files:changed', 'files.onChanged')
  const subscribeMcpStatus = fanOut(ipc, 'mcp:status', 'mcp.onStatus')
  const subscribeAgentRequests = fanOut(ipc, 'agent:request', 'agent.onRequest')
  const subscribeAgentCancels = fanOut(ipc, 'agent:cancel', 'agent.onCancel')
  const subscribeAgentPresence = fanOut(ipc, 'agent:presence', 'agent.onPresence')

  return {
    window: {
      minimize: () => ipc.send('window:minimize'),
      toggleMaximize: () => ipc.send('window:toggle-maximize'),
      close: () => ipc.send('window:close'),
      isMaximized: () => ipc.invoke('window:is-maximized'),
      onMaximizedChange(cb) {
        assertFunction(cb, 'window.onMaximizedChange')
        return ipc.on('window:maximized-changed', (maximized) => cb(maximized))
      },
    },

    files: {
      list: () => ipc.invoke('files:list'),
      create: (name) => ipc.invoke('files:create', name),
      rename: (id, name) => ipc.invoke('files:rename', id, name),
      archive: (id, archived) => ipc.invoke('files:archive', id, archived),
      remove: (id) => ipc.invoke('files:remove', id),
      open: (id) => ipc.invoke('files:open', id),
      applyUpdate: (id, update) => ipc.invoke('files:apply-update', id, update),
      setThumbnail: (id, png) => ipc.invoke('files:set-thumbnail', id, png),
      getThumbnail: (id) => ipc.invoke('files:get-thumbnail', id),
      import: (snapshot, name) => ipc.invoke('files:import', snapshot, name ?? null),
      setRemote: (id, teamId, remoteId) =>
        ipc.invoke('files:set-remote', id, teamId ?? null, remoteId ?? null),
      onChanged(cb) {
        assertFunction(cb, 'files.onChanged')
        return subscribeFilesChanged(() => cb())
      },
    },

    assets: {
      put: (bytes, mime) => ipc.invoke('assets:put', bytes, mime),
      get: (hash) => ipc.invoke('assets:get', hash),
    },

    fonts: {
      faces: (family) => ipc.invoke('fonts:faces', family),
    },

    export: {
      html: (fileId, nodeId) => ipc.invoke('export:html', fileId, nodeId),
      json: (fileId) => ipc.invoke('export:json', fileId),
    },

    auth: {
      getToken: () => ipc.invoke('auth:get-token'),
      setToken: (token) => ipc.invoke('auth:set-token', token),
    },

    shell: {
      openExternal: (url) => ipc.invoke('shell:open-external', url),
    },

    onDeepLink(cb) {
      assertFunction(cb, 'onDeepLink')
      // Wrap so registering the same function twice yields two independent subscriptions.
      const listener: Listener<string> = (url) => cb(url)
      deepLinkListeners.add(listener)
      if (stopDeepLinks === null) {
        stopDeepLinks = ipc.on('deeplink:open', (url) => dispatch(deepLinkListeners, url))
        // Sent after the listener is attached, so links flushed in response are not missed.
        ipc.send('deeplink:subscribe')
      }
      let active = true
      return () => {
        if (!active) return
        active = false
        deepLinkListeners.delete(listener)
        if (deepLinkListeners.size === 0 && stopDeepLinks !== null) {
          stopDeepLinks()
          stopDeepLinks = null
          ipc.send('deeplink:unsubscribe')
        }
      }
    },

    app: {
      newWindow: () => ipc.send('app:new-window'),
      quit: () => ipc.send('app:quit'),
      reload: () => ipc.send('app:reload'),
      forceReload: () => ipc.send('app:force-reload'),
      toggleDevTools: () => ipc.send('app:toggle-dev-tools'),
      toggleFullScreen: () => ipc.send('app:toggle-full-screen'),
      checkForUpdates: () => ipc.invoke('app:check-for-updates'),
      version: () => ipc.invoke('app:version'),
    },

    theme: {
      initial: initialTheme,
      preference: () => ipc.invoke('theme:get-preference'),
      setPreference: (preference) => ipc.invoke('theme:set-preference', preference),
      onChange(cb) {
        const off = subscribeTheme(cb)
        let live = true
        if (latestTheme !== initialTheme) {
          const missed = latestTheme
          queueMicrotask(() => {
            if (live) dispatch([cb], missed)
          })
        }
        return () => {
          live = false
          off()
        }
      },
    },

    updates: {
      status: () => ipc.invoke('updates:status'),
      check: () => ipc.invoke('updates:check'),
      install: () => ipc.send('updates:install'),
      onStatus: (cb) => subscribeUpdates(cb),
    },

    clipboard: {
      write: (content) => ipc.invoke('clipboard:write', content),
      read: () => ipc.invoke('clipboard:read'),
    },

    mcp: {
      status: () => ipc.invoke('mcp:status'),
      onStatus: (cb) => subscribeMcpStatus(cb),
      setEnabled: (enabled) => ipc.invoke('mcp:set-enabled', enabled),
      setup: () => ipc.invoke('mcp:setup'),
      resetToken: () => ipc.invoke('mcp:reset-token'),
    },

    agent: {
      onRequest: (cb) => subscribeAgentRequests(cb),
      respond: (res) => ipc.send('agent:response', res),
      onCancel: (cb) => subscribeAgentCancels(cb),
      onPresence: (cb) => subscribeAgentPresence(cb),
      host: (state) => ipc.send('agent:host', state),
    },

    platform,
  }
}

export function toPlatform(value: string): Platform {
  return value === 'darwin' || value === 'win32' ? value : 'linux'
}
