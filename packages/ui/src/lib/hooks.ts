import { useCallback, useLayoutEffect, useRef, useState } from 'react'

/**
 * A callback with a stable identity that always sees the latest props. Lets memoized
 * children (layer rows, menu items) keep their props equal across parent renders.
 */
export function useStableCallback<A extends unknown[], R>(
  fn: ((...args: A) => R) | undefined,
): (...args: A) => R | undefined {
  const ref = useRef(fn)
  useLayoutEffect(() => {
    ref.current = fn
  })
  return useCallback((...args: A) => ref.current?.(...args), [])
}

/**
 * Controlled/uncontrolled state in one hook: when `value` is provided it wins, otherwise
 * the component keeps its own state seeded from `defaultValue`.
 */
export function useControllableState<T>(
  value: T | undefined,
  defaultValue: T,
  onChange?: (next: T) => void,
): [T, (next: T) => void] {
  const [inner, setInner] = useState(defaultValue)
  const controlled = value !== undefined
  const current = controlled ? value : inner
  const onChangeStable = useStableCallback(onChange)
  const set = useCallback(
    (next: T) => {
      if (!controlled) setInner(next)
      onChangeStable(next)
    },
    [controlled, onChangeStable],
  )
  return [current, set]
}
