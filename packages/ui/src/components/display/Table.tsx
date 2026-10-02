import { clsx } from 'clsx'
import type { ButtonHTMLAttributes, CSSProperties, HTMLAttributes, ReactNode } from 'react'
import { SortDownIcon } from '../../icons/icons'
import styles from './Table.module.css'

export interface TableProps extends HTMLAttributes<HTMLDivElement> {
  /** CSS grid-template-columns shared by every row. Members: "1fr 160px 160px 32px". */
  columns?: string
}

export function Table({ columns, className, style, ...rest }: TableProps) {
  return (
    <div
      role="table"
      className={clsx(styles.table, className)}
      style={columns ? ({ '--table-columns': columns, ...style } as CSSProperties) : style}
      {...rest}
    />
  )
}

export function TableHeader({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div role="row" className={clsx(styles.row, styles.header, className)} {...rest} />
}

export interface TableHeaderCellProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Shows the sort caret; clicking calls onClick. */
  sort?: 'asc' | 'desc' | null
}

export function TableHeaderCell({
  sort,
  className,
  children,
  onClick,
  type = 'button',
  ...rest
}: TableHeaderCellProps) {
  const content = (
    <>
      {children}
      {sort && <SortDownIcon size={12} className={sort === 'asc' ? styles.sortAsc : undefined} />}
    </>
  )
  if (onClick || sort !== undefined) {
    return (
      <button
        type={type}
        role="columnheader"
        aria-sort={sort === 'asc' ? 'ascending' : sort === 'desc' ? 'descending' : undefined}
        className={clsx(styles.headerCell, className)}
        onClick={onClick}
        {...rest}
      >
        {content}
      </button>
    )
  }
  return (
    <div role="columnheader" className={clsx(styles.headerCell, className)}>
      {content}
    </div>
  )
}

export function TableRow({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div role="row" className={clsx(styles.row, className)} {...rest} />
}

export function TableCell({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div role="cell" className={clsx(styles.cell, className)} {...rest} />
}

export interface MemberCellProps extends HTMLAttributes<HTMLDivElement> {
  avatar: ReactNode
  name: ReactNode
  /** "(you)" */
  suffix?: ReactNode
  /** Badge after the name ("Invited"). */
  badge?: ReactNode
  /** Email or "Resend invite · Revoke". */
  secondary?: ReactNode
}

/** Avatar (36) + name/email stack (02). */
export function MemberCell({
  avatar,
  name,
  suffix,
  badge,
  secondary,
  className,
  ...rest
}: MemberCellProps) {
  return (
    <div role="cell" className={clsx(styles.member, className)} {...rest}>
      {avatar}
      <div className={styles.memberText}>
        <div className={styles.memberNameRow}>
          <span className={styles.memberName}>{name}</span>
          {suffix !== undefined && <span className={styles.memberSuffix}>{suffix}</span>}
          {badge}
        </div>
        {secondary !== undefined && <div className={styles.memberSub}>{secondary}</div>}
      </div>
    </div>
  )
}

export interface PersonRowProps extends HTMLAttributes<HTMLDivElement> {
  avatar: ReactNode
  name: ReactNode
  secondary?: ReactNode
  /** 76px right column ("Owner", role select). */
  trailing?: ReactNode
}

/** Compact person row used in the share popover (08). */
export function PersonRow({
  avatar,
  name,
  secondary,
  trailing,
  className,
  ...rest
}: PersonRowProps) {
  return (
    <div className={clsx(styles.personRow, className)} {...rest}>
      {avatar}
      <div className={styles.personText}>
        <div className={styles.personName}>{name}</div>
        {secondary !== undefined && <div className={styles.personSub}>{secondary}</div>}
      </div>
      {trailing !== undefined && <div className={styles.personTrailing}>{trailing}</div>}
    </div>
  )
}
