import { useLayoutEffect, useState, type RefObject } from 'react'

/** Content-box width of an element (padding excluded), tracked with a ResizeObserver. */
export function useContentWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const style = getComputedStyle(el)
    const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
    setWidth(Math.max(0, el.clientWidth - padding))
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1]
      if (entry) setWidth(Math.round(entry.contentRect.width))
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref])
  return width
}
