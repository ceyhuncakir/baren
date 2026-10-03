/**
 * Files go into the signed-in user's current team on their own, so teammates see them
 * (teamFiles.ts pulls them on the other side). The editor shares a file when it opens it, so
 * new files go up right away; Home uploads the remaining local files in the background. The
 * Scratchpad and archived files stay on this machine, and viewers (who may not add files to
 * the team) share nothing.
 */
import type { ApiClient, Team } from '@baren/sync-client/api'
import type { BarenBridge, FileMeta } from '../types/bridge'
import { findScratchpad } from './fileViews'

/** The team files go to: the current team, unless the user may only view it. */
export function autoShareTeam(teams: readonly Team[], currentTeamId: string | null): Team | null {
  const team = teams.find((t) => t.id === currentTeamId) ?? null
  return team && team.role !== 'viewer' ? team : null
}

/** Local files that should be uploaded: not shared yet, not archived, not the Scratchpad. */
export function filesToShare(files: readonly FileMeta[], scratchpadId: string | null): FileMeta[] {
  const pad = findScratchpad(files, scratchpadId)
  return files.filter((f) => !f.remoteId && !f.archived && f.id !== pad?.id)
}

export interface Shared {
  teamId: string
  remoteId: string
}

const inflight = new Map<string, Promise<Shared>>()
const done = new Map<string, Shared>()

/**
 * Run `upload` for a local file unless it already ran or is running: the editor and Home may
 * both try to share the same file, and a second upload would make a duplicate team file.
 */
export function shareOnce(fileId: string, upload: () => Promise<Shared>): Promise<Shared> {
  const shared = done.get(fileId)
  if (shared) return Promise.resolve(shared)
  let pending = inflight.get(fileId)
  if (!pending) {
    pending = upload()
      .then((result) => {
        done.set(fileId, result)
        return result
      })
      .finally(() => inflight.delete(fileId))
    inflight.set(fileId, pending)
  }
  return pending
}

export interface ShareLocalDeps {
  api: Pick<ApiClient, 'files'>
  files: Pick<BarenBridge['files'], 'list' | 'open' | 'setRemote'>
  /** Upload the images a file's snapshot uses to its new server file. */
  uploadAssets(remoteId: string, snapshot: Uint8Array): Promise<void>
}

export interface ShareLocalResult {
  /** Local files uploaded to the team. */
  shared: number
  /** Files that could not be uploaded (they are retried on the next pass). */
  failed: number
}

/** Upload every local file that should be in `teamId`, one at a time. */
export async function shareLocalFiles(
  teamId: string,
  scratchpadId: string | null,
  deps: ShareLocalDeps,
): Promise<ShareLocalResult> {
  const pending = filesToShare(await deps.files.list(), scratchpadId)
  let shared = 0
  let failed = 0
  for (const file of pending) {
    try {
      await shareOnce(file.id, async () => {
        // Another window may have shared it since the list was read.
        const fresh = (await deps.files.list()).find((f) => f.id === file.id)
        if (fresh?.remoteId && fresh.teamId)
          return { teamId: fresh.teamId, remoteId: fresh.remoteId }
        const snapshot = await deps.files.open(file.id)
        const remote = await deps.api.files.create(teamId, { name: file.name, snapshot })
        await deps.files.setRemote(file.id, teamId, remote.id)
        // The file is shared either way; images the server lacks are reconciled again when
        // the file is opened (useCollaboration).
        await deps.uploadAssets(remote.id, snapshot).catch(() => undefined)
        shared++
        return { teamId, remoteId: remote.id }
      })
    } catch {
      failed++
    }
  }
  return { shared, failed }
}

let pass: Promise<ShareLocalResult> | null = null

/** `shareLocalFiles` with at most one pass running at a time (it runs on a timer). */
export function shareLocalFilesOnce(
  teamId: string,
  scratchpadId: string | null,
  deps: ShareLocalDeps,
): Promise<ShareLocalResult> {
  pass ??= shareLocalFiles(teamId, scratchpadId, deps).finally(() => {
    pass = null
  })
  return pass
}
