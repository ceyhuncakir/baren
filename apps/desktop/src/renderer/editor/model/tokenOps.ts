/**
 * Token writes for the Theme panel. Values go through @baren/schema `setTokens`; the
 * panel position is an extra `order` number in the same (mergeable) token map, which
 * `setTokens` leaves untouched. One commit per call.
 */
import { setTokens, tokensMap, transact, type Token } from '@baren/schema'
import { LoroMap, type LoroDoc } from 'loro-crdt'
import { ORIGIN } from './docOps'
import { TOKEN_ORDER_KEY, readTokenOrders } from './tokens'

export function tokenOrders(doc: LoroDoc): Record<string, number> {
  return readTokenOrders(tokensMap(doc).toJSON() as Record<string, unknown>)
}

function writeOrder(doc: LoroDoc, name: string, order: number): void {
  const entry = tokensMap(doc).get(name)
  if (entry instanceof LoroMap && entry.get(TOKEN_ORDER_KEY) !== order)
    entry.set(TOKEN_ORDER_KEY, order)
}

/** Create or update tokens; `orders` assigns panel positions (new tokens default to last). */
export function upsertTokens(
  doc: LoroDoc,
  tokens: Record<string, Token>,
  options: { orders?: Record<string, number>; origin?: string } = {},
): void {
  transact(
    doc,
    () => {
      const existing = tokenOrders(doc)
      let next = Object.values(existing).reduce((m, v) => Math.max(m, v), 0) + 1
      setTokens(doc, tokens)
      for (const name of Object.keys(tokens)) {
        const order = options.orders?.[name] ?? existing[name] ?? next++
        writeOrder(doc, name, order)
      }
    },
    { origin: options.origin ?? ORIGIN.theme },
  )
}

export function deleteToken(doc: LoroDoc, name: string): void {
  transact(doc, () => setTokens(doc, { [name]: null }), { origin: ORIGIN.theme })
}

/** Rename keeps value, description and position. Fails (false) when `to` exists. */
export function renameToken(doc: LoroDoc, from: string, to: string, token: Token): boolean {
  const orders = tokenOrders(doc)
  if (from === to) return false
  let ok = false
  transact(
    doc,
    () => {
      if (tokensMap(doc).get(to) !== undefined) return
      setTokens(doc, { [from]: null, [to]: token })
      writeOrder(
        doc,
        to,
        orders[from] ?? Object.values(orders).reduce((m, v) => Math.max(m, v), 0) + 1,
      )
      ok = true
    },
    { origin: ORIGIN.theme },
  )
  return ok
}
