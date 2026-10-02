/**
 * Inspector building blocks shared by the sections: a field that opens a menu, a paint
 * (color/token) field with picker popover and token menu, and helpers for multi values.
 */
import {
  ColorField,
  ColorPicker,
  DropdownMenu,
  FieldIconButton,
  InspectorSelect,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  Popover,
  TokensIcon,
  hexToHsva,
  hsvaToHex,
  type Hsva,
  type InspectorSelectProps,
} from '@baren/ui'
import type { Token } from '@baren/schema'
import { useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import {
  formatColor,
  parseColor,
  resolveColor,
  tokenRef,
  tokenShortName,
  type ColorValue,
} from '../model/colors'
import { MIXED, type Mixed } from '../model/styles'
import { useTokens } from '../session/context'
import css from './Inspector.module.css'

export interface MenuOption<V extends string> {
  value: V
  label: ReactNode
  shortcut?: ReactNode
  disabled?: boolean
}

export interface MenuSelectProps<V extends string> extends Omit<
  InspectorSelectProps,
  'value' | 'onChange' | 'children'
> {
  value: Mixed<V> | undefined
  options: readonly MenuOption<V>[]
  onChange: (value: V) => void
  /** Text shown in the field (defaults to the option label). */
  display?: ReactNode
  menuWidth?: number
  header?: ReactNode
}

/** InspectorSelect + dropdown with a check on the current value ("Normal ⌄", "Medium ⌄"). */
export function MenuSelect<V extends string>({
  value,
  options,
  onChange,
  display,
  menuWidth,
  header,
  ...rest
}: MenuSelectProps<V>) {
  const ref = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const current = value === MIXED ? undefined : options.find((o) => o.value === value)
  return (
    <>
      <InspectorSelect ref={ref} aria-expanded={open} onClick={() => setOpen((v) => !v)} {...rest}>
        {display ?? (value === MIXED ? 'Mixed' : (current?.label ?? ''))}
      </InspectorSelect>
      <DropdownMenu
        open={open}
        onOpenChange={setOpen}
        anchorRef={ref}
        width={menuWidth ?? Math.max(160, ref.current?.offsetWidth ?? 160)}
        offset={4}
      >
        {header}
        {options.map((o) => (
          <MenuItem
            key={o.value}
            checked={o.value === value}
            disabled={o.disabled}
            shortcut={o.shortcut}
            onSelect={() => onChange(o.value)}
          >
            {o.label}
          </MenuItem>
        ))}
      </DropdownMenu>
    </>
  )
}

/** Display state of a paint field for one or many nodes. */
export interface PaintState {
  /** The color when all nodes agree; MIXED otherwise. */
  color: Mixed<ColorValue> | null
}

export function paintFromValues(values: readonly (ColorValue | null)[]): Mixed<ColorValue> | null {
  if (values.length === 0) return null
  const keyOf = (c: ColorValue | null) =>
    c === null ? '' : c.kind === 'token' ? `t:${c.token}` : `h:${c.hex}:${c.alpha}`
  const first = values[0] ?? null
  return values.every((v) => keyOf(v) === keyOf(first)) ? first : MIXED
}

export interface PaintFieldProps {
  value: Mixed<ColorValue> | null
  /** CSS text for a new value (`#RRGGBB[AA]` or `var(--token)`); `final` false = preview. */
  onChange: (css: string, final: boolean) => void
  size?: 26 | 28
  mono?: boolean
  /** Show the token picker button (fills, page background). */
  tokens?: boolean
  /** Extra trailing control (pipette). */
  trailing?: ReactNode
  showAlpha?: boolean
}

const DEFAULT_LITERAL = { kind: 'literal', hex: '000000', alpha: 1 } as const

/**
 * Swatch + hex/token chip + opacity (ColorField), a color picker popover on the swatch and
 * an optional token menu. Token-bound values show their token chip and the blue tokens icon.
 */
export function PaintField({
  value,
  onChange,
  size = 26,
  mono = false,
  tokens: withTokens = true,
  trailing,
  showAlpha = true,
}: PaintFieldProps) {
  const tokens = useTokens()
  const rowRef = useRef<HTMLDivElement>(null)
  const tokenButtonRef = useRef<HTMLSpanElement>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [tokenMenuOpen, setTokenMenuOpen] = useState(false)
  const mixed = value === MIXED
  const color = mixed || value === null ? null : value
  const resolved = color ? resolveColor(color, tokens) : null
  const literal = resolved ?? DEFAULT_LITERAL
  const tokenName = color?.kind === 'token' ? tokenShortName(color.token) : undefined

  const [hsva, setHsva] = useState<Hsva>(
    () => hexToHsva(literal.hex, literal.alpha) ?? { h: 0, s: 0, v: 0, a: 1 },
  )
  const openPicker = () => {
    setHsva((prev) => hexToHsva(literal.hex, literal.alpha, prev.h) ?? prev)
    setPickerOpen(true)
  }

  const emitHsva = (c: Hsva, final: boolean) => onChange(formatColor(hsvaToHex(c), c.a), final)

  return (
    <div ref={rowRef} className={css.paintRow}>
      <ColorField
        size={size}
        mono={mono}
        color={mixed ? 'FFFFFF' : literal.hex}
        opacity={literal.alpha}
        {...(tokenName !== undefined ? { token: tokenName } : {})}
        onSwatchClick={openPicker}
        onColorChange={(hex) => onChange(formatColor(hex, literal.alpha), true)}
        onOpacityChange={(a) => onChange(formatColor(literal.hex, a), true)}
      />
      {withTokens && (
        <span ref={tokenButtonRef} className={css.anchor}>
          <FieldIconButton
            label={tokenName ? `Token: ${tokenName}` : 'Bind to token'}
            size={size}
            accent={tokenName !== undefined}
            aria-haspopup="menu"
            aria-expanded={tokenMenuOpen}
            onClick={() => setTokenMenuOpen((v) => !v)}
          >
            <TokensIcon size={size === 28 ? 14 : 12} />
          </FieldIconButton>
        </span>
      )}
      {trailing}
      <Popover
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        anchorRef={rowRef}
        placement="left-start"
        offset={12}
        width={240}
        aria-label="Color picker"
      >
        <div className={css.colorPopover}>
          <ColorPicker
            value={hsva}
            showAlpha={showAlpha}
            onChange={(c) => {
              setHsva(c)
              emitHsva(c, false)
            }}
            onChangeEnd={(c) => {
              setHsva(c)
              emitHsva(c, true)
            }}
          />
          <ColorField
            mono
            color={hsvaToHex(hsva)}
            opacity={hsva.a}
            onColorChange={(hex) => {
              const next = hexToHsva(hex, hsva.a, hsva.h) ?? hsva
              setHsva(next)
              emitHsva(next, true)
            }}
            onOpacityChange={(a) => {
              const next = { ...hsva, a }
              setHsva(next)
              emitHsva(next, true)
            }}
          />
        </div>
      </Popover>
      {withTokens && (
        <ColorTokenMenu
          open={tokenMenuOpen}
          onOpenChange={setTokenMenuOpen}
          anchorRef={tokenButtonRef}
          tokens={tokens}
          current={color?.kind === 'token' ? color.token : null}
          onPick={(name) => onChange(tokenRef(name), true)}
          onDetach={
            color?.kind === 'token' && resolved
              ? () => onChange(formatColor(resolved.hex, resolved.alpha), true)
              : undefined
          }
        />
      )}
    </div>
  )
}

export function ColorTokenMenu({
  open,
  onOpenChange,
  anchorRef,
  tokens,
  current,
  onPick,
  onDetach,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  anchorRef: RefObject<HTMLElement | null>
  tokens: Record<string, Token>
  current: string | null
  onPick: (name: string) => void
  onDetach: (() => void) | undefined
}) {
  const colors = useMemo(
    () =>
      Object.entries(tokens).flatMap(([name, t]) => {
        const c = parseColor(String(t.value))
        return c?.kind === 'literal' ? [{ name, hex: c.hex, alpha: c.alpha }] : []
      }),
    [tokens],
  )
  return (
    <DropdownMenu
      open={open}
      onOpenChange={onOpenChange}
      anchorRef={anchorRef}
      placement="bottom-end"
      width={220}
      aria-label="Color tokens"
    >
      <MenuLabel>Color tokens</MenuLabel>
      {colors.length === 0 && <MenuItem disabled>No color tokens</MenuItem>}
      {colors.map((c) => (
        <MenuItem
          key={c.name}
          checked={c.name === current}
          trailing={
            <span
              className={css.tokenMenuSwatch}
              style={{ background: formatColor(c.hex, c.alpha) }}
            />
          }
          onSelect={() => onPick(c.name)}
        >
          {tokenShortName(c.name)}
        </MenuItem>
      ))}
      {onDetach && (
        <>
          <MenuSeparator />
          <MenuItem onSelect={onDetach}>Detach token</MenuItem>
        </>
      )}
    </DropdownMenu>
  )
}

/** Parse a CSS color value for a paint field (null when absent/unsupported). */
export function colorOf(value: string | number | undefined): ColorValue | null {
  return typeof value === 'string' ? parseColor(value) : null
}
