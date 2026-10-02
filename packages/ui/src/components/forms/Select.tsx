import { clsx } from 'clsx'
import { useRef, useState, type ButtonHTMLAttributes, type ReactNode, type Ref } from 'react'
import { ChevronDownIcon } from '../../icons/icons'
import { useMergedRefs } from '../../lib/refs'
import { DropdownMenu } from '../shell/DropdownMenu'
import { MenuItem } from '../shell/Menu'
import styles from './Select.module.css'

export type SelectVariant = 'filled' | 'ghost'
export type SelectSize = 24 | 26 | 32

export interface SelectTriggerProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: SelectVariant
  /** filled: 32 (settings rows) or 26 (table role chip). ghost is always 24. */
  size?: SelectSize
  leadingIcon?: ReactNode
  placeholder?: ReactNode
  fullWidth?: boolean
  open?: boolean
  ref?: Ref<HTMLButtonElement>
}

const CHEVRON: Record<SelectVariant | 26, { size: number; stroke: number }> = {
  filled: { size: 13, stroke: 2 },
  26: { size: 12, stroke: 2 },
  ghost: { size: 10, stroke: 2.5 },
}

/** The closed state of a select: value + chevron. Pair with DropdownMenu or use <Select>. */
export function SelectTrigger({
  variant = 'filled',
  size = 32,
  leadingIcon,
  placeholder,
  fullWidth = false,
  open,
  className,
  children,
  type = 'button',
  ref,
  ...rest
}: SelectTriggerProps) {
  const chevron = variant === 'ghost' ? CHEVRON.ghost : size === 26 ? CHEVRON[26] : CHEVRON.filled
  const empty = children === undefined || children === null || children === ''
  return (
    <button
      ref={ref}
      type={type}
      aria-haspopup="menu"
      aria-expanded={open}
      className={clsx(
        styles.trigger,
        variant === 'ghost' && styles.ghost,
        variant === 'filled' && size === 26 && styles.s26,
        fullWidth && styles.fullWidth,
        className,
      )}
      {...rest}
    >
      {leadingIcon !== undefined && <span className={styles.leading}>{leadingIcon}</span>}
      <span className={clsx(styles.value, empty && styles.placeholder)}>
        {empty ? placeholder : children}
      </span>
      <ChevronDownIcon
        size={chevron.size}
        strokeWidth={chevron.stroke}
        className={styles.chevron}
      />
    </button>
  )
}

export interface SelectOption<V extends string = string> {
  value: V
  label: ReactNode
  disabled?: boolean
  /** Shown right-aligned in the menu row. */
  hint?: ReactNode
}

export interface SelectProps<V extends string = string> extends Omit<
  SelectTriggerProps,
  'onChange' | 'value' | 'children' | 'open'
> {
  value: V | null
  options: ReadonlyArray<SelectOption<V>>
  onChange: (value: V) => void
  /** Menu width; defaults to the trigger width (at least 160). */
  menuWidth?: number
}

/** Trigger + dropdown menu with a check on the current option. */
export function Select<V extends string = string>({
  value,
  options,
  onChange,
  menuWidth,
  ref,
  ...triggerProps
}: SelectProps<V>) {
  const [open, setOpen] = useState(false)
  const [via, setVia] = useState<'menu' | 'first'>('menu')
  const [width, setWidth] = useState(menuWidth ?? 160)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const mergedRef = useMergedRefs(triggerRef, ref)
  const current = options.find((o) => o.value === value)

  const show = (keyboard: boolean) => {
    setVia(keyboard ? 'first' : 'menu')
    setWidth(menuWidth ?? Math.max(160, triggerRef.current?.offsetWidth ?? 160))
    setOpen(true)
  }

  return (
    <>
      <SelectTrigger
        ref={mergedRef}
        open={open}
        onPointerDown={(e) => {
          if (e.button !== 0 || triggerProps.disabled) return
          e.preventDefault()
          if (open) setOpen(false)
          else show(false)
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            show(true)
          }
        }}
        {...triggerProps}
      >
        {current?.label}
      </SelectTrigger>
      <DropdownMenu
        open={open}
        onOpenChange={setOpen}
        anchorRef={triggerRef}
        width={width}
        autoFocus={via}
        offset={4}
      >
        {options.map((o) => (
          <MenuItem
            key={o.value}
            checked={o.value === value}
            disabled={o.disabled}
            shortcut={o.hint}
            onSelect={() => onChange(o.value)}
          >
            {o.label}
          </MenuItem>
        ))}
      </DropdownMenu>
    </>
  )
}
