/**
 * "Connect your agent" (artboards 34 / D34; Phase 4 contract §10.1): the app-level dialog for
 * the built-in MCP server, opened from the inspector's MCP section, the home "Using agents" card
 * and Preferences. Five blocks: header; the server row with its Switch; setup (client segments,
 * the snippet with the masked token, Reveal, Copy, Regenerate token); what agents can do; the
 * footer with the connection status, Learn more and Done.
 *
 * The token is fetched with `bridge.mcp.setup()` when the dialog opens (and after a regenerate),
 * kept in this component's state only and dropped when it closes.
 */
import {
  Button,
  CheckIcon,
  CopyIcon,
  cx,
  EyeIcon,
  EyeOffIcon,
  IconButton,
  LayersIcon,
  LockIcon,
  PenLineIcon,
  ResetIcon,
  Segmented,
  ServerIcon,
  StatusDot,
  Switch,
  toast,
  Undo2Icon,
  useStableCallback,
  XIcon,
} from '@baren/ui'
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { buildSetup } from '../../main/mcp/setup'
import { bridge } from '../lib/bridge'
import { copyText } from '../lib/clipboard'
import { LINKS } from '../lib/links'
import {
  dialogStatusLine,
  MCP_CLIENTS,
  maskSnippet,
  readMcpClient,
  snippetFor,
  useMcp,
  useMcpStatus,
  writeMcpClient,
  type McpClient,
} from '../state/mcp'
import type { McpSetup, McpStatus } from '../types/bridge'
import css from './McpConnectDialog.module.css'

const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

/** How long Copy shows its check mark. */
const COPIED_MS = 1500
/** Shown instead of a token while the server is not running (nothing to copy). */
const NO_TOKEN = '••••••••••••'

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Writes the system clipboard through the bridge, falling back to the web API. */
async function copy(text: string): Promise<boolean> {
  try {
    await bridge.clipboard.write({ text })
    return true
  } catch {
    return copyText(text)
  }
}

/** Snippets to show while there is no live setup (server off, starting or failed). */
function placeholderSetup(status: McpStatus | null): McpSetup {
  const url = status?.url ?? `http://127.0.0.1:${status?.port ?? 29170}/mcp`
  return buildSetup({ url, token: NO_TOKEN, command: 'Baren', args: ['<shim>'] })
}

function useCopied(): [boolean, () => void] {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), [])
  return [
    copied,
    () => {
      setCopied(true)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), COPIED_MS)
    },
  ]
}

function CodeBlock({
  text,
  copyValue,
  reveal,
  label,
}: {
  /** What is shown (the token masked unless revealed). */
  text: string
  /** What Copy writes (always unmasked); null disables Copy. */
  copyValue: string | null
  reveal?: { revealed: boolean; toggle: () => void } | undefined
  label: string
}) {
  const [copied, markCopied] = useCopied()
  return (
    <div className={css.code} role="group" aria-label={label}>
      <pre className={cx(css.codeText, 'selectable')}>{text}</pre>
      <div className={css.codeActions}>
        {reveal && (
          <IconButton
            label={reveal.revealed ? 'Hide token' : 'Reveal token'}
            size={26}
            radius="sm"
            className={css.reveal}
            disabled={copyValue === null}
            onClick={reveal.toggle}
          >
            {reveal.revealed ? (
              <EyeOffIcon size={14} strokeWidth={1.75} />
            ) : (
              <EyeIcon size={14} strokeWidth={1.75} />
            )}
          </IconButton>
        )}
        <IconButton
          label={copied ? 'Copied' : 'Copy'}
          size={26}
          radius="sm"
          tone="default"
          className={css.copy}
          disabled={copyValue === null}
          onClick={() => {
            if (copyValue === null) return
            void copy(copyValue).then((ok) => {
              if (ok) markCopied()
              else toast("Couldn't copy to the clipboard")
            })
          }}
        >
          {copied ? (
            <CheckIcon size={14} strokeWidth={2} />
          ) : (
            <CopyIcon size={14} strokeWidth={1.75} />
          )}
        </IconButton>
      </div>
    </div>
  )
}

function Capability({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className={css.capability}>
      <span className={css.capabilityIcon} aria-hidden="true">
        {icon}
      </span>
      <span>{children}</span>
    </div>
  )
}

export default function McpConnectDialog({ onClose }: { onClose: () => void }) {
  if (typeof document === 'undefined') return null
  return createPortal(<OpenMcpDialog onClose={onClose} />, document.body)
}

function OpenMcpDialog({ onClose }: { onClose: () => void }) {
  const status = useMcpStatus()
  const switching = useMcp((s) => s.switching)
  const setEnabled = useMcp((s) => s.setEnabled)
  const [client, setClient] = useState<McpClient>(readMcpClient)
  const [setup, setSetup] = useState<McpSetup | null>(null)
  const [revealed, setRevealed] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [regenerating, setRegenerating] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const descriptionId = useId()
  const switchLabelId = useId()
  const close = useStableCallback(onClose)

  const running = status?.state === 'running' && status.enabled
  const on = status ? status.enabled && status.state !== 'off' : true
  const url = status?.url ?? null

  // The token and snippets: fetched while the server runs (again when its address changes).
  useEffect(() => {
    if (!running) return
    let live = true
    bridge.mcp
      .setup()
      .then((s) => {
        if (live) setSetup(s)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [running, url])

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    panelRef.current?.focus({ preventScroll: true })
    return () => {
      if (previous?.isConnected) previous.focus({ preventScroll: true })
    }
  }, [])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && !e.defaultPrevented) {
      e.preventDefault()
      e.stopPropagation()
      if (confirming) setConfirming(false)
      else close()
      return
    }
    if (e.key !== 'Tab') return
    const panel = panelRef.current
    if (!panel) return
    const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (el) => !el.closest('[inert]'),
    )
    const first = items[0]
    const last = items[items.length - 1]
    if (!first || !last) return
    if (e.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  const regenerate = async () => {
    setRegenerating(true)
    try {
      const next = await bridge.mcp.resetToken()
      setSetup(next)
      setConfirming(false)
      toast('Token regenerated. Update your agents with the new snippet.')
    } catch (error) {
      toast(errorText(error))
    } finally {
      setRegenerating(false)
    }
  }

  const live = running ? setup : null
  const shown = live ?? placeholderSetup(status)
  const snippet = snippetFor(shown, client)
  const display = live && !revealed ? maskSnippet(snippet, live.token) : snippet
  const meta = MCP_CLIENTS.find((c) => c.value === client) ?? MCP_CLIENTS[0]
  const footer = dialogStatusLine(status)

  return (
    <div
      className={css.backdrop}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        className={css.panel}
        data-testid="mcp-dialog"
        onKeyDown={onKeyDown}
      >
        <div className={css.header}>
          <div className={css.titleRow}>
            <h2 id={titleId} className={css.title}>
              Connect your agent
            </h2>
            <IconButton label="Close" size={24} radius="sm" onClick={close}>
              <XIcon size={14} strokeWidth={2} />
            </IconButton>
          </div>
          <p id={descriptionId} className={css.description}>
            Let coding agents like Claude Code, Cursor and Codex read and edit your files live,
            through the MCP server built into baren.
          </p>
        </div>

        <div className={css.server}>
          <span className={css.serverIcon} aria-hidden="true">
            <ServerIcon size={14} />
          </span>
          <div className={css.serverText}>
            <div id={switchLabelId} className={css.serverName}>
              MCP server
            </div>
            <div className={css.serverDetail}>
              {on ? 'On · Only apps on this computer can connect' : "Off · Agents can't connect"}
            </div>
          </div>
          <Switch
            checked={on}
            aria-labelledby={switchLabelId}
            disabled={switching || status === null}
            onCheckedChange={(next) => {
              setConfirming(false)
              void setEnabled(next).catch((error: unknown) => toast(errorText(error)))
            }}
          />
        </div>

        <div className={cx(css.setup, !on && css.dimmed)} inert={!on} data-testid="mcp-setup">
          <Segmented
            fullWidth
            aria-label="Agent"
            options={MCP_CLIENTS.map((c) => ({ value: c.value, label: c.label }))}
            value={client}
            onChange={(value) => {
              setClient(value)
              writeMcpClient(value)
            }}
          />
          <div className={css.snippet}>
            <div className={css.hint}>{meta?.hint}</div>
            <CodeBlock
              label={`${meta?.label ?? ''} setup`}
              text={display}
              copyValue={live ? snippet : null}
              reveal={{ revealed, toggle: () => setRevealed((r) => !r) }}
            />
            {client === 'other' && (
              <>
                <div className={css.stdioHint}>
                  Only supports stdio? Use the baren stdio shim instead.
                </div>
                <CodeBlock
                  label="stdio setup"
                  text={shown.snippets.stdioJson}
                  copyValue={live ? live.snippets.stdioJson : null}
                />
              </>
            )}
            <div className={css.tokenRow}>
              {confirming ? (
                <>
                  <span className={css.tokenNote}>
                    Regenerate? Connected agents will need the new token.
                  </span>
                  <span className={css.confirmActions}>
                    <button
                      type="button"
                      className={css.textButton}
                      onClick={() => setConfirming(false)}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className={cx(css.textButton, css.textButtonStrong)}
                      disabled={regenerating}
                      onClick={() => void regenerate()}
                    >
                      Regenerate
                    </button>
                  </span>
                </>
              ) : (
                <>
                  <span className={css.tokenNote}>
                    <LockIcon size={12} className={css.lock} />
                    Includes your access token. Keep it private.
                  </span>
                  <button
                    type="button"
                    className={css.textButton}
                    disabled={!running}
                    onClick={() => setConfirming(true)}
                  >
                    <ResetIcon size={12} />
                    Regenerate token
                  </button>
                </>
              )}
            </div>
          </div>
        </div>

        <div className={cx(css.capabilities, !on && css.dimmed)} inert={!on}>
          <div className={css.hint}>What agents can do</div>
          <Capability icon={<LayersIcon size={14} />}>
            Read layers, styles and tokens; export JSX and screenshots
          </Capability>
          <Capability icon={<PenLineIcon size={14} />}>
            Create artboards and edit layers, text and styles on the canvas
          </Capability>
          <Capability icon={<Undo2Icon size={14} />}>
            Every change syncs to your team and undoes in one step
          </Capability>
        </div>

        <div className={css.footer}>
          <div
            className={css.status}
            role="status"
            data-testid="mcp-dialog-status"
            title={footer.text}
          >
            <StatusDot tone={footer.tone} />
            <span className={cx(css.statusText, footer.tone === 'danger' && css.statusError)}>
              {footer.text}
            </span>
          </div>
          <div className={css.footerActions}>
            <Button
              variant="ghost"
              size={30}
              textSize={12}
              className={css.learnMore}
              onClick={() => void bridge.shell.openExternal(LINKS.agents)}
            >
              Learn more
            </Button>
            <Button variant="primary" size={30} textSize={12} onClick={close}>
              Done
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
