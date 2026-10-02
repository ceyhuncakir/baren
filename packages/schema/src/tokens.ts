import { LoroMap, type LoroDoc } from 'loro-crdt'
import { autoCommit, tokensMap } from './doc.ts'
import { SchemaError } from './errors.ts'
import type { Token } from './types.ts'

const TOKEN_NAME_RE = /^--[A-Za-z0-9_-]+$/

export function isTokenName(name: string): boolean {
  return TOKEN_NAME_RE.test(name)
}

export function decodeToken(value: unknown): Token | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const v = value as Record<string, unknown>
  const raw = v['value']
  if (typeof raw !== 'string' && typeof raw !== 'number') return undefined
  const token: Token = { type: typeof v['type'] === 'string' ? v['type'] : 'other', value: raw }
  if (typeof v['description'] === 'string') token.description = v['description']
  return token
}

/** All tokens, keyed by CSS variable name (`--color-primary`). */
export function getTokens(doc: LoroDoc): Record<string, Token> {
  const out: Record<string, Token> = {}
  const json = tokensMap(doc).toJSON() as Record<string, unknown>
  for (const name in json) {
    const token = decodeToken(json[name])
    if (token) out[name] = token
  }
  return out
}

export interface SetTokensOptions {
  /** Delete every token not present in `tokens`. Default false (merge). */
  replace?: boolean
}

/**
 * Upsert tokens by CSS variable name; a `null` value deletes the token.
 * Each token is a mergeable child map so concurrent edits of different
 * fields of the same token merge instead of forking.
 */
export function setTokens(
  doc: LoroDoc,
  tokens: Record<string, Token | null>,
  options: SetTokensOptions = {},
): void {
  const map = tokensMap(doc)
  for (const name in tokens) {
    if (!isTokenName(name)) {
      throw new SchemaError('invalid-token', `Token names must be CSS custom properties: ${name}`)
    }
  }
  if (options.replace) {
    for (const name of map.keys()) {
      if (!(name in tokens)) map.delete(name)
    }
  }
  for (const name in tokens) {
    const token = tokens[name]
    if (token === undefined) continue
    if (token === null) {
      if (map.get(name) !== undefined) map.delete(name)
      continue
    }
    if (typeof token.value !== 'string' && typeof token.value !== 'number') {
      throw new SchemaError('invalid-token', `Token ${name} needs a string or number value`)
    }
    const existing = map.get(name)
    const entry = existing instanceof LoroMap ? existing : map.ensureMergeableMap(name)
    if (entry.get('type') !== token.type) entry.set('type', token.type)
    if (entry.get('value') !== token.value) entry.set('value', token.value)
    if (token.description === undefined) {
      if (entry.get('description') !== undefined) entry.delete('description')
    } else if (entry.get('description') !== token.description) {
      entry.set('description', token.description)
    }
  }
  autoCommit(doc)
}
