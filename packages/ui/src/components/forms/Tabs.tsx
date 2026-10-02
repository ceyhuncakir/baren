import { clsx } from 'clsx'
import { useRef, type HTMLAttributes, type KeyboardEvent } from 'react'
import { nextEnabledIndex, rovingKeyFor } from '../../lib/roving'
import styles from './Tabs.module.css'

export interface TabItem<V extends string = string> {
  value: V
  label: string
  disabled?: boolean
  /** id of the controlled tabpanel, for aria-controls. */
  panelId?: string
}

export interface TabsProps<V extends string = string> extends Omit<
  HTMLAttributes<HTMLDivElement>,
  'onChange'
> {
  items: ReadonlyArray<TabItem<V>>
  value: V
  onChange: (value: V) => void
}

/** Underline tab list (Team settings: Members · Settings). Arrow keys move and select. */
export function Tabs<V extends string = string>({
  items,
  value,
  onChange,
  className,
  ...rest
}: TabsProps<V>) {
  const listRef = useRef<HTMLDivElement>(null)

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const action = rovingKeyFor(e.key, 'horizontal')
    if (!action) return
    e.preventDefault()
    const current = items.findIndex((t) => t.value === value)
    const next = nextEnabledIndex(current, items.length, action, (i) => !!items[i]?.disabled)
    const item = items[next]
    if (!item) return
    onChange(item.value)
    listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
  }

  return (
    <div
      ref={listRef}
      role="tablist"
      className={clsx(styles.list, className)}
      onKeyDown={onKeyDown}
      {...rest}
    >
      {items.map((t) => {
        const selected = t.value === value
        return (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={t.panelId}
            tabIndex={selected ? 0 : -1}
            disabled={t.disabled}
            className={styles.tab}
            onClick={() => !selected && onChange(t.value)}
          >
            <span className={styles.tabLabel} data-text={t.label}>
              {t.label}
            </span>
            <span className={styles.underline} />
          </button>
        )
      })}
    </div>
  )
}
