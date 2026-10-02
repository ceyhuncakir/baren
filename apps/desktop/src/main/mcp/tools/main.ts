/**
 * Tools that main answers itself (contract §6.1, §6.3–§6.5, §6.29): the guide, the file list,
 * creating and opening files, and releasing working indicators.
 */
import { ToolError, okResult, type ToolResult } from '../format'
import { GUIDE_TOPICS } from '../guide'
import { fileUrl, type SessionRef, type ToolRuntime } from './context'
import type { ToolArgs } from './schemas'

export function getGuide(rt: ToolRuntime, args: ToolArgs<'get_guide'>): ToolResult {
  const text = rt.env.guide.topic(args.topic)
  if (text === null) {
    throw new ToolError(
      'invalid_argument',
      `Unknown topic "${args.topic.slice(0, 60)}". Topics: ${GUIDE_TOPICS.join(', ')}`,
    )
  }
  return okResult(null, text)
}

export async function listFiles(
  rt: ToolRuntime,
  args: ToolArgs<'list_files'>,
): Promise<ToolResult> {
  const files = (await rt.listFiles(0)).filter((f) => !f.archived)
  const open = rt.env.hosts.visibleFileIds()
  const openRank = new Map(open.map((id, i) => [id, i]))
  const sorted = [...files].sort((a, b) => {
    const ra = openRank.get(a.id)
    const rb = openRank.get(b.id)
    if (ra !== undefined || rb !== undefined) {
      if (ra === undefined) return 1
      if (rb === undefined) return -1
      return ra - rb
    }
    return b.updatedAt - a.updatedAt
  })
  const limit = args.limit ?? 50
  const out = sorted.slice(0, limit).map((f) => ({
    id: f.id,
    name: f.name,
    createdAt: new Date(f.createdAt).toISOString(),
    updatedAt: new Date(f.updatedAt).toISOString(),
    isOpen: openRank.has(f.id),
    isShared: f.teamId !== null || f.remoteId !== null,
    url: fileUrl(f.id),
  }))
  return okResult(null, { files: out, count: out.length })
}

export async function createFile(
  rt: ToolRuntime,
  session: SessionRef,
  args: ToolArgs<'create_file'>,
  signal: AbortSignal,
): Promise<ToolResult> {
  const core = await rt.env.core()
  let meta
  if (args.cloneFileId === undefined || args.cloneFileId.trim() === '') {
    meta = await core.createFile(args.name?.trim() || 'Untitled')
  } else {
    const ref = await rt.resolveFile(args.cloneFileId)
    const source = await rt.fileMeta(ref.fileId)
    // Unsaved edits in an open copy reach the core first.
    await Promise.all(
      rt.env.hosts.targetsFor(ref.fileId).map((target) =>
        rt.env.rpc
          .request(target, {
            fileId: ref.fileId,
            tool: 'flush',
            args: {},
            timeoutMs: 5_000,
            signal,
          })
          .catch(() => undefined),
      ),
    )
    const snapshot = await core.openFile(ref.fileId)
    meta = await core.importFile(
      snapshot,
      args.name?.trim() || `${source?.name ?? 'Untitled'} copy`,
    )
  }
  rt.invalidateFiles()
  rt.env.app.filesChanged()
  rt.env.agents.noteCall(session.sessionId, meta.id, meta.name)
  rt.env.log.info('file created by an agent')
  return okResult(null, { fileId: meta.id, name: meta.name, url: fileUrl(meta.id) })
}

export async function openFile(
  rt: ToolRuntime,
  session: SessionRef,
  args: ToolArgs<'open_file'>,
  signal: AbortSignal,
): Promise<ToolResult> {
  const ref = await rt.resolveFile(args.fileId)
  const pageId = args.pageId ?? ref.pageId ?? undefined
  let target = rt.env.hosts.visibleHost(ref.fileId)
  let firstOpen = false
  if (target) {
    rt.env.app.focusIfAppFocused(target.webContentsId)
  } else {
    rt.env.app.showFile(ref.fileId)
    target = await waitForWindow(rt, ref.fileId, signal)
    firstOpen = true
  }
  const res = await rt.callHost(
    session,
    ref.fileId,
    'open_file',
    { ...(pageId !== undefined ? { pageId } : {}), firstOpen },
    { write: false, timeoutMs: rt.env.deadlines.read, signal },
  )
  return okResult(res.header, res.result)
}

/** Shown when open_file's window lands on the sign-in screen (signed-out profile). */
export const SIGN_IN_MESSAGE =
  'Baren is showing the sign-in screen, so the file cannot open in a window. Ask the user to sign in or choose "Continue offline" in the app, then call open_file again. Every other tool works on this file without opening it.'

/**
 * Wait for a visible window to host `fileId` after `showFile`. When that window shows the
 * sign-in screen instead (it redirects there when signed out), fail at once with an actionable
 * message rather than after the 20 s host deadline.
 */
async function waitForWindow(rt: ToolRuntime, fileId: string, signal: AbortSignal) {
  const signInShown = rt.env.app.signInShown
  if (!signInShown) return rt.env.hosts.waitVisible(fileId, rt.env.deadlines.hostStart, signal)
  const wait = new AbortController()
  const forward = () => wait.abort(signal.reason)
  if (signal.aborted) forward()
  else signal.addEventListener('abort', forward, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  const blocked = new Promise<never>((_, reject) => {
    const check = () => {
      if (signInShown()) reject(new ToolError('host_unavailable', SIGN_IN_MESSAGE))
      else timer = setTimeout(check, SIGN_IN_POLL_MS)
    }
    timer = setTimeout(check, SIGN_IN_POLL_MS)
  })
  try {
    return await Promise.race([
      rt.env.hosts.waitVisible(fileId, rt.env.deadlines.hostStart, wait.signal),
      blocked,
    ])
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', forward)
    wait.abort()
  }
}

const SIGN_IN_POLL_MS = 200

export async function finishWorking(
  rt: ToolRuntime,
  session: SessionRef,
  args: ToolArgs<'finish_working_on_nodes'>,
  signal: AbortSignal,
): Promise<ToolResult> {
  const agents = rt.env.agents
  const fileId =
    args.fileId !== undefined && args.fileId.trim() !== ''
      ? (await rt.resolveFile(args.fileId)).fileId
      : null
  rt.agentOf(session)
  if (args.nodeIds === undefined) {
    const body = agents.release(session.sessionId, fileId, null)
    return okResult(rt.headerFor(fileId), body)
  }
  const sets = agents.working(session.sessionId, fileId)
  const marked = new Set([...sets.values()].flat())
  const artboards = new Set<string>()
  const unknown: string[] = []
  for (const id of args.nodeIds) {
    if (marked.has(id)) artboards.add(id)
    else unknown.push(id)
  }
  // Nodes inside an artboard: ask the host which artboard they belong to.
  const lookupFile =
    fileId ?? (sets.size === 1 ? [...sets.keys()][0]! : rt.env.hosts.defaultFileId())
  if (unknown.length > 0 && lookupFile !== null && rt.env.hosts.targetsFor(lookupFile).length > 0) {
    try {
      const res = await rt.callHost(
        session,
        lookupFile,
        'artboards_of',
        { nodeIds: unknown },
        {
          write: false,
          timeoutMs: rt.env.deadlines.read,
          signal,
          activity: false,
        },
      )
      const map =
        (res.result as { artboards?: Record<string, string | null> } | null)?.artboards ?? {}
      for (const id of unknown) {
        const artboard = map[id]
        if (typeof artboard === 'string') artboards.add(artboard)
      }
    } catch {
      // Unknown ids are never an error here.
    }
  }
  const body = agents.release(session.sessionId, fileId, [...artboards])
  return okResult(rt.headerFor(fileId ?? lookupFile), body)
}
