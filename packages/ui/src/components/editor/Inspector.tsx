import { clsx } from 'clsx'
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode, Ref } from 'react'
import { ChevronDownIcon, PlusIcon, TargetIcon } from '../../icons/icons'
import { formatAlpha, needsSwatchBorder, normalizeHex } from '../../lib/color'
import { Button, type ButtonProps } from '../forms/Button'
import styles from './Inspector.module.css'

export interface InspectorSectionProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title: ReactNode
  /** Title acts as a dropdown ("Layout ⌄"). */
  titleChevron?: boolean
  onTitleClick?: () => void
  /** Header actions (icon buttons / "Select all"). */
  actions?: ReactNode
  /** gap 6 instead of 8 (Typography, Selection colors). */
  tight?: boolean
  /** padding 12/12/14 (Page, MCP, theme sections). */
  roomy?: boolean
  bordered?: boolean
}

export function InspectorSection({
  title,
  titleChevron = false,
  onTitleClick,
  actions,
  tight = false,
  roomy = false,
  bordered = true,
  className,
  children,
  ...rest
}: InspectorSectionProps) {
  const titleContent = (
    <>
      {title}
      {titleChevron && (
        <ChevronDownIcon size={11} strokeWidth={2.25} className={styles.sectionTitleChevron} />
      )}
    </>
  )
  return (
    <section
      className={clsx(
        styles.section,
        tight && styles.tight,
        roomy && styles.roomy,
        !bordered && styles.noBorder,
        className,
      )}
      {...rest}
    >
      <div className={styles.sectionHeader}>
        {onTitleClick ? (
          <button
            type="button"
            className={styles.sectionTitle}
            onClick={onTitleClick}
            aria-haspopup="menu"
          >
            {titleContent}
          </button>
        ) : (
          <h3 className={styles.sectionTitle}>{titleContent}</h3>
        )}
        {actions !== undefined && <div className={styles.sectionActions}>{actions}</div>}
      </div>
      {children}
    </section>
  )
}

export interface SectionHeaderActionProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string
  active?: boolean
}

/** 13px icon in a section header (maximize, minus, plus, eye, tokens). */
export function SectionHeaderAction({
  label,
  active,
  className,
  type = 'button',
  ...rest
}: SectionHeaderActionProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={clsx(styles.headerAction, className)}
      {...rest}
    />
  )
}

/** Blue 11px header link ("Select all", 07). */
export function SectionHeaderLink({
  className,
  type = 'button',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type={type} className={clsx(styles.headerLink, className)} {...rest} />
}

export interface CollapsedSectionProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'title'
> {
  title: ReactNode
}

/** Empty section row ("Outline +", "Shadow +"): clicking adds the first entry. */
export function CollapsedSection({
  title,
  className,
  type = 'button',
  ...rest
}: CollapsedSectionProps) {
  return (
    <button type={type} className={clsx(styles.collapsed, className)} {...rest}>
      <span>{title}</span>
      <PlusIcon size={13} strokeWidth={2} />
    </button>
  )
}

export interface InspectorRowProps extends HTMLAttributes<HTMLDivElement> {
  /** Stretch children vertically (alignment grid + fields). */
  alignTop?: boolean
}

/** Horizontal group of fields, gap 6. */
export function InspectorRow({ alignTop = false, className, ...rest }: InspectorRowProps) {
  return <div className={clsx(styles.row, alignTop && styles.rowTop, className)} {...rest} />
}

/** Vertical stack of rows inside a row (flex grid next to the alignment box). */
export function InspectorColumn({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={clsx(styles.column, className)} {...rest} />
}

interface FieldChromeProps {
  /** Label letter ("X") or 11px icon, drawn subtle. */
  prefix?: ReactNode
  /** Prefix in foreground (padding icons draw their active side in foreground). */
  prefixStrong?: boolean
  /** Muted text at the end ("100%"). */
  suffix?: ReactNode
  /** Dropdown chevron (10px). */
  chevron?: boolean
  size?: 26 | 28
  /** Fixed width (64 rotation, 72 radius, 80 font size); otherwise grows. */
  width?: number
  mono?: boolean
}

export interface InspectorFieldProps
  extends FieldChromeProps, Omit<HTMLAttributes<HTMLDivElement>, 'prefix'> {
  /** Value text; grows to fill when there is a chevron. */
  children?: ReactNode
  mutedValue?: boolean
}

/** Static/display field. Use NumberField / ColorField for editing, InspectorSelect for menus. */
export function InspectorField({
  prefix,
  prefixStrong = false,
  suffix,
  chevron = false,
  size = 26,
  width,
  mono = false,
  mutedValue = false,
  className,
  style,
  children,
  ...rest
}: InspectorFieldProps) {
  return (
    <div
      className={clsx(fieldClass({ chevron, size, width, mono }), className)}
      style={width !== undefined ? { width, ...style } : style}
      {...rest}
    >
      {prefix !== undefined && (
        <span className={clsx(styles.prefix, prefixStrong && styles.prefixStrong)}>{prefix}</span>
      )}
      <span
        className={clsx(
          styles.value,
          (chevron || suffix !== undefined) && styles.grow,
          mutedValue && styles.muted,
        )}
      >
        {children}
      </span>
      {suffix !== undefined && <span className={styles.suffix}>{suffix}</span>}
      {chevron && <ChevronDownIcon size={10} strokeWidth={2.5} className={styles.chevron} />}
    </div>
  )
}

export function fieldClass(o: {
  chevron?: boolean
  size?: 26 | 28
  width?: number
  mono?: boolean
}): string {
  return clsx(
    styles.field,
    o.chevron && styles.withChevron,
    o.size === 28 && styles.h28,
    o.width !== undefined && styles.fixed,
    o.mono && styles.mono,
  )
}

export interface InspectorSelectProps
  extends FieldChromeProps, Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'prefix'> {
  ref?: Ref<HTMLButtonElement>
}

/** Field that opens a menu ("Fit ⌄", "Normal ⌄", "Inter ⌄"). Pair with DropdownMenu. */
export function InspectorSelect({
  prefix,
  prefixStrong = false,
  suffix,
  chevron = true,
  size = 26,
  width,
  mono = false,
  className,
  style,
  children,
  type = 'button',
  ref,
  ...rest
}: InspectorSelectProps) {
  return (
    <button
      ref={ref}
      type={type}
      aria-haspopup="menu"
      className={clsx(fieldClass({ chevron, size, width, mono }), className)}
      style={width !== undefined ? { width, ...style } : style}
      {...rest}
    >
      {prefix !== undefined && (
        <span className={clsx(styles.prefix, prefixStrong && styles.prefixStrong)}>{prefix}</span>
      )}
      <span className={clsx(styles.value, styles.grow)}>{children}</span>
      {suffix !== undefined && <span className={styles.suffix}>{suffix}</span>}
      {chevron && <ChevronDownIcon size={10} strokeWidth={2.5} className={styles.chevron} />}
    </button>
  )
}

export interface FieldIconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string
  active?: boolean
  /** Blue icon (token picker when the value is bound to a token). */
  accent?: boolean
  size?: 26 | 28
}

/** 22×26 icon button next to fields (tokens, pipette, padding mode, detach). */
export function FieldIconButton({
  label,
  active,
  accent = false,
  size = 26,
  className,
  type = 'button',
  ...rest
}: FieldIconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={clsx(
        styles.iconAction,
        size === 28 && styles.iconAction28,
        accent && styles.accent,
        className,
      )}
      {...rest}
    />
  )
}

export interface SplitFieldButton {
  label: string
  icon: ReactNode
  active?: boolean
  onClick?: () => void
}

/** 64px field holding two icon toggles (link dimensions · flip), 06 Layout. */
export function SplitField({
  buttons,
  width = 64,
}: {
  buttons: [SplitFieldButton, SplitFieldButton]
  width?: number
}) {
  return (
    <div className={clsx(styles.field, styles.fixed, styles.split)} style={{ width }}>
      {buttons.map((b) => (
        <button
          key={b.label}
          type="button"
          aria-label={b.label}
          title={b.label}
          aria-pressed={b.active}
          className={styles.splitButton}
          onClick={b.onClick}
        >
          {b.icon}
        </button>
      ))}
    </div>
  )
}

export interface SwatchProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Hex (with or without #) or any CSS color. */
  color: string
  size?: 12 | 14
}

/** Color swatch; light colors get a hairline. Clicking opens the picker. */
export function Swatch({
  color,
  size = 12,
  className,
  style,
  type = 'button',
  ...rest
}: SwatchProps) {
  const hex = normalizeHex(color)
  const bg = hex ? `#${hex}` : color
  const bordered = hex ? needsSwatchBorder(hex) : false
  return (
    <button
      type={type}
      aria-label={rest['aria-label'] ?? `Color ${hex ?? color}`}
      className={clsx(
        styles.swatch,
        size === 14 && styles.swatch14,
        bordered && styles.swatchBordered,
        className,
      )}
      style={{ background: bg, ...style }}
      {...rest}
    />
  )
}

/** White chip with the token name inside a color field ("background"). */
export function TokenChip({ className, ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={clsx(styles.tokenChip, className)} {...rest} />
}

export interface SelectionColorRowProps extends HTMLAttributes<HTMLDivElement> {
  color: string
  /** Token or color name ("gray-400"). */
  name: string
  opacity?: number
  /** Number of layers using it ("99+"). */
  count: number | string
  onSelectUsages?: () => void
  onSwatchClick?: () => void
}

/** Row in "Selection colors" (06). */
export function SelectionColorRow({
  color,
  name,
  opacity = 1,
  count,
  onSelectUsages,
  onSwatchClick,
  className,
  ...rest
}: SelectionColorRowProps) {
  const display = typeof count === 'number' && count > 99 ? '99+' : String(count)
  return (
    <div className={clsx(styles.row, className)} {...rest}>
      <div className={styles.field}>
        <Swatch color={color} onClick={onSwatchClick} />
        <span className={clsx(styles.value, styles.grow)}>{name}</span>
        <span className={styles.suffix}>{formatAlpha(opacity)}</span>
      </div>
      <button
        type="button"
        className={styles.usage}
        aria-label={`Select ${display} layers using ${name}`}
        title="Select layers"
        onClick={onSelectUsages}
      >
        <TargetIcon size={11} strokeWidth={2} />
        {display}
      </button>
    </div>
  )
}

export interface ZoomChipProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Percent (18 → "18%"). */
  zoom: number
  open?: boolean
  ref?: Ref<HTMLButtonElement>
}

/** "18% ⌄" in the inspector header; opens the zoom menu (16). */
export function ZoomChip({ zoom, open, className, type = 'button', ref, ...rest }: ZoomChipProps) {
  return (
    <button
      ref={ref}
      type={type}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label={`Zoom ${Math.round(zoom)}%`}
      className={clsx(styles.zoomChip, className)}
      {...rest}
    >
      {Math.round(zoom)}%
      <ChevronDownIcon size={12} strokeWidth={2} />
    </button>
  )
}

export interface ShareButtonProps extends Omit<ButtonProps, 'variant' | 'size'> {
  open?: boolean
}

/** Outline 26px "Share" (opens the share popover, 08). */
export function ShareButton({ open = false, children = 'Share', ...rest }: ShareButtonProps) {
  return (
    <Button
      variant="outline"
      size={26}
      textSize={12}
      pressed={open}
      aria-haspopup="dialog"
      aria-expanded={open}
      {...rest}
    >
      {children}
    </Button>
  )
}

/** "142 layers across 9 artboards" (07). */
export function Stat({ value, caption }: { value: ReactNode; caption: ReactNode }) {
  return (
    <div className={styles.stat}>
      <span className={styles.statValue}>{value}</span>
      <span className={styles.statCaption}>{caption}</span>
    </div>
  )
}

/** Wrapping row of small badges. */
export function ChipRow({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={clsx(styles.chips, className)} {...rest} />
}

/** "--color-selection" name field (07). */
export function TokenNameField({
  name,
  namespace = '--color-',
  size = 28,
}: {
  name: string
  namespace?: string
  size?: 26 | 28
}) {
  return (
    <div className={fieldClass({ size, mono: true })} style={{ gap: 0 }}>
      <span className={styles.tokenNamespace}>{namespace}</span>
      <span className={styles.value}>{name}</span>
    </div>
  )
}
