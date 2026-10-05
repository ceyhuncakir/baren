/**
 * Version history for agents (`@baren/schema` versions): before an agent's first write to a
 * file after it has been idle there for AGENT_IDLE_MS, record "Before <agent>'s edits", so the
 * user can go back to the file as it was before the agent started. Nothing is recorded when the
 * design has not changed since the newest version (or the file is new and empty).
 *
 * Write times are remembered per document (one host per file). A host that reopened (headless
 * hosts close after 2 min idle) has forgotten them, so a checkpoint of this agent's in the last
 * AGENT_IDLE_MS also counts. A failed checkpoint never fails the agent's write.
 */
import { createVersion, getVersions, transact } from '@baren/schema'
import type { LoroDoc } from 'loro-crdt'
import { beforeAgentName, shouldCheckpointOnOpen } from '../editor/history/model'

export const AGENT_IDLE_MS = 10 * 60_000
export const AGENT_CHECKPOINT_ORIGIN = 'version:agent'

const lastWrites = new WeakMap<LoroDoc, Map<string, number>>()

/** Call before an agent's write; returns the new version's id, or null when none was needed. */
export function checkpointBeforeAgentWrite(
  doc: LoroDoc,
  agentName: string,
  now: number = Date.now(),
): string | null {
  let writes = lastWrites.get(doc)
  if (!writes) {
    writes = new Map()
    lastWrites.set(doc, writes)
  }
  const last = writes.get(agentName)
  writes.set(agentName, now)
  if (last !== undefined && now - last < AGENT_IDLE_MS) return null
  try {
    const recent = getVersions(doc).some(
      (v) =>
        v.reason === 'agent' && v.author.name === agentName && now - v.createdAt < AGENT_IDLE_MS,
    )
    if (recent || !shouldCheckpointOnOpen(doc)) return null
    return transact(
      doc,
      () =>
        createVersion(doc, {
          name: beforeAgentName(agentName),
          author: { id: `agent:${agentName}`, name: agentName, kind: 'agent' },
          auto: true,
          reason: 'agent',
          now,
        }),
      { origin: AGENT_CHECKPOINT_ORIGIN },
    )
  } catch (error) {
    console.warn('[history] agent checkpoint failed', error)
    return null
  }
}
