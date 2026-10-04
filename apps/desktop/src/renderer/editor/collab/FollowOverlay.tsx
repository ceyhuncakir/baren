/**
 * While following a collaborator (`collab/follow`): a border in their colour around the canvas
 * and a "Following <name>" pill with a stop button at its top centre.
 */
import { IconButton, normalizeHex, readableOn, XIcon } from '@baren/ui'
import type { CSSProperties } from 'react'
import { useEditor, useEditorState } from '../session/context'
import css from './FollowOverlay.module.css'

export function FollowOverlay() {
  const { store } = useEditor()
  const following = useEditorState((s) => s.following)
  const peer = useEditorState((s) =>
    s.following === null ? undefined : s.peers.find((p) => p.userId === s.following),
  )
  if (following === null || !peer) return null
  const hex = normalizeHex(peer.color)
  const vars = {
    '--follow-color': peer.color,
    '--follow-fg': hex ? readableOn(hex) : 'var(--color-on-accent)',
  } as CSSProperties
  return (
    <div className={css.frame} style={vars} data-testid="follow-overlay">
      <div className={css.pill} role="status">
        <span className={css.label}>Following {peer.name}</span>
        <IconButton
          label={`Stop following ${peer.name}`}
          size={20}
          radius="sm"
          bare
          className={css.stop}
          onClick={() => store.setState({ following: null })}
        >
          <XIcon size={12} strokeWidth={2} />
        </IconButton>
      </div>
    </div>
  )
}
