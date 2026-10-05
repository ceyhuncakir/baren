/**
 * While following a collaborator (`collab/follow`): a border in their colour around the canvas
 * and a "Following <name>" pill with a stop button at its top centre ("· Spotlight" when their
 * spotlight started the follow). While spotlighting (`collab/spotlight`): a pill in this user's
 * colour with the number of followers and a stop button.
 */
import { IconButton, normalizeHex, readableOn, XIcon } from '@baren/ui'
import type { CSSProperties } from 'react'
import { useEditor, useEditorState } from '../session/context'
import { followerCount, stopSpotlight } from './spotlight'
import css from './FollowOverlay.module.css'

function colorVars(color: string): CSSProperties {
  const hex = normalizeHex(color)
  return {
    '--follow-color': color,
    '--follow-fg': hex ? readableOn(hex) : 'var(--color-on-accent)',
  } as CSSProperties
}

export function FollowOverlay() {
  const { store } = useEditor()
  const following = useEditorState((s) => s.following)
  const spotlit = useEditorState((s) => s.followSpotlight?.userId === s.following)
  const peer = useEditorState((s) =>
    s.following === null ? undefined : s.peers.find((p) => p.userId === s.following),
  )
  const spotlight = useEditorState((s) => s.spotlight)
  if (spotlight !== null) return <SpotlightPill />
  if (following === null || !peer) return null
  return (
    <div className={css.frame} style={colorVars(peer.color)} data-testid="follow-overlay">
      <div className={css.pill} role="status">
        <span className={css.label}>
          Following {peer.name}
          {spotlit && <span className={css.detail}> · Spotlight</span>}
        </span>
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

function SpotlightPill() {
  const { store } = useEditor()
  const color = useEditorState((s) => s.self?.color ?? 'var(--color-selection)')
  const followers = useEditorState((s) =>
    followerCount(s.peers, s.self?.userId ?? s.identity?.userId ?? null),
  )
  return (
    <div className={css.top} style={colorVars(color)} data-testid="spotlight-overlay">
      <div className={css.pill} role="status">
        <span className={css.label}>
          You're spotlighting
          <span className={css.detail}> · {followers} following</span>
        </span>
        <button type="button" className={css.stopText} onClick={() => stopSpotlight(store)}>
          Stop
        </button>
      </div>
    </div>
  )
}
