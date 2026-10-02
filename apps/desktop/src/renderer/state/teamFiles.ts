/**
 * Team files → local files. A file shared to a team lives on the server; each member keeps a
 * local copy (the Rust core) linked to it through `FileMeta.remoteId`, and the editor syncs
 * that copy live while it is open. This pulls the team files a member does not have yet:
 * download the snapshot → `bridge.files.import` (same Loro history as the server, so live
 * sync only exchanges what is new) → `bridge.files.setRemote`.
 */
import type { ApiClient, Team } from '@baren/sync-client/api'
import type { FileMeta, BarenBridge } from '../types/bridge'

export interface TeamFilesDeps {
  api: Pick<ApiClient, 'files'>
  files: Pick<BarenBridge['files'], 'list' | 'import' | 'setRemote'>
}

export interface PullResult {
  /** Local files created for team files that were missing. */
  added: FileMeta[]
  /** Team files that could not be pulled (they are retried on the next pull). */
  failed: number
}

/** Pull every non-archived team file that has no local copy yet. */
export async function pullTeamFiles(
  teams: readonly Pick<Team, 'id'>[],
  deps: TeamFilesDeps,
): Promise<PullResult> {
  const local = await deps.files.list()
  const known = new Set(local.flatMap((f) => (f.remoteId ? [f.remoteId] : [])))
  const added: FileMeta[] = []
  let failed = 0
  for (const team of teams) {
    let remote
    try {
      remote = await deps.api.files.list(team.id)
    } catch {
      failed++
      continue
    }
    for (const file of remote) {
      if (file.archived || known.has(file.id)) continue
      try {
        const snapshot = await deps.api.files.snapshot(file.id)
        // `null` keeps the document's own name, so importing writes no op of our own.
        const meta = await deps.files.import(snapshot, null)
        await deps.files.setRemote(meta.id, team.id, file.id)
        known.add(file.id)
        added.push({ ...meta, teamId: team.id, remoteId: file.id })
      } catch {
        failed++
      }
    }
  }
  return { added, failed }
}

let inflight: Promise<PullResult> | null = null

/** `pullTeamFiles` with at most one pull running at a time (screens mount often). */
export function pullTeamFilesOnce(
  teams: readonly Pick<Team, 'id'>[],
  deps: TeamFilesDeps,
): Promise<PullResult> {
  inflight ??= pullTeamFiles(teams, deps).finally(() => {
    inflight = null
  })
  return inflight
}
