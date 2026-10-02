/**
 * The component resolver of a document (contract §6: one per editor session). The session's
 * `DocEvents` registers the resolver it feeds with every batch; editor helpers that only get
 * a `LoroDoc` read through `resolverOf(doc)`. A resolver that is never fed is still correct
 * (it drops its caches whenever the document's op count moved), just slower.
 */
import { createComponentResolver, type ComponentResolver } from '@baren/schema'
import type { LoroDoc } from 'loro-crdt'

const resolvers = new WeakMap<LoroDoc, ComponentResolver>()

export function registerResolver(doc: LoroDoc, resolver: ComponentResolver): void {
  resolvers.set(doc, resolver)
}

export function resolverOf(doc: LoroDoc): ComponentResolver {
  let r = resolvers.get(doc)
  if (!r) {
    r = createComponentResolver(doc)
    resolvers.set(doc, r)
  }
  return r
}
