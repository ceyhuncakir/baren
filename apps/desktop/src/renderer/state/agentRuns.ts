/**
 * Comment requests to Claude Code as the UI sees them (`main/agentRuns`): whether runs are
 * possible (Preferences, mention suggestions) and the runs of this app session (thread cards,
 * pins). One subscription per window, started by the first component that needs it.
 */
import { useEffect } from 'react'
import { create } from 'zustand'
import { bridge } from '../lib/bridge'
import type { AgentRun, AgentRunnerStatus } from '../types/bridge'

export interface AgentRunsUiState {
  /** null until the first status arrives (or when the bridge could not answer). */
  status: AgentRunnerStatus | null
  /** Runs by id. */
  runs: Record<string, AgentRun>
  switching: boolean
  setEnabled(enabled: boolean): Promise<void>
}

export const useAgentRuns = create<AgentRunsUiState>()((set, get) => ({
  status: null,
  runs: {},
  switching: false,
  async setEnabled(enabled) {
    if (get().switching) return
    set({ switching: true })
    try {
      set({ status: await bridge.agentRuns.setEnabled(enabled) })
    } finally {
      set({ switching: false })
    }
  },
}))

/** Merge a run update (main pushes every state change). */
export function receiveRun(run: AgentRun): void {
  useAgentRuns.setState((s) => ({ runs: { ...s.runs, [run.id]: run } }))
}

let started = false

/** Subscribes once per window (idempotent); `refresh` asks for the status again. */
export function startAgentRuns(refresh = false): void {
  if (started && !refresh) return
  const first = !started
  started = true
  try {
    if (first) {
      bridge.agentRuns.onUpdate(receiveRun)
      void bridge.agentRuns
        .list()
        .then((runs) => runs.forEach(receiveRun))
        .catch(() => undefined)
    }
    void bridge.agentRuns
      .status()
      .then((status) => useAgentRuns.setState({ status }))
      .catch(() => undefined)
  } catch {
    // A bridge without agent runs (old preload): the feature stays hidden.
  }
}

/** The runner status, subscribing on first use. */
export function useAgentRunnerStatus(): AgentRunnerStatus | null {
  useEffect(() => startAgentRuns(), [])
  return useAgentRuns((s) => s.status)
}

/** Comment requests can run: on in Preferences and `claude` found. */
export function canRunAgent(status: AgentRunnerStatus | null): boolean {
  return status !== null && status.enabled && status.claudePath !== null
}

/** A thread's latest run (any state), or null. */
export function latestRun(
  runs: Record<string, AgentRun>,
  fileId: string,
  threadId: string,
): AgentRun | null {
  let best: AgentRun | null = null
  for (const run of Object.values(runs)) {
    if (run.fileId !== fileId || run.threadId !== threadId) continue
    if (best === null || run.startedAt > best.startedAt) best = run
  }
  return best
}

/** True while a run is starting or working. */
export function isRunning(run: AgentRun | null): boolean {
  return run !== null && (run.state === 'starting' || run.state === 'working')
}

export function useThreadRun(fileId: string, threadId: string): AgentRun | null {
  useEffect(() => startAgentRuns(), [])
  return useAgentRuns((s) => latestRun(s.runs, fileId, threadId))
}
