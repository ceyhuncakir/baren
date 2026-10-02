/**
 * Zoom chip + zoom menu (artboard 16): editable zoom level, zoom in/out/fit/selection,
 * 50/100/200 % presets and view toggles. Menu right edge aligns with the inspector's
 * content edge (12px in), 5px below the chip.
 */
import { formatZoom } from '@baren/canvas'
import { DropdownMenu, MenuInput, MenuItem, MenuSeparator, ZoomChip } from '@baren/ui'
import { useEffect, useRef, useState } from 'react'
import { formatShortcut } from '../commands/shortcutLabels'
import { useEditor, useEditorState } from '../session/context'
import type { ViewToggles } from '../session/store'

const PRESETS = [0.5, 1, 2]

function parseZoom(text: string): number | null {
  const n = Number.parseFloat(text.replace('%', '').trim())
  return Number.isFinite(n) && n > 0 ? n / 100 : null
}

export function ZoomMenu() {
  const session = useEditor()
  const { store } = session
  const zoom = useEditorState((s) => s.zoom)
  const open = useEditorState((s) => s.zoomMenuOpen)
  const hasSelection = useEditorState((s) => s.selection.length > 0)
  const toggles = useEditorState((s) => s.viewToggles)
  const chipRef = useRef<HTMLButtonElement>(null)
  const [alignOffset, setAlignOffset] = useState(0)
  const [draft, setDraft] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const label = formatZoom(zoom)
  const percent = Math.round(zoom * 100)

  const setOpen = (next: boolean) => {
    if (next) {
      const chip = chipRef.current
      const panel = chip?.closest('aside')
      if (chip && panel) {
        // Right-align with the inspector content (12px padding).
        const target = panel.getBoundingClientRect().right - 12
        setAlignOffset(chip.getBoundingClientRect().right - target)
      }
      setDraft(null)
    }
    store.setState({ zoomMenuOpen: next })
  }

  useEffect(() => {
    if (!open) return
    const id = requestAnimationFrame(() => {
      const input = inputRef.current
      if (!input) return
      input.focus({ preventScroll: true })
      input.setSelectionRange(input.value.length, input.value.length)
    })
    return () => cancelAnimationFrame(id)
  }, [open])

  const canvas = () => session.canvas.current
  const toggle = (key: keyof ViewToggles) =>
    store.setState((s) => ({ viewToggles: { ...s.viewToggles, [key]: !s.viewToggles[key] } }))

  return (
    <>
      <ZoomChip
        ref={chipRef}
        zoom={zoom * 100}
        open={open}
        aria-label={`Zoom ${label}`}
        onClick={() => setOpen(!open)}
      />
      <DropdownMenu
        open={open}
        onOpenChange={setOpen}
        anchorRef={chipRef}
        placement="bottom-end"
        offset={5}
        alignOffset={alignOffset}
        width={248}
        aria-label="Zoom"
      >
        <MenuInput
          ref={inputRef}
          value={draft ?? `${percent}%`}
          hint="Enter"
          aria-label="Zoom level"
          onChange={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return
            e.preventDefault()
            e.stopPropagation()
            const z = parseZoom(e.currentTarget.value)
            if (z !== null) canvas()?.zoomTo(z)
            setOpen(false)
          }}
        />
        <MenuItem inset shortcut={formatShortcut('Mod+=')} onSelect={() => canvas()?.zoomIn()}>
          Zoom in
        </MenuItem>
        <MenuItem inset shortcut={formatShortcut('Mod+-')} onSelect={() => canvas()?.zoomOut()}>
          Zoom out
        </MenuItem>
        <MenuItem inset shortcut={formatShortcut('Shift+1')} onSelect={() => canvas()?.zoomToFit()}>
          Zoom to fit
        </MenuItem>
        <MenuItem
          inset
          shortcut={formatShortcut('Shift+2')}
          disabled={!hasSelection}
          onSelect={() => canvas()?.zoomToSelection()}
        >
          Zoom to selection
        </MenuItem>
        <MenuSeparator />
        {PRESETS.map((p) => (
          <MenuItem
            key={p}
            checked={Math.abs(zoom - p) < 0.0005}
            shortcut={p === 1 ? formatShortcut('Mod+0') : undefined}
            onSelect={() => canvas()?.zoomTo(p)}
          >
            {Math.round(p * 100)}%
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem
          checked={toggles.pixelGrid}
          keepOpen
          shortcut={formatShortcut("Mod+'")}
          onSelect={() => toggle('pixelGrid')}
        >
          Pixel grid
        </MenuItem>
        <MenuItem checked={toggles.snapToPixel} keepOpen onSelect={() => toggle('snapToPixel')}>
          Snap to pixel grid
        </MenuItem>
        <MenuItem
          checked={toggles.rulers}
          keepOpen
          shortcut={formatShortcut('Shift+R')}
          onSelect={() => toggle('rulers')}
        >
          Rulers
        </MenuItem>
        <MenuItem
          checked={toggles.outline}
          keepOpen
          shortcut={formatShortcut('Mod+Y')}
          onSelect={() => toggle('outline')}
        >
          Outline mode
        </MenuItem>
      </DropdownMenu>
    </>
  )
}
