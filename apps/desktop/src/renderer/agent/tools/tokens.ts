/**
 * Token writes (contract §6.19, §6.20): create_tokens and set_tokens, per-entry results, one
 * commit per call. A rename rewrites every `var(--old)` reference in node styles,
 * override styles and token values in the same commit.
 */
import {
  getTokens,
  isTokenName,
  nodesTree,
  setTokens,
  tokensMap,
  type StyleValue,
  type Token,
} from '@baren/schema'
import { LoroMap, type LoroDoc } from 'loro-crdt'
import { TOKEN_ORDER_KEY } from '../../editor/model/tokens'
import { tokenOrders, upsertTokens } from '../../editor/model/tokenOps'
import type { EntryError } from '../errors'
import { html } from '../html'
import { arr, commit, rec, type ToolCall, type ToolOutput } from '../context'

type TokenResult =
  | { name: string; result: 'created' | 'updated' | 'renamed' | 'deleted'; newName?: string }
  | { name: string; result: 'error'; message: string }

const MAX_DESCRIPTION = 1024

function tokenValue(v: unknown): string | number | null {
  if (typeof v === 'string') return v
  if (typeof v === 'number' && Number.isFinite(v)) return v
  return null
}

export function createTokens(call: ToolCall): ToolOutput {
  const { env, args } = call
  const existing = getTokens(env.doc)
  const results: TokenResult[] = []
  const errors: EntryError[] = []
  const add: Record<string, Token> = {}
  arr(args, 'tokens').forEach((raw, index) => {
    const t = rec(raw)
    const name = typeof t['name'] === 'string' ? t['name'].trim() : ''
    const fail = (code: EntryError['code'], message: string) => {
      results.push({ name, result: 'error', message })
      errors.push({ index, id: name, code, message })
    }
    if (!isTokenName(name)) {
      fail(
        'invalid_argument',
        `Invalid token name ${JSON.stringify(name)}: use a CSS custom property like "--color-primary".`,
      )
      return
    }
    if (existing[name] || add[name]) {
      fail('token_exists', `Token ${name} already exists; change it with set_tokens.`)
      return
    }
    const value = tokenValue(t['value'])
    if (value === null) {
      fail('invalid_argument', `Token ${name} needs a string or number value.`)
      return
    }
    const token: Token = { type: typeof t['type'] === 'string' ? t['type'] : 'other', value }
    if (typeof t['description'] === 'string' && t['description'] !== '') {
      token.description = t['description'].slice(0, MAX_DESCRIPTION)
    }
    add[name] = token
    results.push({ name, result: 'created' })
  })
  // Every entry failed: nothing changes; main reports the call as an error (contract §4.9).
  if (Object.keys(add).length === 0) return { result: { results } }
  commit(call, () => upsertTokens(env.doc, add))
  return { result: { results } }
}

/** Rewrite `var(<from>)` references to `var(<to>)` in every style, override and token value. */
export function rewriteReferences(doc: LoroDoc, from: string, to: string): number {
  let changed = 0
  const rewriteMap = (map: LoroMap) => {
    for (const key of map.keys()) {
      const v = map.get(key)
      if (typeof v !== 'string' || !v.includes(from)) continue
      const next = html.rewriteTokenRefs(v as StyleValue, from, to)
      if (next !== v) {
        map.set(key, next)
        changed++
      }
    }
  }
  for (const node of nodesTree(doc).getNodes({ withDeleted: false })) {
    const styles = node.data.get('styles')
    if (styles instanceof LoroMap) rewriteMap(styles)
    const overrides = node.data.get('overrides')
    if (overrides instanceof LoroMap) {
      for (const path of overrides.keys()) {
        const entry = overrides.get(path)
        if (!(entry instanceof LoroMap)) continue
        const s = entry.get('styles')
        if (s instanceof LoroMap) rewriteMap(s)
      }
    }
  }
  const tokens = tokensMap(doc)
  for (const name of tokens.keys()) {
    const entry = tokens.get(name)
    if (!(entry instanceof LoroMap)) continue
    const v = entry.get('value')
    if (typeof v !== 'string' || !v.includes(from)) continue
    const next = html.rewriteTokenRefs(v, from, to)
    if (next !== v) {
      entry.set('value', next)
      changed++
    }
  }
  return changed
}

interface SetEntry {
  index: number
  name: string
  newName?: string
  value?: string | number
  description?: string
  delete: boolean
}

export function setTokensTool(call: ToolCall): ToolOutput {
  const { env, args } = call
  const entries: SetEntry[] = arr(args, 'tokens').map((raw, index) => {
    const t = rec(raw)
    const e: SetEntry = {
      index,
      name: typeof t['name'] === 'string' ? t['name'].trim() : '',
      delete: t['delete'] === true,
    }
    if (typeof t['newName'] === 'string') e.newName = t['newName'].trim()
    const v = tokenValue(t['value'])
    if (v !== null) e.value = v
    if (typeof t['description'] === 'string')
      e.description = t['description'].slice(0, MAX_DESCRIPTION)
    return e
  })
  const results: TokenResult[] = []
  const errors: EntryError[] = []
  // Validate against a simulated token map so later entries see earlier ones.
  const sim = getTokens(env.doc)
  const plan: SetEntry[] = []
  for (const e of entries) {
    const fail = (code: EntryError['code'], message: string) => {
      results.push({ name: e.name, result: 'error', message })
      errors.push({ index: e.index, id: e.name, code, message })
    }
    const current = sim[e.name]
    if (!current) {
      fail(
        'token_not_found',
        `Token ${e.name || '(empty)'} not found; get_tokens lists them, create_tokens adds new ones.`,
      )
      continue
    }
    if (e.delete) {
      delete sim[e.name]
      plan.push(e)
      results.push({ name: e.name, result: 'deleted' })
      continue
    }
    if (e.newName !== undefined && e.newName !== e.name) {
      if (!isTokenName(e.newName)) {
        fail('invalid_argument', `Invalid token name ${JSON.stringify(e.newName)}.`)
        continue
      }
      if (sim[e.newName]) {
        fail('token_exists', `Token ${e.newName} already exists.`)
        continue
      }
    }
    const next: Token = { ...current }
    if (e.value !== undefined) next.value = e.value
    if (e.description !== undefined) {
      if (e.description === '') delete next.description
      else next.description = e.description
    }
    if (e.newName !== undefined && e.newName !== e.name) {
      delete sim[e.name]
      sim[e.newName] = next
      results.push({ name: e.name, result: 'renamed', newName: e.newName })
    } else {
      sim[e.name] = next
      results.push({ name: e.name, result: 'updated' })
    }
    plan.push(e)
  }
  if (plan.length === 0) return { result: { results } }
  commit(call, () => {
    const doc = env.doc
    for (const e of plan) {
      const tokens = getTokens(doc)
      const current = tokens[e.name]
      if (!current) continue
      if (e.delete) {
        setTokens(doc, { [e.name]: null })
        continue
      }
      const next: Token = { ...current }
      if (e.value !== undefined) next.value = e.value
      if (e.description !== undefined) {
        if (e.description === '') delete next.description
        else next.description = e.description
      }
      if (e.newName !== undefined && e.newName !== e.name) {
        const orders = tokenOrders(doc)
        setTokens(doc, { [e.name]: null, [e.newName]: next })
        const entry = tokensMap(doc).get(e.newName)
        const order = orders[e.name]
        if (entry instanceof LoroMap && order !== undefined) entry.set(TOKEN_ORDER_KEY, order)
        rewriteReferences(doc, e.name, e.newName)
      } else {
        setTokens(doc, { [e.name]: next })
      }
    }
  })
  return { result: { results } }
}
