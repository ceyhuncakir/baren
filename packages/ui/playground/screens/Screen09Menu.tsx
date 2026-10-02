import {
  EditorPanel,
  EmptyCanvasHint,
  FooterLinks,
  Menu,
  MenuBarItem,
  TitleBar,
  WindowControls,
} from '../../src'
import {
  EditorToolRail,
  FileHeader,
  InspectorHeader,
  McpSection,
  ModeSwitch,
  PageSection,
  PagesBlock,
} from '../editorParts'
import { FileMenuItems } from '../menus'

/**
 * Artboard 09 "Menu — File": empty editor with the File menu open. The menu is drawn
 * statically at its reference position (8, 38) so the screenshot is deterministic; the live
 * MenuBar positions it identically (title bottom + 8).
 */
export function Screen09Menu() {
  return (
    <div
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        width: 1440,
        height: 900,
      }}
    >
      <TitleBar
        title="Baren"
        menu={
          <div style={{ display: 'flex', gap: 2 }}>
            <MenuBarItem aria-expanded>File</MenuBarItem>
            <MenuBarItem>Edit</MenuBarItem>
            <MenuBarItem>View</MenuBarItem>
            <MenuBarItem>Window</MenuBarItem>
            <MenuBarItem>Help</MenuBarItem>
          </div>
        }
        controls={<WindowControls />}
      />
      <div style={{ display: 'flex', flex: '1 1 0', minHeight: 0 }}>
        <EditorPanel side="left">
          <FileHeader name="Baren" />
          <ModeSwitch />
          <PagesBlock pages={['Page 1']} active={0} />
          <div style={{ flex: '1 1 0' }} />
          <FooterLinks
            style={{ padding: '12px 14px' }}
            links={[{ label: "What's new" }, { label: 'Feedback' }]}
          />
        </EditorPanel>
        <EditorToolRail />
        <div
          style={{
            display: 'flex',
            flex: '1 1 0',
            minWidth: 0,
            alignItems: 'center',
            justifyContent: 'center',
            background: 'var(--color-canvas)',
          }}
        >
          <EmptyCanvasHint />
        </div>
        <EditorPanel side="right">
          <InspectorHeader zoom={100} />
          <PageSection />
          <McpSection />
        </EditorPanel>
      </div>
      <Menu
        width={248}
        style={{ position: 'absolute', left: 8, top: 38, zIndex: 10 }}
        aria-label="File"
      >
        <FileMenuItems highlight />
      </Menu>
    </div>
  )
}
