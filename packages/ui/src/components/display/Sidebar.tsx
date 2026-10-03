import { clsx } from 'clsx'
import {
  Fragment,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
  type Ref,
} from 'react'
import { ChevronDownIcon, MinusIcon } from '../../icons/icons'
import { Avatar } from './Avatar'
import styles from './Sidebar.module.css'

/** The 240px home sidebar column (padding 12/10, gap 12). */
export function Sidebar({ className, ...rest }: HTMLAttributes<HTMLElement>) {
  return <aside className={clsx(styles.sidebar, className)} {...rest} />
}

export interface SidebarNavProps extends HTMLAttributes<HTMLElement> {
  /** Hairline + 12px padding below (the primary nav block). */
  divided?: boolean
}

export function SidebarNav({ divided = false, className, ...rest }: SidebarNavProps) {
  return <nav className={clsx(styles.nav, divided && styles.divided, className)} {...rest} />
}

export interface NavItemProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: ReactNode
  active?: boolean
  /** Medium weight even when inactive (team heading row). */
  strong?: boolean
  /** Right after the label (e.g. a status dot). */
  trailing?: ReactNode
  /** Pushed to the far right (counts). */
  end?: ReactNode
  ref?: Ref<HTMLButtonElement>
}

/** 30px sidebar row: 15px icon (muted; foreground when active), 13px label. */
export function NavItem({
  icon,
  active = false,
  strong = false,
  trailing,
  end,
  className,
  children,
  type = 'button',
  ref,
  ...rest
}: NavItemProps) {
  return (
    <button
      ref={ref}
      type={type}
      aria-current={active ? 'page' : undefined}
      className={clsx(styles.item, strong && styles.strong, className)}
      {...rest}
    >
      {icon !== undefined && <span className={styles.icon}>{icon}</span>}
      <span className={styles.label}>{children}</span>
      {trailing !== undefined && <span className={styles.trailing}>{trailing}</span>}
      {end !== undefined && <span className={clsx(styles.trailing, styles.end)}>{end}</span>}
    </button>
  )
}

export interface AccountTriggerProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  name: string
  avatarColor?: string
  open?: boolean
  ref?: Ref<HTMLButtonElement>
}

/** "(C) ceyhun cakir ⌄" — opens the account menu (17). */
export function AccountTrigger({
  name,
  avatarColor,
  open,
  className,
  type = 'button',
  ref,
  ...rest
}: AccountTriggerProps) {
  return (
    <button
      ref={ref}
      type={type}
      aria-haspopup="menu"
      aria-expanded={open}
      className={clsx(styles.account, className)}
      {...rest}
    >
      <Avatar name={name} size={22} color={avatarColor} />
      <span className={styles.label}>{name}</span>
      <ChevronDownIcon size={14} strokeWidth={1.75} className={styles.accountChevron} />
    </button>
  )
}

export interface FooterLink {
  label: string
  onClick?: () => void
  href?: string
}

export interface FooterLinksProps extends HTMLAttributes<HTMLDivElement> {
  links: ReadonlyArray<FooterLink>
}

/** "What's new · Feedback" */
export function FooterLinks({ links, className, ...rest }: FooterLinksProps) {
  return (
    <div className={clsx(styles.footerLinks, className)} {...rest}>
      {links.map((l, i) => (
        <Fragment key={l.label}>
          {i > 0 && <span className={styles.footerDot} aria-hidden="true" />}
          {l.href ? (
            <a className={styles.footerLink} href={l.href} onClick={l.onClick}>
              {l.label}
            </a>
          ) : (
            <button type="button" className={styles.footerLink} onClick={l.onClick}>
              {l.label}
            </button>
          )}
        </Fragment>
      ))}
    </div>
  )
}

/** Flexible spacer (pushes the agents card and footer to the bottom). */
export function SidebarSpacer() {
  return <div className={styles.spacer} />
}

export interface PromoCardProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  title: ReactNode
  /** Usually a secondary Button (30px, 12px text, full width). */
  action?: ReactNode
  onDismiss?: () => void
}

/** Sidebar card: title + dismiss, 12px muted body, action button. */
export function PromoCard({
  title,
  action,
  onDismiss,
  className,
  children,
  ...rest
}: PromoCardProps) {
  return (
    <section className={clsx(styles.promo, className)} {...rest}>
      <div className={styles.promoHeader}>
        <div className={styles.promoTitle}>{title}</div>
        {onDismiss && (
          <button
            type="button"
            className={styles.promoDismiss}
            aria-label="Dismiss"
            onClick={onDismiss}
          >
            <MinusIcon size={14} strokeWidth={1.75} />
          </button>
        )}
      </div>
      <div className={styles.promoBody}>{children}</div>
      {action}
    </section>
  )
}
