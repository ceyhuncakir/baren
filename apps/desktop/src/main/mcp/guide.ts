/**
 * The agent guide served by `get_guide` and the `initialize` instructions (contract §6.1),
 * bundled from `docs/phase4/guide.md` and split at its `<!-- topic: <name> -->` markers: the text
 * between a marker and the next one (trimmed) is that topic. Nothing above the first marker is
 * served.
 */
import guideSource from '../../../../../docs/phase4/guide.md?raw'

/** Topics an agent can ask for (`server-instructions` is internal). */
export const GUIDE_TOPICS = [
  'baren-mcp-instructions',
  'mobile-status-bar',
  'images',
  'code-export',
  'image-generation',
] as const

const MARKER = /^<!--\s*topic:\s*([a-z0-9-]+)\s*-->\s*$/gm

export function splitGuide(source: string): Map<string, string> {
  const topics = new Map<string, string>()
  const marks = [...source.matchAll(MARKER)]
  marks.forEach((mark, i) => {
    const start = (mark.index ?? 0) + mark[0].length
    const end = marks[i + 1]?.index ?? source.length
    topics.set(mark[1] ?? '', source.slice(start, end).trim())
  })
  return topics
}

export class Guide {
  private readonly topics: Map<string, string>

  constructor(source: string = guideSource) {
    this.topics = splitGuide(source)
  }

  /** The `initialize` instructions. */
  get serverInstructions(): string {
    return this.topics.get('server-instructions') ?? ''
  }

  /** A topic's markdown, or null when unknown (case-insensitive). */
  topic(name: string): string | null {
    const key = name.trim().toLowerCase()
    if (key === 'server-instructions') return null
    return this.topics.get(key) ?? null
  }

  /** Every topic an agent can request. */
  list(): string[] {
    return GUIDE_TOPICS.filter((t) => this.topics.has(t))
  }
}
