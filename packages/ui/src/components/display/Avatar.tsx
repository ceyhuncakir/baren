import { clsx } from 'clsx'
import type { CSSProperties, HTMLAttributes, ReactNode } from 'react'
import medallionUrl from '../../assets/baren-medallion.png'
import { normalizeHex, readableOn } from '../../lib/color'
import { getInitials } from '../../lib/text'
import styles from './Avatar.module.css'

export type AvatarSize = 18 | 22 | 28 | 32 | 36

export interface AvatarProps extends HTMLAttributes<HTMLSpanElement> {
  /** Used for initials and the accessible name. */
  name?: string
  /** Overrides the computed initials. */
  initials?: string
  size?: AvatarSize
  /** Background (CSS color). Default: --color-avatar. */
  color?: string
  /** Text color; defaults to a readable color for hex backgrounds. */
  textColor?: string
  shape?: 'circle' | 'square'
  /**
   * `agent`: an MCP agent (34–36) — a rounded square in --color-agent holding the Baren
   * medallion (squares mean non-person). `idle`: an agent that is not active — --color-muted
   * with a greyed medallion.
   */
  variant?: 'solid' | 'pending' | 'muted' | 'accent' | 'agent' | 'idle'
  /** Icon instead of initials (pending invite, group, globe). */
  icon?: ReactNode
  src?: string
  /** An 8 px --color-success presence dot at the bottom-right (an active agent, 36). */
  presence?: boolean
}

const MARK_SIZE: Record<AvatarSize, number> = { 18: 12, 22: 16, 28: 20, 32: 22, 36: 24 }

const SIZE_CLASS: Record<AvatarSize, string | undefined> = {
  18: styles.s18,
  22: styles.s22,
  28: styles.s28,
  32: styles.s32,
  36: styles.s36,
}

export function Avatar({
  name,
  initials,
  size = 22,
  color,
  textColor,
  shape = 'circle',
  variant = 'solid',
  icon,
  src,
  presence = false,
  className,
  style,
  ...rest
}: AvatarProps) {
  const agent = variant === 'agent' || variant === 'idle'
  const hex = color ? normalizeHex(color) : null
  const fg = textColor ?? (hex ? readableOn(hex) : undefined)
  const vars: CSSProperties = {}
  if (color && variant === 'solid') (vars as Record<string, string>)['--avatar-bg'] = color
  if (fg && variant === 'solid') (vars as Record<string, string>)['--avatar-fg'] = fg
  return (
    <span
      role={name ? 'img' : undefined}
      aria-label={name}
      className={clsx(
        styles.avatar,
        SIZE_CLASS[size],
        shape === 'square' && styles.square,
        variant === 'pending' && styles.pending,
        variant === 'muted' && styles.muted,
        variant === 'accent' && styles.accent,
        agent && styles.agent,
        variant === 'idle' && styles.idle,
        className,
      )}
      style={{ ...vars, ...style }}
      {...rest}
    >
      {src ? (
        <img src={src} alt="" draggable={false} />
      ) : icon !== undefined ? (
        icon
      ) : agent ? (
        <img
          className={styles.mark}
          src={medallionUrl}
          alt=""
          style={{ width: MARK_SIZE[size], height: MARK_SIZE[size] }}
          draggable={false}
        />
      ) : (
        <span aria-hidden="true">{initials ?? (name ? getInitials(name) : '')}</span>
      )}
      {presence && <span className={styles.presence} aria-hidden="true" />}
    </span>
  )
}

/** Overlapping avatars (collaborators). */
export function AvatarStack({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={clsx(styles.stack, className)} {...rest} />
}
