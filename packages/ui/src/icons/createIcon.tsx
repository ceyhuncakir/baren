import type { ReactElement, ReactNode, Ref, SVGProps } from 'react'

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'ref'> {
  /** Rendered width and height in px (the artboards use 10–22). */
  size?: number
  strokeWidth?: number
  /** Accessible name. Without it the icon is decorative (aria-hidden). */
  label?: string
  ref?: Ref<SVGSVGElement>
}

export type IconComponent = ((props: IconProps) => ReactElement) & { displayName?: string }

interface IconOptions {
  strokeWidth?: number
  viewBox?: string
  /** Filled glyphs (brand marks, triangles) have no stroke. */
  filled?: boolean
}

/**
 * Builds an icon component from SVG children drawn on a 24×24 grid. Colors come from
 * `currentColor`; two-tone icons use `var(--icon-secondary, currentColor)` for the
 * secondary part so a parent can tint it.
 */
export function createIcon(
  name: string,
  body: ReactNode,
  options: IconOptions = {},
): IconComponent {
  const defaultStroke = options.strokeWidth ?? 2
  const viewBox = options.viewBox ?? '0 0 24 24'
  const filled = options.filled ?? false

  const Icon: IconComponent = ({ size = 16, strokeWidth = defaultStroke, label, ref, ...rest }) => (
    <svg
      ref={ref}
      width={size}
      height={size}
      viewBox={viewBox}
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? 'img' : undefined}
      focusable="false"
      {...rest}
    >
      {body}
    </svg>
  )
  Icon.displayName = name
  return Icon
}
