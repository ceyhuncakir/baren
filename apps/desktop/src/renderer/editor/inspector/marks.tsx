/**
 * Override dots after section titles (artboard 31: "Fill ●"): the inspector body provides
 * the sections whose properties the selected instance content overrides.
 */
import { createContext, useContext, type ReactNode } from 'react'
import css from './Inspector.module.css'

const MarksContext = createContext<ReadonlySet<string>>(new Set())

export function OverrideMarks({
  sections,
  children,
}: {
  sections: ReadonlySet<string>
  children: ReactNode
}) {
  return <MarksContext.Provider value={sections}>{children}</MarksContext.Provider>
}

/** A section title, followed by the component-colour dot when its values are overridden. */
export function SectionTitle({ name }: { name: string }) {
  const marked = useContext(MarksContext).has(name)
  return (
    <>
      {name}
      {marked && (
        <span className={css.overrideDot} title="Overridden in this instance" aria-hidden />
      )}
    </>
  )
}
