/**
 * @mentions in comments, the parts without DOM: the `@query` being typed at the caret, the people
 * and agents it can complete to, inserting the picked name, keeping only mentions whose `@Name`
 * is still in the text, and splitting a message body into text and highlighted mentions.
 *
 * The body keeps the text as typed ("@Ana can you…"); `CommentMessage.mentions` records who it
 * addresses (user ids, `agent:<name>` for agents), so only recorded names are highlighted.
 */
import type { CommentAuthor, CommentMention, CommentMessage } from '@baren/schema'

/** How many suggestions the composer shows. */
export const MAX_SUGGESTIONS = 6

/** The agent identity in comments (authors and mentions): `agent:<display name>`. */
export function agentMentionId(name: string): string {
  return `agent:${name}`
}

/**
 * The `@query` the caret is in, if any: an `@` at the start of the text or after whitespace,
 * followed by up to 40 characters without whitespace up to the caret.
 */
export function activeMentionQuery(
  text: string,
  caret: number,
): { start: number; query: string } | null {
  const before = text.slice(0, caret)
  const match = /(^|\s)@([^\s@]{0,40})$/.exec(before)
  if (!match) return null
  const query = match[2] ?? ''
  return { start: caret - query.length - 1, query }
}

/**
 * Candidates for a query: names (or any of their words) starting with it, whole-name matches
 * first; at most `limit`, in the given order otherwise (people present first, see
 * `mentionCandidates`).
 */
export function filterCandidates(
  candidates: readonly CommentMention[],
  query: string,
  limit = MAX_SUGGESTIONS,
): CommentMention[] {
  const q = query.toLowerCase()
  const whole: CommentMention[] = []
  const word: CommentMention[] = []
  for (const c of candidates) {
    const name = c.name.toLowerCase()
    if (name.startsWith(q)) whole.push(c)
    else if (name.split(/\s+/).some((w) => w.startsWith(q))) word.push(c)
  }
  return [...whole, ...word].slice(0, limit)
}

/** Replace the `@query` (from `start` to `caret`) with `@Name `; returns the text and the caret. */
export function insertMention(
  text: string,
  start: number,
  caret: number,
  name: string,
): { text: string; caret: number } {
  const inserted = `@${name} `
  const after = text.slice(caret).replace(/^ /, '')
  return { text: text.slice(0, start) + inserted + after, caret: start + inserted.length }
}

function mentionPattern(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // At the start or after whitespace/punctuation, and not followed by more of a word.
  return new RegExp(`(^|[^\\w@])@${escaped}(?![\\w])`, 'u')
}

/** The mentions whose `@Name` is still in the text (deduplicated by id). */
export function keptMentions(text: string, mentions: readonly CommentMention[]): CommentMention[] {
  const seen = new Set<string>()
  return mentions.filter((m) => {
    if (seen.has(m.id) || !mentionPattern(m.name).test(text)) return false
    seen.add(m.id)
    return true
  })
}

export type BodySegment = { text: string; mention?: CommentMention }

/** A message body as text and highlighted mentions (recorded names only, longest first). */
export function mentionSegments(body: string, mentions: readonly CommentMention[]): BodySegment[] {
  if (mentions.length === 0) return [{ text: body }]
  const byName = [...mentions].sort((a, b) => b.name.length - a.name.length)
  const out: BodySegment[] = []
  let plain = ''
  let i = 0
  while (i < body.length) {
    const prev = i === 0 ? '' : (body[i - 1] as string)
    const boundary = i === 0 || !/[\w@]/u.test(prev)
    const hit =
      body[i] === '@' && boundary
        ? byName.find((m) => {
            if (!body.startsWith(m.name, i + 1)) return false
            const next = body[i + 1 + m.name.length]
            return next === undefined || !/\w/u.test(next)
          })
        : undefined
    if (hit) {
      if (plain) out.push({ text: plain })
      plain = ''
      out.push({ text: `@${hit.name}`, mention: hit })
      i += hit.name.length + 1
    } else {
      plain += body[i]
      i++
    }
  }
  if (plain) out.push({ text: plain })
  return out
}

/** True when a message mentions this person (by id). */
export function mentionsAuthor(message: CommentMessage, me: CommentAuthor): boolean {
  return message.mentions.some((m) => m.id === me.id)
}

/**
 * Everyone a comment can mention, deduplicated by id, without `me`: people in the file now,
 * agents working in it, the file's team members, then people and agents who commented before.
 */
export function mentionCandidates(
  me: CommentAuthor,
  sources: {
    peers: readonly CommentMention[]
    agents: readonly CommentMention[]
    members: readonly CommentMention[]
    authors: readonly CommentMention[]
  },
): CommentMention[] {
  const out: CommentMention[] = []
  const seen = new Set<string>([me.id])
  for (const list of [sources.peers, sources.agents, sources.members, sources.authors]) {
    for (const c of list) {
      if (seen.has(c.id) || c.name.trim() === '') continue
      seen.add(c.id)
      out.push({ id: c.id, name: c.name, kind: c.kind })
    }
  }
  return out
}

/**
 * Messages that mention `me` and are not in `known` (ids seen before), written by someone else:
 * what deserves a "<name> mentioned you" toast. Adds every current message id to `known`.
 */
export function newMentionsOf(
  threads: readonly { id: string; messages: readonly CommentMessage[] }[],
  me: CommentAuthor,
  known: Set<string>,
): { threadId: string; message: CommentMessage }[] {
  const out: { threadId: string; message: CommentMessage }[] = []
  for (const t of threads) {
    for (const m of t.messages) {
      if (known.has(m.id)) continue
      known.add(m.id)
      if (m.author.id !== me.id && mentionsAuthor(m, me)) out.push({ threadId: t.id, message: m })
    }
  }
  return out
}
