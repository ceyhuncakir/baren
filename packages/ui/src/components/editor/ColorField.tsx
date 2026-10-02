import { clsx } from 'clsx'
import { useState, type HTMLAttributes } from 'react'
import { formatAlpha, normalizeHex, parseAlpha } from '../../lib/color'
import { fieldClass, Swatch, TokenChip } from './Inspector'
import styles from './Inspector.module.css'

export interface ColorFieldProps extends Omit<HTMLAttributes<HTMLDivElement>, 'color'> {
  /** Hex without '#' ("2F80FF"). */
  color: string
  /** 0..1 */
  opacity?: number
  /** When bound to a token, its name is shown as a chip instead of the hex. */
  token?: string
  onColorChange?: (hex: string) => void
  onOpacityChange?: (opacity: number) => void
  /** Swatch click: open the color picker. */
  onSwatchClick?: () => void
  /** 26 (fill rows) or 28 (page background, theme token). */
  size?: 26 | 28
  /** Theme panel shows the hex in JetBrains Mono. */
  mono?: boolean
  readOnly?: boolean
}

/** Swatch + hex (or token chip) + opacity, as in Fill (06), Page (04) and Color token (07). */
export function ColorField({
  color,
  opacity = 1,
  token,
  onColorChange,
  onOpacityChange,
  onSwatchClick,
  size = 26,
  mono = false,
  readOnly = false,
  className,
  ...rest
}: ColorFieldProps) {
  const hex = normalizeHex(color) ?? color.toUpperCase()
  const [hexDraft, setHexDraft] = useState<string | null>(null)
  const [alphaDraft, setAlphaDraft] = useState<string | null>(null)

  const commitHex = (text: string) => {
    setHexDraft(null)
    const next = normalizeHex(text)
    if (next && next !== hex) onColorChange?.(next)
  }
  const commitAlpha = (text: string) => {
    setAlphaDraft(null)
    const next = parseAlpha(text)
    if (next !== null && next !== opacity) onOpacityChange?.(next)
  }

  return (
    <div className={clsx(fieldClass({ size }), className)} {...rest}>
      <Swatch
        color={hex}
        size={size === 28 ? 14 : 12}
        onClick={onSwatchClick}
        aria-label="Open color picker"
      />
      {token !== undefined ? (
        <>
          <TokenChip>{token}</TokenChip>
          <span className={styles.grow} />
        </>
      ) : (
        <input
          className={clsx(styles.input, mono && styles.mono)}
          value={hexDraft ?? hex}
          readOnly={readOnly}
          spellCheck={false}
          maxLength={9}
          aria-label="Hex color"
          onChange={(e) => setHexDraft(e.currentTarget.value)}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={(e) => hexDraft !== null && commitHex(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              commitHex(e.currentTarget.value)
              e.currentTarget.select()
            } else if (e.key === 'Escape') {
              setHexDraft(null)
              e.currentTarget.blur()
            }
          }}
        />
      )}
      <input
        className={clsx(styles.input, styles.opacityInput)}
        value={alphaDraft ?? formatAlpha(opacity)}
        readOnly={readOnly}
        spellCheck={false}
        inputMode="numeric"
        aria-label="Opacity"
        onChange={(e) => setAlphaDraft(e.currentTarget.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={(e) => alphaDraft !== null && commitAlpha(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commitAlpha(e.currentTarget.value)
            e.currentTarget.select()
          } else if (e.key === 'Escape') {
            setAlphaDraft(null)
            e.currentTarget.blur()
          }
        }}
      />
    </div>
  )
}
