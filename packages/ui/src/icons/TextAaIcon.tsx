import type { CSSProperties, HTMLAttributes } from 'react'

export interface TextAaIconProps extends HTMLAttributes<HTMLSpanElement> {
  /**
   * Font size in px. The tool rail uses 15 (regular, line 18); layer and token rows use 10
   * (semibold, line 12).
   */
  size?: number
  weight?: 400 | 500 | 600
}

/** The "Aa" text glyph used as the text tool and the text layer/token type icon. */
export function TextAaIcon({ size = 15, weight, style, ...rest }: TextAaIconProps) {
  const s: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily: 'var(--font-sans)',
    fontSize: size,
    lineHeight: `${size >= 14 ? Math.round(size * 1.2) : size + 2}px`,
    fontWeight: weight ?? (size >= 14 ? 400 : 600),
    color: 'currentColor',
    letterSpacing: 0,
    whiteSpace: 'nowrap',
    ...style,
  }
  return (
    <span aria-hidden="true" style={s} {...rest}>
      Aa
    </span>
  )
}
