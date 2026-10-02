import { clsx } from 'clsx'
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
} from 'react'
import { CheckIcon, MinusIcon } from '../../icons/icons'
import { useMergedRefs } from '../../lib/refs'
import styles from './Checkbox.module.css'

export interface CheckboxProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'size' | 'type' | 'onChange'
> {
  label?: ReactNode
  description?: ReactNode
  /** Inspector rows show a shortcut after the label ("Alt+C"). */
  shortcut?: ReactNode
  /** md: 16px box (forms); sm: 14px box, 11px label (inspector). */
  size?: 'sm' | 'md'
  /** 'muted' renders 12px muted text, top-aligned. */
  tone?: 'default' | 'muted'
  indeterminate?: boolean
  onCheckedChange?: (checked: boolean) => void
  onChange?: InputHTMLAttributes<HTMLInputElement>['onChange']
  ref?: Ref<HTMLInputElement>
}

/** Native checkbox (keyboard + forms for free) with the designed box drawn next to it. */
export function Checkbox({
  label,
  description,
  shortcut,
  size = 'md',
  tone = 'default',
  indeterminate = false,
  onCheckedChange,
  onChange,
  className,
  ref,
  ...rest
}: CheckboxProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const mergedRef = useMergedRefs(inputRef, ref)
  useEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = indeterminate
  }, [indeterminate])

  return (
    <label
      className={clsx(
        styles.root,
        size === 'sm' && styles.sm,
        tone === 'muted' && styles.top,
        className,
      )}
    >
      <input
        ref={mergedRef}
        type="checkbox"
        className={styles.native}
        onChange={(e) => {
          onChange?.(e)
          onCheckedChange?.(e.currentTarget.checked)
        }}
        {...rest}
      />
      <span className={styles.box} aria-hidden="true">
        {indeterminate ? (
          <MinusIcon size={10} strokeWidth={3.5} className={styles.mark} />
        ) : (
          <CheckIcon size={10} strokeWidth={3.5} className={styles.mark} />
        )}
      </span>
      {(label !== undefined || description !== undefined) && (
        <span className={clsx(styles.text, tone === 'muted' && styles.mutedText)}>
          {label}
          {shortcut !== undefined && <span className={styles.shortcut}>{shortcut}</span>}
          {description !== undefined && <span className={styles.description}>{description}</span>}
        </span>
      )}
    </label>
  )
}

interface RadioGroupContextValue {
  name: string
  value: string | null
  onChange: (value: string) => void
  disabled: boolean
}

const RadioGroupContext = createContext<RadioGroupContextValue | null>(null)

export interface RadioGroupProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onChange'> {
  value: string | null
  onValueChange: (value: string) => void
  name?: string
  orientation?: 'vertical' | 'horizontal'
  disabled?: boolean
}

export function RadioGroup({
  value,
  onValueChange,
  name,
  orientation = 'vertical',
  disabled = false,
  className,
  children,
  ...rest
}: RadioGroupProps) {
  const autoName = useId()
  return (
    <RadioGroupContext.Provider
      value={{ name: name ?? autoName, value, onChange: onValueChange, disabled }}
    >
      <div
        role="radiogroup"
        className={clsx(styles.group, orientation === 'horizontal' && styles.groupRow, className)}
        {...rest}
      >
        {children}
      </div>
    </RadioGroupContext.Provider>
  )
}

export interface RadioProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'size' | 'type' | 'value'
> {
  value: string
  label?: ReactNode
  description?: ReactNode
  ref?: Ref<HTMLInputElement>
}

export function Radio({
  value,
  label,
  description,
  className,
  disabled,
  onChange,
  ref,
  ...rest
}: RadioProps) {
  const group = useContext(RadioGroupContext)
  const checked = group ? group.value === value : rest.checked
  return (
    <label className={clsx(styles.root, styles.radio, className)}>
      <input
        ref={ref}
        type="radio"
        className={styles.native}
        value={value}
        name={group?.name ?? rest.name}
        checked={checked}
        disabled={disabled ?? group?.disabled}
        onChange={(e) => {
          onChange?.(e)
          if (e.currentTarget.checked) group?.onChange(value)
        }}
        {...rest}
      />
      <span className={styles.box} aria-hidden="true" />
      {(label !== undefined || description !== undefined) && (
        <span className={styles.text}>
          {label}
          {description !== undefined && <span className={styles.description}>{description}</span>}
        </span>
      )}
    </label>
  )
}
