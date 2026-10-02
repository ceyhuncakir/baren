import type { ReactNode } from 'react'
import { HomeSidebar, type SidebarItem } from './HomeSidebar'
import css from './Home.module.css'

/** Sidebar + content. Rendered at the same tree position for every home/team route, so the
 * sidebar (and its search field) survives navigation between them. */
export function HomeLayout({ active, children }: { active: SidebarItem; children: ReactNode }) {
  return (
    <div className={css.home}>
      <HomeSidebar active={active} />
      <div className={css.main}>{children}</div>
    </div>
  )
}
