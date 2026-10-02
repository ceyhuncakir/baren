/**
 * Makes an editor session an agent host (contract §11.2): announces the file to main, runs the
 * requests main routes to it, applies main's agent presence for the file, and says goodbye on
 * dispose. Called by `openSession` for every session (visible windows and headless hosts).
 * Only listeners are registered here: the executors (`runtime.ts`, with `@baren/html`) load
 * on the first request, so nothing agent-related runs or downloads before an agent does.
 *
 * Browser mode: the mock bridge's in-page agent loop (`window.__barenAgent`) delivers
 * requests the same way, so Playwright drives these executors without Electron.
 */
import { bridge } from '../../lib/bridge'
import type { EditorSession } from '../../editor/session/context'
import type { AgentPresence, AgentRequest, AgentResponse } from '../../types/bridge'
import type { HostRuntime } from './runtime'

/** Presence updates are applied at most this often (contract §11.7). */
const PRESENCE_INTERVAL_MS = 100

export interface AgentHostHandle {
  /** The loaded runtime (tests); loads it when needed. */
  runtime(): Promise<HostRuntime>
  /** Run one request (as main would send it). */
  handle(req: AgentRequest): Promise<AgentResponse>
  dispose(): void
}

export function attachAgentHost(
  session: EditorSession,
  opts: { release?: () => Promise<void> } = {},
): AgentHostHandle {
  const agent = bridge.agent as typeof bridge.agent | undefined
  const fileId = session.fileId
  const headless = session.headless
  let disposed = false
  let loading: Promise<HostRuntime> | null = null
  let loaded: HostRuntime | null = null
  /** Cancels that arrived while the runtime was loading. */
  const cancelled = new Set<string>()

  const runtime = (): Promise<HostRuntime> => {
    loading ??= import('./runtime').then((m) => {
      const rt = m.createHostRuntime(session, opts)
      if (disposed) rt.dispose()
      else loaded = rt
      return rt
    })
    return loading
  }

  const handle = async (req: AgentRequest): Promise<AgentResponse> => {
    if (disposed) {
      return {
        id: req.id,
        ok: false,
        error: { code: 'host_unavailable', message: 'The file was closed.' },
      }
    }
    const rt = await runtime()
    const pending = rt.dispatcher.handle(req)
    if (cancelled.delete(req.id)) rt.dispatcher.cancel(req.id)
    return pending
  }

  // Presence: at most one store update per interval; the last update wins.
  let pendingPresence: AgentPresence[] | null = null
  let presenceTimer: ReturnType<typeof setTimeout> | null = null
  let lastPresence = 0
  const applyPresence = (agents: AgentPresence[]) => {
    pendingPresence = agents
    if (presenceTimer !== null) return
    const wait = Math.max(0, lastPresence + PRESENCE_INTERVAL_MS - Date.now())
    presenceTimer = setTimeout(() => {
      presenceTimer = null
      lastPresence = Date.now()
      const next = pendingPresence
      pendingPresence = null
      if (next) session.agents.setLocal(next)
    }, wait)
  }

  const offs: (() => void)[] = []
  if (agent) {
    try {
      agent.host({ fileId, state: 'opened', headless })
      offs.push(
        agent.onRequest((req) => {
          if (req.fileId !== fileId) return
          void handle(req).then((res) => agent.respond(res))
        }),
      )
      offs.push(
        agent.onCancel((id) => {
          if (loaded) loaded.dispatcher.cancel(id)
          else if (loading) cancelled.add(id)
        }),
      )
      offs.push(
        agent.onPresence((update) => {
          if (update.fileId === fileId) applyPresence(update.agents)
        }),
      )
    } catch (error) {
      console.warn('[agent] host registration failed', error)
    }
  }
  return {
    runtime,
    handle,
    dispose() {
      if (disposed) return
      disposed = true
      for (const off of offs) off()
      if (presenceTimer !== null) clearTimeout(presenceTimer)
      loaded?.dispose()
      try {
        agent?.host({ fileId, state: 'closed', headless })
      } catch {
        // The window is going away.
      }
    },
  }
}
