import { useCallback, type Ref, type RefCallback } from 'react'

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === 'function') ref(value)
  else if (ref) ref.current = value
}

/** Combines several refs (local + forwarded `ref` prop) into one callback ref. */
export function useMergedRefs<T>(...refs: Array<Ref<T> | undefined>): RefCallback<T> {
  // The ref list itself is the dependency list: a new callback only when a ref changes.
  return useCallback((value: T | null) => refs.forEach((r) => assignRef(r, value)), refs)
}
