import { clsx } from 'clsx'
import type { HTMLAttributes, ReactNode } from 'react'
import markUrl from '../../assets/baren-mark.png'
import { InfoIcon } from '../../icons/icons'
import styles from './Brand.module.css'

export interface LogoMarkProps extends HTMLAttributes<HTMLSpanElement> {
  size?: 18 | 26
}

/** The Baren seal. */
export function LogoMark({ size = 18, className, ...rest }: LogoMarkProps) {
  return (
    <span
      role="img"
      aria-label="Baren"
      className={clsx(styles.mark, size === 26 ? styles.mark26 : styles.mark18, className)}
      {...rest}
    >
      <img src={markUrl} alt="" aria-hidden="true" draggable={false} className={styles.markImage} />
    </span>
  )
}

/** Mark + "Baren" (auth panel header). */
export function BrandLockup({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={clsx(styles.lockup, className)} {...rest}>
      <LogoMark size={26} aria-hidden="true" aria-label={undefined} role={undefined} />
      <span className={styles.wordmark}>Baren</span>
    </div>
  )
}

/** 48px rounded tile holding a 22px icon (verify email, continue in browser). */
export function IconTile({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={clsx(styles.tile, className)} {...rest} />
}

export interface CalloutProps extends HTMLAttributes<HTMLDivElement> {
  icon?: ReactNode
}

/** Surface note with an info icon (20). */
export function Callout({ icon, className, children, ...rest }: CalloutProps) {
  return (
    <div className={clsx(styles.callout, className)} {...rest}>
      <span className={styles.calloutIcon}>{icon ?? <InfoIcon size={14} strokeWidth={2} />}</span>
      <div>{children}</div>
    </div>
  )
}

export interface HeadingProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  title: ReactNode
  lead?: ReactNode
}

/** Auth step heading: 28px title + 14px muted lead. */
export function AuthHeading({ title, lead, className, ...rest }: HeadingProps) {
  return (
    <div className={clsx(styles.heading, className)} {...rest}>
      <h1 className={styles.headingTitle}>{title}</h1>
      {lead !== undefined && <p className={styles.headingLead}>{lead}</p>}
    </div>
  )
}

export interface PageTitleProps extends HTMLAttributes<HTMLHeadingElement> {
  /** 22px (Recents) or 24px (Team settings). */
  size?: 22 | 24
}

export function PageTitle({ size = 22, className, ...rest }: PageTitleProps) {
  return (
    <h1
      className={clsx(styles.pageTitle, size === 24 && styles.pageTitleLg, className)}
      {...rest}
    />
  )
}
