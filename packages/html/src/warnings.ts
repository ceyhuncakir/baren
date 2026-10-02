import type { HtmlWarning, HtmlWarningCode } from './types.ts'

/** Internal: the token name of an `unknown-token` warning (not part of the public shape). */
export const WARNING_TOKEN = new WeakMap<HtmlWarning, string>()

type Extra = { path?: string; property?: string; token?: string }

/** Collects warnings, deduplicated by (code, property, path) (contract §7.9). */
export class Warnings {
  readonly items: HtmlWarning[] = []
  private readonly seen = new Set<string>()

  add(code: HtmlWarningCode, message: string, extra: Extra = {}): void {
    const key = `${code}\u0001${extra.property ?? ''}\u0001${extra.path ?? ''}\u0001${extra.token ?? ''}`
    if (this.seen.has(key)) return
    this.seen.add(key)
    const w: HtmlWarning = { code, message }
    if (extra.path !== undefined && extra.path !== '') w.path = extra.path
    if (extra.property !== undefined) w.property = extra.property
    if (extra.token !== undefined) WARNING_TOKEN.set(w, extra.token)
    this.items.push(w)
  }

  /** At most one warning with this code per call. */
  once(code: HtmlWarningCode, message: string, extra: Extra = {}): void {
    const key = `${code}\u0002once`
    if (this.seen.has(key)) return
    this.seen.add(key)
    this.add(code, message, extra)
  }

  addAll(list: readonly HtmlWarning[]): void {
    for (const w of list) {
      const extra: Extra = {}
      if (w.path !== undefined) extra.path = w.path
      if (w.property !== undefined) extra.property = w.property
      const token = WARNING_TOKEN.get(w)
      if (token !== undefined) extra.token = token
      this.add(w.code, w.message, extra)
    }
  }
}
