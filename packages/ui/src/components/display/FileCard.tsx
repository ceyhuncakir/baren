import { clsx } from 'clsx'
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode, Ref } from 'react'
import styles from './FileCard.module.css'

/** Card height in the Recents grid (for virtualized rows). */
export const FILE_CARD_HEIGHT = 226
export const FILE_GRID_GAP = 20

export interface FileCardProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title'> {
  title: ReactNode
  /** "Edited 4 minutes ago" */
  subtitle?: ReactNode
  /** Icon after the title (pencil on the Scratchpad card). */
  titleAccessory?: ReactNode
  /** Thumbnail content (an <img>, or a placeholder). Empty = plain canvas. */
  thumbnail?: ReactNode
  selected?: boolean
  ref?: Ref<HTMLButtonElement>
}

export function FileCard({
  title,
  subtitle,
  titleAccessory,
  thumbnail,
  selected = false,
  className,
  type = 'button',
  ref,
  ...rest
}: FileCardProps) {
  return (
    <button
      ref={ref}
      type={type}
      className={clsx(styles.card, className)}
      data-selected={selected ? '' : undefined}
      aria-pressed={selected || undefined}
      {...rest}
    >
      <span className={styles.meta}>
        <span className={styles.titleRow}>
          <span className={styles.title}>{title}</span>
          {titleAccessory !== undefined && (
            <span className={styles.titleIcon}>{titleAccessory}</span>
          )}
        </span>
        {subtitle !== undefined && <span className={styles.subtitle}>{subtitle}</span>}
      </span>
      <span className={styles.thumb}>{thumbnail}</span>
    </button>
  )
}

/** Responsive grid: 4 columns of 257px at the 1088px Recents content width. */
export function FileGrid({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={clsx(styles.grid, className)} {...rest} />
}
