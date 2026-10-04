/**
 * The Typography section's font family field: the bundled families, then every Google Fonts
 * family, searchable. Main downloads the Google Fonts a design uses (`editor/lib/fonts.ts`), so
 * they render the same for every collaborator.
 */
import { DropdownMenu, InspectorSelect, MenuInput, MenuItem, MenuLabel } from '@baren/ui'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Mixed } from '../model/styles'
import { fontRows, sameFamily, type FontRow } from './fontRows'
import css from './Inspector.module.css'

/** MenuItem height (Menu.module.css `.item`). */
const ROW_HEIGHT = 30
const LIST_HEIGHT = 320

export interface FontFamilyPickerProps {
  /** The selection's family (`font-family` value), MIXED, or undefined. */
  value: Mixed<string> | undefined
  display: ReactNode
  onChange: (value: string) => void
}

export function FontFamilyPicker({ value, display, onChange }: FontFamilyPickerProps) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const rows = useMemo(() => (open ? fontRows(query) : []), [open, query])
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  })
  const current = typeof value === 'string' ? value : null

  // On open: focus the search field and show the current family.
  useEffect(() => {
    if (!open) return
    const id = requestAnimationFrame(() => {
      inputRef.current?.focus({ preventScroll: true })
      const index = current
        ? rows.findIndex((r) => r.kind === 'font' && sameFamily(r.value, current))
        : -1
      if (index > 0) virtualizer.scrollToIndex(index, { align: 'center' })
    })
    return () => cancelAnimationFrame(id)
    // Only when the menu opens: the query changes the rows, not the scroll target.
  }, [open])

  const toggle = (next: boolean) => {
    if (next) setQuery('')
    setOpen(next)
  }
  const pick = (family: string) => {
    onChange(family)
    setOpen(false)
  }

  return (
    <>
      <InspectorSelect
        ref={triggerRef}
        aria-expanded={open}
        aria-label="Font family"
        onClick={() => toggle(!open)}
      >
        {display}
      </InspectorSelect>
      <DropdownMenu
        open={open}
        onOpenChange={toggle}
        anchorRef={triggerRef}
        width={Math.max(240, triggerRef.current?.offsetWidth ?? 240)}
        offset={4}
        aria-label="Font family"
      >
        <MenuInput
          ref={inputRef}
          value={query}
          placeholder="Search fonts"
          aria-label="Search fonts"
          onChange={(e) => {
            setQuery(e.currentTarget.value)
            scrollRef.current?.scrollTo({ top: 0 })
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return
            e.preventDefault()
            e.stopPropagation()
            const first = rows.find((r) => r.kind === 'font')
            if (first?.kind === 'font') pick(first.value)
          }}
        />
        <div
          ref={scrollRef}
          className={css.fontList}
          style={{ height: Math.min(LIST_HEIGHT, Math.max(ROW_HEIGHT, rows.length * ROW_HEIGHT)) }}
        >
          {rows.length === 0 ? (
            <MenuLabel>No fonts match “{query.trim()}”</MenuLabel>
          ) : (
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {virtualizer.getVirtualItems().map((item) => {
                const row = rows[item.index] as FontRow
                const style = {
                  position: 'absolute' as const,
                  top: 0,
                  left: 0,
                  right: 0,
                  transform: `translateY(${item.start}px)`,
                }
                if (row.kind === 'label') {
                  return (
                    <div key={`label:${row.text}`} className={css.fontListLabel} style={style}>
                      <MenuLabel>{row.text}</MenuLabel>
                    </div>
                  )
                }
                return (
                  <MenuItem
                    key={row.value}
                    style={style}
                    checked={current !== null && sameFamily(row.value, current)}
                    trailing={row.detail ?? undefined}
                    onFocus={(e) => e.currentTarget.scrollIntoView({ block: 'nearest' })}
                    onSelect={() => pick(row.value)}
                  >
                    {row.label}
                  </MenuItem>
                )
              })}
            </div>
          )}
        </div>
      </DropdownMenu>
    </>
  )
}
