import { clsx } from 'clsx'
import {
  useId,
  useState,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
  type TextareaHTMLAttributes,
} from 'react'
import { EyeIcon, EyeOffIcon, SearchIcon } from '../../icons/icons'
import styles from './Input.module.css'

export interface FieldProps {
  label?: ReactNode
  /** Right side of the label row ("Forgot password?"). */
  labelAction?: ReactNode
  hint?: ReactNode
  /** `true` marks the control invalid; a node is also shown as the error message. */
  error?: ReactNode | boolean
  className?: string
  children: ReactNode
  /** id of the control, to associate the label. */
  htmlFor?: string
  hintId?: string
}

/** Label + control + hint/error column used by Input, Select and CodeInput. */
export function Field({
  label,
  labelAction,
  hint,
  error,
  className,
  children,
  htmlFor,
  hintId,
}: FieldProps) {
  const errorNode = error !== undefined && error !== false && error !== true ? error : null
  return (
    <div className={clsx(styles.field, className)}>
      {(label !== undefined || labelAction !== undefined) && (
        <div className={styles.labelRow}>
          {label !== undefined && (
            <label className={styles.label} htmlFor={htmlFor}>
              {label}
            </label>
          )}
          {labelAction !== undefined && <span className={styles.labelAction}>{labelAction}</span>}
        </div>
      )}
      {children}
      {errorNode !== null ? (
        <div id={hintId} className={styles.errorText} role="alert">
          {errorNode}
        </div>
      ) : hint !== undefined ? (
        <div id={hintId} className={styles.hint}>
          {hint}
        </div>
      ) : null}
    </div>
  )
}

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label?: ReactNode
  labelAction?: ReactNode
  hint?: ReactNode
  error?: ReactNode | boolean
  variant?: 'outline' | 'filled'
  size?: 28 | 32 | 40
  textSize?: 12 | 13
  leadingIcon?: ReactNode
  /** Content at the end of the control (role chips, units, buttons). */
  trailing?: ReactNode
  /** Password fields: eye button toggles visibility. */
  revealable?: boolean
  /** Class for the outer field column. */
  containerClassName?: string
  /** Class for the control box. */
  controlClassName?: string
  /** Extra attributes for the control box (e.g. `data-focus` / `data-hover` for specimens). */
  controlProps?: HTMLAttributes<HTMLDivElement> & { [key: `data-${string}`]: string | undefined }
  ref?: Ref<HTMLInputElement>
}

export function Input({
  label,
  labelAction,
  hint,
  error,
  variant = 'outline',
  size,
  textSize = 13,
  leadingIcon,
  trailing,
  revealable = false,
  containerClassName,
  controlClassName,
  controlProps,
  className,
  type = 'text',
  disabled,
  id,
  ref,
  ...rest
}: InputProps) {
  const autoId = useId()
  const inputId = id ?? autoId
  const hintId = `${inputId}-hint`
  const [revealed, setRevealed] = useState(false)
  const invalid = error !== undefined && error !== false
  const resolvedSize = size ?? (variant === 'filled' ? 32 : 40)
  const resolvedType = revealable ? (revealed ? 'text' : 'password') : type
  const hasDescription = hint !== undefined || (invalid && error !== true)

  const control = (
    <div
      className={clsx(
        styles.control,
        variant === 'filled' && styles.filled,
        resolvedSize === 28 ? styles.s28 : resolvedSize === 32 ? styles.s32 : styles.s40,
        textSize === 12 && styles.text12,
        controlClassName,
      )}
      data-invalid={invalid ? '' : undefined}
      data-disabled={disabled ? '' : undefined}
      {...controlProps}
      onPointerDown={(e) => {
        controlProps?.onPointerDown?.(e)
        // Clicking the padding focuses the input, like a native field.
        if (e.target === e.currentTarget) {
          e.preventDefault()
          e.currentTarget.querySelector('input')?.focus()
        }
      }}
    >
      {leadingIcon !== undefined && <span className={styles.adornment}>{leadingIcon}</span>}
      <input
        ref={ref}
        id={inputId}
        type={resolvedType}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        aria-describedby={hasDescription ? hintId : undefined}
        className={clsx(styles.input, className)}
        spellCheck={resolvedType === 'text' ? undefined : false}
        {...rest}
      />
      {trailing !== undefined && <span className={styles.adornment}>{trailing}</span>}
      {revealable && (
        <button
          type="button"
          className={styles.reveal}
          aria-label={revealed ? 'Hide password' : 'Show password'}
          aria-pressed={revealed}
          disabled={disabled}
          onClick={() => setRevealed((v) => !v)}
        >
          {revealed ? (
            <EyeOffIcon size={16} strokeWidth={1.75} />
          ) : (
            <EyeIcon size={16} strokeWidth={1.75} />
          )}
        </button>
      )}
    </div>
  )

  if (label === undefined && labelAction === undefined && !hasDescription) {
    return containerClassName ? <div className={containerClassName}>{control}</div> : control
  }
  return (
    <Field
      label={label}
      labelAction={labelAction}
      hint={hint}
      error={error}
      className={containerClassName}
      htmlFor={inputId}
      hintId={hintId}
    >
      {control}
    </Field>
  )
}

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  ref?: Ref<HTMLTextAreaElement>
}

/** Inspector multiline field (theme token description, 07). */
export function TextArea({ className, ref, ...rest }: TextAreaProps) {
  return <textarea ref={ref} className={clsx(styles.textarea, className)} {...rest} />
}

export interface SearchFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  /** 30 = home sidebar, 28 = theme token search. */
  size?: 28 | 30
  /** Hint at the end ("Ctrl F"). */
  shortcut?: ReactNode
  /** Extra trailing content (the "+" in token search). */
  trailing?: ReactNode
  containerClassName?: string
  ref?: Ref<HTMLInputElement>
}

export function SearchField({
  size = 30,
  shortcut,
  trailing,
  containerClassName,
  className,
  placeholder = 'Search',
  ref,
  ...rest
}: SearchFieldProps) {
  return (
    <div
      className={clsx(styles.search, size === 28 && styles.searchCompact, containerClassName)}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) {
          e.preventDefault()
          e.currentTarget.querySelector('input')?.focus()
        }
      }}
    >
      <SearchIcon size={size === 28 ? 13 : 14} strokeWidth={2} />
      <input
        ref={ref}
        type="search"
        placeholder={placeholder}
        className={clsx(styles.input, className)}
        spellCheck={false}
        {...rest}
      />
      {shortcut !== undefined && <span className={styles.searchShortcut}>{shortcut}</span>}
      {trailing}
    </div>
  )
}
