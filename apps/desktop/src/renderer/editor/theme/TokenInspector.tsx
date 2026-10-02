/**
 * Token inspector (artboard 07, right): name (namespace muted), value (color field with
 * picker, or a text value), description, and "Used in" with per-property counts and
 * "Select all". Edits update the canvas live (the canvas maps tokens to CSS variables).
 */
import {
  Badge,
  ChipRow,
  ColorField,
  ColorPicker,
  DropdownMenu,
  FieldIconButton,
  InspectorRow,
  InspectorSection,
  MenuItem,
  MoreHorizontalIcon,
  PipetteIcon,
  SectionHeaderAction,
  SectionHeaderLink,
  Stat,
  TextArea,
  hexToHsva,
  hsvaToHex,
  type Hsva,
} from '@baren/ui'
import { getChildIds, setTokens, toSubtreeSnapshot, transact, type Token } from '@baren/schema'
import { useEffect, useRef, useState } from 'react'
import { formatColor, parseColor } from '../model/colors'
import { deleteToken, renameToken, tokenOrders, upsertTokens } from '../model/tokenOps'
import { ORIGIN } from '../model/docOps'
import {
  TokenUsageCounter,
  normalizeTokenName,
  tokenGroup,
  tokenNamespace,
  uniqueTokenName,
  type TokenUsage,
} from '../model/tokens'
import { pickScreenColor } from '../inspector/sections/PageSections'
import { useEditor, useEditorState, useTokens } from '../session/context'
import { selectIds } from '../session/selection'
import css from '../inspector/Inspector.module.css'
import fieldCss from './Theme.module.css'

const TOKEN_PREVIEW = 'preview:token'

function writeToken(
  doc: Parameters<typeof setTokens>[0],
  name: string,
  token: Token,
  final: boolean,
) {
  transact(doc, () => setTokens(doc, { [name]: token }), {
    origin: final ? ORIGIN.theme : TOKEN_PREVIEW,
  })
}

export function TokenInspector({ name }: { name: string }) {
  const { doc } = useEditor()
  const tokens = useTokens()
  const token = tokens[name]
  if (!token) return null
  return (
    <>
      <TokenHeader key={`h-${name}`} name={name} token={token} />
      <InspectorSection title="Description" roomy style={{ paddingTop: 10 }}>
        <DescriptionField
          key={`d-${name}`}
          value={token.description ?? ''}
          onCommit={(description) => {
            const next: Token = { type: token.type, value: token.value }
            if (description) next.description = description
            writeToken(doc, name, next, true)
          }}
        />
      </InspectorSection>
      <UsageSection name={name} />
    </>
  )
}

function TokenHeader({ name, token }: { name: string; token: Token }) {
  const { doc, store } = useEditor()
  const tokens = useTokens()
  const group = tokenGroup(name, token)
  const namespace = tokenNamespace(name)
  const short = name.slice(namespace.length)
  const color = group === 'colors' ? parseColor(String(token.value)) : null
  const literal = color?.kind === 'literal' ? color : null
  const [hsva, setHsva] = useState<Hsva>(
    () => hexToHsva(literal?.hex ?? '000000', literal?.alpha ?? 1) ?? { h: 0, s: 0, v: 0, a: 1 },
  )
  const [menuOpen, setMenuOpen] = useState(false)
  const moreRef = useRef<HTMLSpanElement>(null)
  const original = useRef<Token>(token)

  // Keep the picker in sync with remote/undo changes (but not with our own drag).
  const dragging = useRef(false)
  useEffect(() => {
    if (dragging.current || !literal) return
    setHsva((prev) => {
      const next = hexToHsva(literal.hex, literal.alpha, prev.h)
      return next && (hsvaToHex(prev) !== hsvaToHex(next) || prev.a !== next.a) ? next : prev
    })
  }, [literal?.hex, literal?.alpha, literal])

  const setColor = (c: Hsva, final: boolean) => {
    const value = formatColor(hsvaToHex(c), c.a)
    const next: Token = { ...token, value }
    if (!final) {
      if (!dragging.current) original.current = token
      dragging.current = true
      writeToken(doc, name, next, false)
      return
    }
    dragging.current = false
    // Revert the previews outside undo, then commit the final value as one step.
    writeToken(doc, name, original.current, false)
    writeToken(doc, name, next, true)
  }

  const rename = (input: string) => {
    const target = normalizeTokenName(input, namespace)
    if (!target || target === name || target in tokens) return
    if (renameToken(doc, name, target, token)) store.setState({ selectedToken: target })
  }

  const title =
    group === 'colors'
      ? 'Color token'
      : group === 'typography'
        ? 'Typography token'
        : group === 'spacing'
          ? 'Spacing token'
          : group === 'radius'
            ? 'Radius token'
            : 'Token'

  return (
    <InspectorSection
      title={title}
      roomy
      style={{ paddingTop: 10 }}
      actions={
        <span ref={moreRef} style={{ display: 'flex' }}>
          <SectionHeaderAction label="More" onClick={() => setMenuOpen((v) => !v)}>
            <MoreHorizontalIcon size={14} />
          </SectionHeaderAction>
        </span>
      }
    >
      <TokenNameInput namespace={namespace} name={short} onCommit={rename} />
      {literal ? (
        <>
          <InspectorRow>
            <ColorField
              size={28}
              mono
              color={hsvaToHex(hsva)}
              opacity={hsva.a}
              onColorChange={(hex) => {
                const next = hexToHsva(hex, hsva.a, hsva.h) ?? hsva
                setHsva(next)
                writeToken(doc, name, { ...token, value: formatColor(hex, hsva.a) }, true)
              }}
              onOpacityChange={(a) => {
                const next = { ...hsva, a }
                setHsva(next)
                writeToken(doc, name, { ...token, value: formatColor(hsvaToHex(hsva), a) }, true)
              }}
            />
            <FieldIconButton
              label="Pick color"
              size={28}
              onClick={() =>
                void pickScreenColor().then((hex) => {
                  if (!hex) return
                  writeToken(doc, name, { ...token, value: hex.toUpperCase() }, true)
                })
              }
            >
              <PipetteIcon size={13} />
            </FieldIconButton>
          </InspectorRow>
          <ColorPicker
            value={hsva}
            showAlpha={false}
            onChange={(c) => {
              setHsva(c)
              setColor(c, false)
            }}
            onChangeEnd={(c) => {
              setHsva(c)
              setColor(c, true)
            }}
          />
        </>
      ) : (
        <TokenValueInput
          value={String(token.value)}
          onCommit={(value) => writeToken(doc, name, { ...token, value }, true)}
        />
      )}
      <DropdownMenu
        open={menuOpen}
        onOpenChange={setMenuOpen}
        anchorRef={moreRef}
        width={180}
        placement="bottom-end"
      >
        <MenuItem
          onSelect={() => {
            const copy = uniqueTokenName(`${name}-copy`, tokens)
            const at = tokenOrders(doc)[name]
            upsertTokens(
              doc,
              { [copy]: token },
              at === undefined ? {} : { orders: { [copy]: at + 0.5 } },
            )
            store.setState({ selectedToken: copy })
          }}
        >
          Duplicate
        </MenuItem>
        <MenuItem
          destructive
          onSelect={() => {
            deleteToken(doc, name)
            store.setState({ selectedToken: null })
          }}
        >
          Delete token
        </MenuItem>
      </DropdownMenu>
    </InspectorSection>
  )
}

function TokenNameInput({
  namespace,
  name,
  onCommit,
}: {
  namespace: string
  name: string
  onCommit: (name: string) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <label className={fieldCss.nameField}>
      <span className={fieldCss.namespace}>{namespace}</span>
      <input
        className={fieldCss.nameInput}
        value={draft ?? name}
        spellCheck={false}
        aria-label="Token name"
        onChange={(e) => setDraft(e.currentTarget.value)}
        onBlur={() => {
          if (draft !== null && draft.trim() !== name) onCommit(draft.trim())
          setDraft(null)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') {
            setDraft(null)
            e.currentTarget.blur()
          }
        }}
      />
    </label>
  )
}

function TokenValueInput({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <label className={fieldCss.nameField}>
      <input
        className={fieldCss.nameInput}
        value={draft ?? value}
        spellCheck={false}
        aria-label="Token value"
        onChange={(e) => setDraft(e.currentTarget.value)}
        onBlur={() => {
          if (draft !== null && draft.trim() !== '' && draft.trim() !== value)
            onCommit(draft.trim())
          setDraft(null)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') {
            setDraft(null)
            e.currentTarget.blur()
          }
        }}
      />
    </label>
  )
}

function DescriptionField({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <TextArea
      className={css.description}
      value={draft ?? value}
      placeholder="Describe when to use this token"
      onChange={(e) => setDraft(e.currentTarget.value)}
      onBlur={() => {
        if (draft !== null && draft !== value) onCommit(draft.trim())
        setDraft(null)
      }}
    />
  )
}

const KIND_LABEL: Record<string, string> = {
  fill: 'fill',
  text: 'text',
  border: 'border',
  outline: 'outline',
  shadow: 'shadow',
  other: 'other',
}

/** Counts usages artboard by artboard, yielding between artboards (20k-node docs stay smooth). */
function UsageSection({ name }: { name: string }) {
  const session = useEditor()
  const { doc, events, store } = session
  const [usage, setUsage] = useState<TokenUsage | null>(null)
  const pageId = useEditorState((s) => s.pageId)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const run = async () => {
      const counter = new TokenUsageCounter(name)
      for (const page of getChildIds(doc, null)) {
        for (const board of getChildIds(doc, page)) {
          if (cancelled) return
          const sub = toSubtreeSnapshot(doc, board)
          if (sub) counter.add(board, Object.values(sub.nodes))
          await new Promise<void>((r) => setTimeout(r, 0))
        }
      }
      if (!cancelled) setUsage(counter.result())
    }
    void run()
    const off = events.subscribe((batch) => {
      if (batch.origin?.startsWith('preview')) return
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => void run(), 300)
    })
    return () => {
      cancelled = true
      off()
      if (timer !== null) clearTimeout(timer)
    }
  }, [doc, events, name])

  const layers = usage?.layers ?? 0
  const artboards = usage?.artboards ?? 0
  return (
    <InspectorSection
      title="Used in"
      roomy
      bordered={false}
      style={{ paddingTop: 10 }}
      actions={
        <SectionHeaderLink
          disabled={!usage || usage.nodeIds.length === 0}
          onClick={() => {
            if (!usage) return
            // Select the usages on the current page in the design view.
            const onPage = usage.nodeIds.filter((id) => session.tree.ancestors(id).includes(pageId))
            store.setState({ mode: 'design' })
            selectIds(session, onPage)
          }}
        >
          Select all
        </SectionHeaderLink>
      }
    >
      <Stat
        value={usage ? String(layers) : '–'}
        caption={`${layers === 1 ? 'layer' : 'layers'} across ${artboards} ${artboards === 1 ? 'artboard' : 'artboards'}`}
      />
      {usage && usage.byKind.length > 0 && (
        <ChipRow>
          {usage.byKind.map((k) => (
            <Badge key={k.kind} variant="input">
              {KIND_LABEL[k.kind]} · {k.count}
            </Badge>
          ))}
        </ChipRow>
      )}
    </InspectorSection>
  )
}
