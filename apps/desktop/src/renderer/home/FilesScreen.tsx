import {
  Button,
  LayoutGridIcon,
  ListIcon,
  PageTitle,
  PlusIcon,
  Segmented,
  Spinner,
  type SegmentedOption,
  toast,
} from '@baren/ui'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocation } from 'wouter'
import { paths, type HomeView } from '../app/routes'
import { api, errorMessage } from '../lib/api'
import { bridge } from '../lib/bridge'
import { isDesignFixture } from '../lib/fixture'
import { signalAppReady } from '../lib/ready'
import { autoShareTeam, shareLocalFilesOnce } from '../state/autoShare'
import { selectView } from '../state/fileViews'
import { useFiles } from '../state/files'
import { useSession } from '../state/session'
import { pullTeamFilesOnce } from '../state/teamFiles'
import { useUi, type ViewMode } from '../state/ui'
import { FileActions, type FileMenuState } from './FileActions'
import { toCards } from './fileCards'
import { FileGridView } from './FileGridView'
import { FileListView } from './FileListView'
import css from './Files.module.css'

const TITLES: Record<HomeView, string> = { recents: 'Recents', files: 'Files', archive: 'Archive' }

/** How often an open home screen syncs the team files (up and down). */
const TEAM_FILES_POLL_MS = 10_000

/** Images of a file shared from Home (lazy: reading the snapshot needs Loro). */
async function uploadAssets(remoteId: string, snapshot: Uint8Array): Promise<void> {
  const { uploadFileAssets } = await import('../state/uploadFileAssets')
  await uploadFileAssets(remoteId, snapshot)
}

const VIEW_OPTIONS: ReadonlyArray<SegmentedOption<ViewMode>> = [
  { value: 'grid', icon: <LayoutGridIcon size={14} />, 'aria-label': 'Grid view' },
  { value: 'list', icon: <ListIcon size={14} />, 'aria-label': 'List view' },
]

function EmptyState({ view, query }: { view: HomeView; query: string }) {
  let title: string
  let body: string
  if (query.trim()) {
    title = `No files match “${query.trim()}”`
    body = 'Try a different name, or clear the search.'
  } else if (view === 'archive') {
    title = 'Nothing archived'
    body = 'Files you move to the archive show up here.'
  } else {
    title = 'No files yet'
    body = 'Create a file to start designing.'
  }
  return (
    <div className={css.empty} role="status">
      <p className={css.emptyTitle}>{title}</p>
      <p className={css.emptyBody}>{body}</p>
    </div>
  )
}

/** Recents (artboard 01), Files and Archive: header, then the virtualized grid or list. */
export function FilesScreen({ view }: { view: HomeView }) {
  const [, navigate] = useLocation()
  const status = useFiles((s) => s.status)
  const error = useFiles((s) => s.error)
  const files = useFiles((s) => s.files)
  const mru = useFiles((s) => s.mru)
  const scratchpadId = useFiles((s) => s.scratchpadId)
  const query = useUi((s) => s.search)
  const viewMode = useUi((s) => s.viewMode)
  const setViewMode = useUi((s) => s.setViewMode)
  const [menu, setMenu] = useState<FileMenuState | null>(null)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    void useFiles.getState().load()
  }, [])

  // Team files both ways: local files go up into the current team (autoShare.ts), and files
  // shared to the user's teams come down (imported once, then synced live). The server does
  // not announce new team files, so this runs on open, when the window comes back and every
  // TEAM_FILES_POLL_MS while it is visible: a teammate's new file shows up on its own.
  const signedIn = useSession((s) => s.status === 'signedIn')
  const teams = useSession((s) => s.teams)
  const currentTeamId = useSession((s) => s.currentTeamId)
  useEffect(() => {
    if (!signedIn || teams.length === 0 || isDesignFixture) return
    let alive = true
    const shareTo = autoShareTeam(teams, currentTeamId)
    const sync = async () => {
      let changed = false
      if (shareTo) {
        const { shared } = await shareLocalFilesOnce(shareTo.id, useFiles.getState().scratchpadId, {
          api,
          files: bridge.files,
          uploadAssets,
        })
        changed = shared > 0
      }
      const { added } = await pullTeamFilesOnce(teams, { api, files: bridge.files })
      if (alive && (changed || added.length > 0)) void useFiles.getState().load()
    }
    const run = () => {
      if (document.visibilityState !== 'hidden') void sync().catch(() => undefined)
    }
    run()
    const timer = window.setInterval(run, TEAM_FILES_POLL_MS)
    window.addEventListener('focus', run)
    document.addEventListener('visibilitychange', run)
    return () => {
      alive = false
      window.clearInterval(timer)
      window.removeEventListener('focus', run)
      document.removeEventListener('visibilitychange', run)
    }
  }, [signedIn, teams, currentTeamId])

  useEffect(() => {
    if (status === 'ready' || status === 'error') signalAppReady()
  }, [status])

  const cards = useMemo(
    () => toCards(selectView(files, view, { mru, scratchpadId, query })),
    [files, view, mru, scratchpadId, query],
  )

  const open = useCallback(
    async (fileId: string | null) => {
      try {
        const id = fileId ?? (await useFiles.getState().ensureScratchpad())
        useFiles.getState().markOpened(id)
        navigate(paths.file(id))
      } catch (e) {
        toast(errorMessage(e))
      }
    },
    [navigate],
  )

  const createFile = async () => {
    setCreating(true)
    try {
      const meta = await useFiles.getState().create('Untitled')
      useFiles.getState().markOpened(meta.id)
      navigate(paths.file(meta.id))
    } catch (e) {
      toast(errorMessage(e))
    } finally {
      setCreating(false)
    }
  }

  const onMenu = useCallback(
    (fileId: string, x: number, y: number) => setMenu({ fileId, x, y }),
    [],
  )
  const closeMenu = useCallback(() => setMenu(null), [])
  const openFromMenu = useCallback((id: string) => void open(id), [open])

  let content
  if (status === 'idle' || status === 'loading') {
    content = (
      <div className={css.loading} aria-busy="true">
        <Spinner size={16} />
      </div>
    )
  } else if (status === 'error') {
    content = (
      <div className={css.empty} role="alert">
        <p className={css.emptyTitle}>Couldn't load your files</p>
        <p className={css.emptyBody}>{error}</p>
        <Button variant="outline" size={30} onClick={() => void useFiles.getState().load()}>
          Try again
        </Button>
      </div>
    )
  } else if (cards.length === 0) {
    content = <EmptyState view={view} query={query} />
  } else if (viewMode === 'list') {
    content = <FileListView cards={cards} onOpen={open} onMenu={onMenu} />
  } else {
    content = <FileGridView cards={cards} onOpen={open} onMenu={onMenu} />
  }

  return (
    <section className={css.screen} aria-label={TITLES[view]}>
      <header className={css.header}>
        <PageTitle>{TITLES[view]}</PageTitle>
        <div className={css.headerActions}>
          {view !== 'archive' && (
            <Button
              leadingIcon={<PlusIcon size={14} />}
              loading={creating}
              onClick={() => void createFile()}
            >
              New file
            </Button>
          )}
          <Segmented
            variant="surface"
            itemWidth={26}
            aria-label="Layout"
            value={viewMode}
            onChange={setViewMode}
            options={VIEW_OPTIONS}
          />
        </div>
      </header>
      {content}
      <FileActions
        menu={menu}
        onCloseMenu={closeMenu}
        onOpen={openFromMenu}
        scratchpadId={scratchpadId}
      />
    </section>
  )
}
