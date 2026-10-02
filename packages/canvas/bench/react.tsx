import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { createEmptyDoc, createNode, getChildIds } from '@baren/schema'
import { DesignCanvas } from '../src/react.tsx'
import type { CanvasController } from '../src/index.ts'

/** Harness for the React wrapper (tests/e2e/react.spec.ts). */

const doc = createEmptyDoc('React', { peerId: 3 })
const page1 = getChildIds(doc, null)[0] as string
const page2 = createNode(doc, { type: 'page', parentId: null, name: 'Page 2' })
createNode(doc, {
  type: 'frame',
  parentId: page1,
  name: 'One',
  styles: { left: 0, top: 0, width: 200, height: 100, backgroundColor: '#fff' },
})
createNode(doc, {
  type: 'frame',
  parentId: page2,
  name: 'Two',
  styles: { left: 0, top: 0, width: 300, height: 100, backgroundColor: '#fff' },
})

const state = {
  ready: [] as (CanvasController | null)[],
  renders: 0,
  selections: [] as string[][],
  ref: null as CanvasController | null,
}

let setPage: (id: string) => void = () => {}
let setMounted: (m: boolean) => void = () => {}
let setLabel: (s: string) => void = () => {}

function App() {
  const [pageId, setPageId] = useState(page1)
  const [mounted, setM] = useState(true)
  const [label, setL] = useState('a')
  setPage = setPageId
  setMounted = setM
  setLabel = setL
  state.renders++
  if (!mounted) return null
  return (
    <DesignCanvas
      doc={doc}
      pageId={pageId}
      style={{ width: 800, height: 600 }}
      ref={(c) => {
        state.ref = c
      }}
      onReady={(c) => state.ready.push(c)}
      // A new closure every render: the wrapper must use the latest one without re-creating the canvas.
      onSelectionChange={(ids) => state.selections.push([label, ...ids])}
    />
  )
}

createRoot(document.getElementById('app') as HTMLElement).render(<App />)

const api = {
  doc,
  page1,
  page2,
  state,
  setPage: (id: string) => flushSync(() => setPage(id)),
  unmount: () => flushSync(() => setMounted(false)),
  setLabel: (s: string) => flushSync(() => setLabel(s)),
}

declare global {
  interface Window {
    __react: typeof api
  }
}
window.__react = api
