import { describe, expect, it } from 'vitest'
import type { AgentRun } from '../types/bridge'
import { canRunAgent, isRunning, latestRun } from './agentRuns'

const run = (over: Partial<AgentRun>): AgentRun => ({
  id: 'r',
  fileId: 'f1',
  threadId: 't1',
  messageId: 'm',
  state: 'working',
  activity: null,
  error: null,
  startedAt: 0,
  endedAt: null,
  ...over,
})

describe('comment request runs (UI state)', () => {
  it("picks a thread's latest run", () => {
    const runs = {
      a: run({ id: 'a', startedAt: 1, state: 'failed' }),
      b: run({ id: 'b', startedAt: 5, state: 'working' }),
      c: run({ id: 'c', startedAt: 9, threadId: 't2' }),
      d: run({ id: 'd', startedAt: 20, fileId: 'f2' }),
    }
    expect(latestRun(runs, 'f1', 't1')?.id).toBe('b')
    expect(latestRun(runs, 'f1', 'nope')).toBeNull()
  })

  it('knows when a run is going and when runs are possible', () => {
    expect(isRunning(run({ state: 'starting' }))).toBe(true)
    expect(isRunning(run({ state: 'done' }))).toBe(false)
    expect(isRunning(null)).toBe(false)
    expect(canRunAgent({ enabled: true, claudePath: '/bin/claude' })).toBe(true)
    expect(canRunAgent({ enabled: false, claudePath: '/bin/claude' })).toBe(false)
    expect(canRunAgent({ enabled: true, claudePath: null })).toBe(false)
    expect(canRunAgent(null)).toBe(false)
  })
})
