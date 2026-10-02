import { TitleBar, WindowControls } from '../../src'
import { EditorToolRail, Inspector06, LeftPanel06 } from '../editorParts'
import { AppMenuBar } from '../menus'

const BOARDS: Array<[string, number]> = [
  ['01 Foundations', 260],
  ['02 Actions', 150],
  ['03 Forms', 520],
  ['04 Labels & Status', 290],
  ['05 Feedback', 320],
  ['06 Navigation', 326],
  ['07 Overlays', 440],
]

/** Artboard 06 "Editor — Selection & inspector". The canvas area is a stand-in. */
export function Screen06Editor() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: 1440, height: 900 }}>
      <TitleBar title="acme" menu={<AppMenuBar />} controls={<WindowControls />} />
      <div style={{ display: 'flex', flex: '1 1 0', minHeight: 0 }}>
        <LeftPanel06 />
        <EditorToolRail />
        <CanvasStandIn />
        <Inspector06 />
      </div>
    </div>
  )
}

function CanvasStandIn() {
  return (
    <div
      style={{
        position: 'relative',
        flex: '1 1 0',
        minWidth: 0,
        background: 'var(--color-canvas)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          position: 'absolute',
          left: 24,
          top: 112,
          display: 'flex',
          alignItems: 'flex-start',
          gap: 14,
        }}
      >
        {BOARDS.map(([name, h], i) => (
          <div key={name} style={{ display: 'flex', flexDirection: 'column', gap: 5, width: 112 }}>
            <div
              style={{
                fontSize: 11,
                lineHeight: '14px',
                color: i === 2 ? 'var(--color-selection)' : 'var(--color-foreground-muted)',
                whiteSpace: 'nowrap',
              }}
            >
              {name}
            </div>
            <div
              style={{
                height: h,
                background: '#fff',
                outline: i === 2 ? '1.5px solid var(--color-selection)' : undefined,
              }}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
