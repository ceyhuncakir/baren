import { Button, CheckIcon, InfoIcon, Spinner } from '@baren/ui'
import { memo, useMemo, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { DownloadIcon } from '../components/icons'
import { updateNotice, useUpdates, type UpdateNotice } from '../state/updates'
import css from './UpdateToast.module.css'

interface CardContent {
  icon: ReactNode
  tone?: 'success' | 'danger'
  title: string
  body: ReactNode
  actions: ReactNode
}

function content(notice: UpdateNotice): CardContent {
  const { install, dismiss, check } = useUpdates.getState()
  const later = (label: string) => (
    <Button variant="ghost" size={28} className={css.later} onClick={dismiss}>
      {label}
    </Button>
  )
  switch (notice.kind) {
    case 'ready':
      return {
        icon: <DownloadIcon size={14} />,
        title: notice.version ? `Version ${notice.version} is ready` : 'An update is ready',
        body: 'Restart to update. Your files are saved.',
        actions: (
          <>
            <Button size={28} className={css.primary} onClick={install}>
              Restart
            </Button>
            {later('Later')}
          </>
        ),
      }
    case 'checking':
      return {
        icon: <Spinner size={14} />,
        title: 'Checking for updates…',
        body: 'This only takes a moment.',
        actions: null,
      }
    case 'downloading':
      return {
        icon: <DownloadIcon size={14} />,
        title: notice.version ? `Downloading version ${notice.version}` : 'Downloading update',
        body: (
          <span className={css.progressRow}>
            <span
              className={css.track}
              role="progressbar"
              aria-label="Download progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={notice.progress}
            >
              <span className={css.fill} style={{ width: `${notice.progress}%` }} />
            </span>
            <span className={css.percent}>{notice.progress}%</span>
          </span>
        ),
        actions: later('Hide'),
      }
    case 'upToDate':
      return {
        icon: <CheckIcon size={14} strokeWidth={2.25} />,
        tone: 'success',
        title: "You're up to date",
        body: notice.version
          ? `Baren ${notice.version} is the latest version.`
          : 'This is the latest version.',
        actions: null,
      }
    case 'error':
      return {
        icon: <InfoIcon size={14} strokeWidth={2.25} />,
        tone: 'danger',
        title: notice.version
          ? `Couldn't update to ${notice.version}`
          : "Couldn't check for updates",
        body: notice.message,
        actions: (
          <>
            <Button size={28} className={css.primary} onClick={() => void check()}>
              Try again
            </Button>
            {later('Close')}
          </>
        ),
      }
    case 'disabled':
      return {
        icon: <InfoIcon size={14} strokeWidth={2.25} />,
        title: 'Updates are off in this build',
        body: 'Installed releases (AppImage, deb, rpm) update themselves.',
        actions: null,
      }
  }
}

/**
 * Bottom-left card above the content area (artboard 25: 16px right of the 240px sidebar /
 * left panel, 16px from the bottom). Shows a downloaded update, and the progress and result
 * of a check the user started.
 */
export const UpdateToast = memo(function UpdateToast() {
  const inputs = useUpdates(
    useShallow((s) => ({
      status: s.status,
      appVersion: s.appVersion,
      userCheck: s.userCheck,
      laterVersion: s.laterVersion,
    })),
  )
  const notice = useMemo(() => updateNotice(inputs), [inputs])
  if (!notice) return null
  const c = content(notice)
  return (
    <div
      className={css.toast}
      role={notice.kind === 'error' ? 'alert' : 'status'}
      aria-live="polite"
      data-update-notice={notice.kind}
    >
      <span className={css.icon} data-tone={c.tone}>
        {c.icon}
      </span>
      <div className={css.content}>
        <div className={css.text}>
          <div className={css.title}>{c.title}</div>
          <div className={css.body}>{c.body}</div>
        </div>
        {c.actions && <div className={css.actions}>{c.actions}</div>}
      </div>
    </div>
  )
})
