import { useState, type CSSProperties, type ReactNode } from 'react'
import {
  Button,
  FileCard,
  FileGrid,
  LayoutGridIcon,
  ListIcon,
  PageTitle,
  PencilIcon,
  PlusIcon,
  Segmented,
  TitleBar,
  WindowControls,
} from '../../src'
import { AppMenuBar } from '../menus'
import { BlocksThumb, HomeSidebar } from '../pages/DisplayPage'

/** Artboard 01 "Home — Recents", composed only from @baren/ui components. */
export function Screen01Home() {
  const [view, setView] = useState<'grid' | 'list'>('grid')
  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: 1440, height: 900 }}>
      <TitleBar title="Recents" menu={<AppMenuBar />} controls={<WindowControls />} />
      <div style={{ display: 'flex', flex: '1 1 0', minHeight: 0 }}>
        <HomeSidebar active="recents" />
        <main
          style={{
            display: 'flex',
            flexDirection: 'column',
            flex: '1 1 0',
            minWidth: 0,
            background: 'var(--color-background)',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '36px 56px 32px',
            }}
          >
            <PageTitle>Recents</PageTitle>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <Button leadingIcon={<PlusIcon size={14} />}>New file</Button>
              <Segmented
                variant="surface"
                itemWidth={26}
                value={view}
                onChange={setView}
                options={[
                  { value: 'grid', icon: <LayoutGridIcon size={14} />, 'aria-label': 'Grid view' },
                  { value: 'list', icon: <ListIcon size={14} />, 'aria-label': 'List view' },
                ]}
              />
            </div>
          </div>
          <div style={{ padding: '0 56px 48px' }}>
            <FileGrid>
              <FileCard
                title="Scratchpad"
                titleAccessory={<PencilIcon size={13} />}
                subtitle="Your permanent draft"
              />
              <FileCard title="Baren" subtitle="Edited just now" thumbnail={<BlocksThumb />} />
              <FileCard title="acme" subtitle="Edited 4 minutes ago" thumbnail={<ColumnsThumb />} />
              <FileCard
                title="acme darkmode"
                subtitle="Edited 28 days ago"
                thumbnail={<DarkGridThumb />}
              />
              <FileCard title="logo" subtitle="Edited 47 days ago" thumbnail={<LogoThumb />} />
              <FileCard
                title="acme – landing page"
                subtitle="Edited 41 days ago"
                thumbnail={<LandingThumb />}
              />
              <FileCard title="cv" subtitle="Edited 79 days ago" thumbnail={<CvThumb />} />
              <FileCard
                title="acme dashboard"
                subtitle="Edited 48 days ago"
                thumbnail={<DashboardThumb />}
              />
            </FileGrid>
          </div>
        </main>
      </div>
    </div>
  )
}

/* Thumbnails are canvas renders in the app; these are rough stand-ins. */

const box = (style: CSSProperties): ReactNode => <span style={{ display: 'block', ...style }} />

function ColumnsThumb() {
  const hs = [58, 30, 120, 70, 78, 100, 110, 68]
  return (
    <span style={{ display: 'flex', gap: 3, alignItems: 'flex-start', height: 142, marginTop: 20 }}>
      {hs.map((h, i) => (
        <span key={i}>{box({ width: 18, height: h, background: '#fff' })}</span>
      ))}
      <span style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {box({ width: 12, height: 10, background: '#1a1a1a' })}
        {box({ width: 12, height: 6, background: '#fff' })}
        {box({ width: 12, height: 10, background: '#1a1a1a' })}
        {box({ width: 12, height: 110, background: '#fff' })}
      </span>
    </span>
  )
}

function DarkGridThumb() {
  return (
    <span style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 30px)', gap: 4 }}>
      {Array.from({ length: 19 }, (_, i) => (
        <span key={i}>
          {box({ width: 30, height: 20, background: i % 7 === 4 ? '#262626' : '#111' })}
        </span>
      ))}
    </span>
  )
}

function LogoThumb() {
  const chip = (dark: boolean, text: string) => (
    <span
      style={{
        width: 46,
        height: 22,
        display: 'grid',
        placeItems: 'center',
        background: dark ? '#111' : '#fff',
        color: dark ? '#fff' : '#111',
        fontSize: 7,
        fontWeight: 600,
      }}
    >
      {text}
    </span>
  )
  return (
    <span style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 46px)', gap: 5 }}>
      {chip(false, 'acme')}
      {chip(false, 'acme')}
      {chip(true, 'acme')}
      {chip(true, '{io}')}
      {chip(false, '{io}')}
      <span />
      {chip(true, 'inter')}
      {chip(false, '{io}')}
    </span>
  )
}

function LandingThumb() {
  return box({ width: 44, height: 148, background: '#111' })
}

function CvThumb() {
  return box({
    width: 104,
    height: 146,
    background: '#fdf6ec',
    boxShadow: 'inset 0 0 0 1px #e6c9a3',
  })
}

function DashboardThumb() {
  return (
    <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      <span style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 26px)', gap: 4 }}>
        {Array.from({ length: 10 }, (_, i) => (
          <span key={i}>
            {box({ width: 26, height: 18, background: i === 3 ? '#8a8a8a' : '#fff' })}
          </span>
        ))}
      </span>
      {box({ width: 12, height: 140, background: '#fff' })}
    </span>
  )
}
