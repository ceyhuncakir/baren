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

  // Files shared to the user's teams appear locally (imported once, then synced live).
  const signedIn = useSession((s) => s.status === 'signedIn')
  const teams = useSession((s) => s.teams)
  useEffect(() => {
    if (!signedIn || teams.length === 0 || isDesignFixture) return
    let alive = true
    void pullTeamFilesOnce(teams, { api, files: bridge.files })
      .then(({ added }) => {
        if (alive && added.length > 0) void useFiles.getState().load()
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [signedIn, teams])

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
