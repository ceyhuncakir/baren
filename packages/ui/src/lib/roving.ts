/**
 * Roving focus index math for menus, segmented controls, tabs and tool rails.
 * Disabled entries are skipped; navigation wraps by default.
 */

export type RovingKey = 'next' | 'prev' | 'first' | 'last'

export function nextEnabledIndex(
  current: number,
  count: number,
  key: RovingKey,
  isDisabled: (index: number) => boolean = () => false,
  wrap = true,
): number {
  if (count <= 0) return -1
  const forward = key === 'next' || key === 'first'
  let start: number
  if (key === 'first') start = 0
  else if (key === 'last') start = count - 1
  else start = current + (forward ? 1 : -1)

  for (let i = 0; i < count; i++) {
    let idx = forward ? start + i : start - i
    if (wrap) idx = ((idx % count) + count) % count
    else if (idx < 0 || idx >= count) break
    if (!isDisabled(idx)) return idx
  }
  return current >= 0 && current < count && !isDisabled(current) ? current : -1
}

/** Maps a keyboard event key to a roving action for a given orientation. */
export function rovingKeyFor(
  key: string,
  orientation: 'vertical' | 'horizontal',
): RovingKey | null {
  if (key === 'Home') return 'first'
  if (key === 'End') return 'last'
  if (orientation === 'vertical') {
    if (key === 'ArrowDown') return 'next'
    if (key === 'ArrowUp') return 'prev'
  } else {
    if (key === 'ArrowRight') return 'next'
    if (key === 'ArrowLeft') return 'prev'
  }
  return null
}
