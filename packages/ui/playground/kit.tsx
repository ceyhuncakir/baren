import type { CSSProperties, ReactNode } from 'react'

export function Page({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="pg-page" data-testid="pg-page">
      <h2>{title}</h2>
      {children}
    </div>
  )
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="pg-section">
      <h3>{title}</h3>
      {children}
    </section>
  )
}

export function Row({
  children,
  gap,
  align,
}: {
  children: ReactNode
  gap?: number
  align?: CSSProperties['alignItems']
}) {
  return (
    <div className="pg-row" style={{ gap, alignItems: align }}>
      {children}
    </div>
  )
}

export function Specimen({
  label,
  children,
  width,
}: {
  label: string
  children: ReactNode
  width?: number | string
}) {
  return (
    <div
      className="pg-specimen"
      style={{ width, alignItems: width === undefined ? 'flex-start' : undefined }}
    >
      <div className="pg-label">{label}</div>
      {children}
    </div>
  )
}

/** Component on the panel surface (#F7F7F7), like the sidebars and inspector. */
export function Surface({
  children,
  width,
  padding,
}: {
  children: ReactNode
  width?: number
  padding?: number
}) {
  return (
    <div className="pg-surface" style={{ width, padding }}>
      {children}
    </div>
  )
}

export function Canvas({
  children,
  width,
  height,
}: {
  children: ReactNode
  width?: number
  height?: number
}) {
  return (
    <div className="pg-canvas" style={{ width, height }}>
      {children}
    </div>
  )
}
