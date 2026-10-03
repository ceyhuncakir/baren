/**
 * File links (`baren://file/<id>[/<page id>][?node=<layer id>]`): find the local file they
 * name — by its local id (the `url` in MCP results) or its team file's server id ("Copy link",
 * via the server's /f/<id> page), pulling the user's team files first when this machine does not
 * have it yet — and show the linked page or layer once the editor is open.
 */
import type { Team } from '@baren/sync-client/api'
import type { BarenBridge } from '../types/bridge'
import { pullTeamFilesOnce, type TeamFilesDeps } from './teamFiles'

/** The local file `id` names on this machine (its own id, else its team file's id), or null. */
export async function linkedLocalFile(
  id: string,
  files: Pick<BarenBridge['files'], 'list'>,
): Promise<string | null> {
  const list = await files.list()
  return (list.find((f) => f.id === id) ?? list.find((f) => f.remoteId === id))?.id ?? null
}

/** `linkedLocalFile`, else the local copy of the team file `id` once pulled from `teams`. */
export async function localFileFor(
  id: string,
  teams: readonly Pick<Team, 'id'>[],
  deps: TeamFilesDeps,
): Promise<string | null> {
  const find = () => linkedLocalFile(id, deps.files)
  const found = await find()
  if (found || teams.length === 0) return found
  // A pull that was already running may have listed the team files before this one existed.
  for (let attempt = 0; attempt < 2; attempt++) {
    await pullTeamFilesOnce(teams, deps)
    const local = await find()
    if (local) return local
  }
  return null
}

/** Shows a page (switching to it) or a layer (on its page) in the open editor. */
type Reveal = (nodeId: string) => void

const listeners = new Map<string, Reveal>()
let pending: { fileId: string; nodeId: string } | null = null

/** Show `nodeId` in `fileId`'s editor: now if it is open, else as soon as it opens. */
export function requestReveal(fileId: string, nodeId: string): void {
  const listener = listeners.get(fileId)
  if (listener) listener(nodeId)
  else pending = { fileId, nodeId }
}

/** The open editor of `fileId` takes layer links (a pending one at once). */
export function onReveal(fileId: string, listener: Reveal): () => void {
  listeners.set(fileId, listener)
  if (pending?.fileId === fileId) {
    const { nodeId } = pending
    pending = null
    listener(nodeId)
  }
  return () => {
    if (listeners.get(fileId) === listener) listeners.delete(fileId)
  }
}
