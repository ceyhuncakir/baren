import { clsx } from 'clsx'
import {
  memo,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
  type Ref,
} from 'react'
import { ChevronDownIcon, ChevronRightIcon, FileIcon } from '../../icons/icons'
import { TextAaIcon } from '../../icons/TextAaIcon'
import { needsSwatchBorder, normalizeHex } from '../../lib/color'
import { Kbd } from '../forms/Misc'
import styles from './Panel.module.css'

export interface EditorPanelProps extends HTMLAttributes<HTMLElement> {
  side: 'left' | 'right'
}

/** Left panel (240, border-right) or inspector (264, border-left), surface background. */
export function EditorPanel({ side, className, ...rest }: EditorPanelProps) {
  return (
    <aside
      className={clsx(styles.panel, side === 'left' ? styles.left : styles.right, className)}
      {...rest}
    />
  )
}

export interface PanelHeaderProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  leading?: ReactNode
  /** Title text; takes the free space. Omit to get a spacer instead. */
  title?: ReactNode
  trailing?: ReactNode
  /** Inspector variant: hairline below, padding-left 12, gap 6. */
  bordered?: boolean
}

/** 44px panel header (file header in the left panel, avatar/zoom/share in the inspector). */
export function PanelHeader({
  leading,
  title,
  trailing,
  bordered = false,
  className,
  ...rest
}: PanelHeaderProps) {
  return (
    <div className={clsx(styles.header, bordered && styles.headerBordered, className)} {...rest}>
      {leading}
      {title !== undefined ? (
        <div className={styles.headerTitle}>{title}</div>
      ) : (
        <div className={styles.headerSpacer} />
      )}
      {trailing}
    </div>
  )
}

/** Wrapper for the Design/Theme segmented control under the left panel header. */
export function PanelModeSwitch({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={clsx(styles.modeSwitch, className)} {...rest} />
}

export interface PanelSectionHeaderProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'title'
> {
  title: ReactNode
  expanded?: boolean
  count?: number
  /** Trailing action (e.g. "+" add page). Rendered outside the toggle button. */
  action?: ReactNode
  /** Token groups use 12px right padding instead of 10. */
  wide?: boolean
}

/** "⌄ Pages  +" collapsible group header. */
export function PanelSectionHeader({
  title,
  expanded = true,
  count,
  action,
  wide = false,
  className,
  type = 'button',
  ...rest
}: PanelSectionHeaderProps) {
  return (
    <div className={clsx(styles.sectionHeader, wide && styles.sectionHeaderWide, className)}>
      <button type={type} aria-expanded={expanded} className={styles.sectionToggle} {...rest}>
        <span className={styles.sectionChevron}>
          {expanded ? (
            <ChevronDownIcon size={12} strokeWidth={2.25} />
          ) : (
            <ChevronRightIcon size={12} strokeWidth={2.25} />
          )}
        </span>
        <span className={styles.sectionTitle}>{title}</span>
      </button>
      {count !== undefined && <span className={styles.sectionCount}>{count}</span>}
      {action}
    </div>
  )
}

export interface SectionActionProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string
}

/** Small icon button for section headers ("+" add page). */
export function SectionAction({ label, className, type = 'button', ...rest }: SectionActionProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={clsx(styles.sectionAction, className)}
      {...rest}
    />
  )
}

export interface PageRowProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean
  ref?: Ref<HTMLButtonElement>
}

/** Page list row (13px file icon, padding-left 22). */
export const PageRow = memo(function PageRow({
  active = false,
  className,
  children,
  type = 'button',
  ref,
  ...rest
}: PageRowProps) {
  return (
    <button
      ref={ref}
      type={type}
      aria-current={active ? 'page' : undefined}
      className={clsx(styles.pageRow, className)}
      {...rest}
    >
      <span className={styles.pageIcon}>
        <FileIcon size={13} strokeWidth={1.75} />
      </span>
      <span className={styles.rowLabel}>{children}</span>
    </button>
  )
})

export interface TokenRowProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Token name without the namespace ("selection"). */
  name: string
  /** Display value ("2F80FF", "13px", "Inter"). */
  value: string
  kind: 'color' | 'typography' | 'other'
  /** Hex for color swatches. */
  color?: string
  selected?: boolean
  ref?: Ref<HTMLButtonElement>
}

/** Theme panel token row (07). */
export const TokenRow = memo(function TokenRow({
  name,
  value,
  kind,
  color,
  selected = false,
  className,
  type = 'button',
  ref,
  ...rest
}: TokenRowProps) {
  const hex = color ? normalizeHex(color) : null
  return (
    <button
      ref={ref}
      type={type}
      role="option"
      aria-selected={selected}
      className={clsx(styles.tokenRow, className)}
      {...rest}
    >
      {kind === 'color' ? (
        <span
          className={clsx(
            styles.tokenSwatch,
            hex && needsSwatchBorder(hex) && styles.tokenSwatchBordered,
          )}
          style={{ background: hex ? `#${hex}` : color }}
        />
      ) : kind === 'typography' ? (
        <TextAaIcon size={10} weight={600} className={styles.tokenGlyph} />
      ) : null}
      <span className={styles.rowLabel}>{name}</span>
      <span className={styles.tokenValue}>{value}</span>
    </button>
  )
})

export interface EmptyCanvasHintProps extends HTMLAttributes<HTMLDivElement> {
  shortcut?: string
}

/** "Press [A] to draw an artboard, or paste anything" (04). */
export function EmptyCanvasHint({ shortcut = 'A', className, ...rest }: EmptyCanvasHintProps) {
  return (
    <div className={clsx(styles.emptyHint, className)} {...rest}>
      <span>Press</span>
      <Kbd>{shortcut}</Kbd>
      <span>to draw an artboard, or paste anything</span>
    </div>
  )
}
