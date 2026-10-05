/**
 * Which renderer may use which IPC channel. Every window of the app's origin loads the same
 * preload, so the bridge alone does not tell them apart: main does.
 *
 * - `app`: the windows of `WindowManager` (the user's windows) use the whole bridge.
 * - `agent-host`: a hidden window main opens to host a file for MCP agents
 *   (`#/agent-host/<fileId>`) runs an editor session: it opens, saves and syncs files, stores
 *   assets and fonts and answers agent requests.
 * - `agent-render`: the off-screen render window (`#/agent-render`) lays out stages built from
 *   design content and answers render jobs: assets, fonts and its answers only.
 *
 * Neither hidden window can read the MCP token, start comment requests, change settings or the
 * account, open links or windows, or create, rename, archive or delete files. A sender that is
 * none of these (no known window) gets nothing.
 */
import type { WebContents } from 'electron'
import type { InvokeChannel, SendChannel, SyncChannel } from '../../preload/channels'

export type SenderKind = 'app' | 'agent-host' | 'agent-render'

type Channel = InvokeChannel | SendChannel | SyncChannel

/**
 * What every window uses on its own: the preload's startup timing and theme after a reload, and
 * the renderer entry's `installTheme` (main.tsx), which reads the theme preference.
 */
const EVERY_WINDOW: readonly Channel[] = [
  'startup:milestone',
  'theme:get-resolved',
  'theme:get-preference',
]

const ALLOWED: Record<Exclude<SenderKind, 'app'>, ReadonlySet<Channel>> = {
  'agent-host': new Set<Channel>([
    ...EVERY_WINDOW,
    'files:list',
    'files:open',
    'files:apply-update',
    'files:get-thumbnail',
    'files:set-thumbnail',
    // Opening a file signed in shares it with the current team (editor/collab/account.ts).
    'files:set-remote',
    'assets:put',
    'assets:get',
    'fonts:faces',
    // Live sync and the team's API (the user's server session).
    'auth:get-token',
    'app:version',
    'agent:response',
    'agent:host',
  ]),
  'agent-render': new Set<Channel>([
    ...EVERY_WINDOW,
    'assets:get',
    'fonts:faces',
    'agent:response',
  ]),
}

/** Whether a sender of `kind` (null: unknown) may use `channel`. */
export function allows(kind: SenderKind | null, channel: Channel): boolean {
  if (kind === 'app') return true
  return kind !== null && ALLOWED[kind].has(channel)
}

const hidden = new Map<number, Exclude<SenderKind, 'app'>>()

/** Mark a hidden window's webContents (before it loads); forgotten when it is destroyed. */
export function markHiddenSender(contents: WebContents, kind: Exclude<SenderKind, 'app'>): void {
  const id = contents.id
  hidden.set(id, kind)
  contents.once('destroyed', () => {
    if (hidden.get(id) === kind) hidden.delete(id)
  })
}

/** The kind of a hidden window main opened, if `webContentsId` is one. */
export function hiddenSenderKind(webContentsId: number): Exclude<SenderKind, 'app'> | null {
  return hidden.get(webContentsId) ?? null
}
