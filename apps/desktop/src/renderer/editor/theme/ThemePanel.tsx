/**
 * Theme panel (artboard 07, left): searchable token list grouped into Colors, Typography,
 * Spacing, Radius. Selecting a token opens it in the inspector; "+" adds a color token.
 */
import { PanelSectionHeader, PlusIcon, SearchIcon, TokenRow } from '@baren/ui'
import { useMemo } from 'react'
import { upsertTokens } from '../model/tokenOps'
import { groupTokens, uniqueTokenName, type TokenGroupId } from '../model/tokens'
import { useEditor, useEditorState, useTokenOrders, useTokens } from '../session/context'
import css from '../Editor.module.css'

export function ThemePanel() {
  const { store, doc } = useEditor()
  const tokens = useTokens()
  const orders = useTokenOrders()
  const query = useEditorState((s) => s.tokenQuery)
  const selected = useEditorState((s) => s.selectedToken)
  const collapsed = useEditorState((s) => s.collapsedGroups)
  const groups = useMemo(() => groupTokens(tokens, query, orders), [tokens, query, orders])
  const searching = query.trim() !== ''

  const toggleGroup = (id: TokenGroupId) =>
    store.setState((s) => {
      const next = new Set(s.collapsedGroups)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return { collapsedGroups: next }
    })

  const addToken = () => {
    const name = uniqueTokenName('--color-new', tokens)
    upsertTokens(doc, { [name]: { type: 'color', value: '#000000' } })
    store.setState((s) => {
      const next = new Set(s.collapsedGroups)
      next.delete('colors')
      return { selectedToken: name, collapsedGroups: next, tokenQuery: '' }
    })
  }

  return (
    <div className={css.tokens} role="region" aria-label="Tokens">
      <label className={css.tokenSearch}>
        <SearchIcon size={13} strokeWidth={2} />
        <input
          className={css.tokenSearchInput}
          placeholder="Search tokens"
          value={query}
          spellCheck={false}
          onChange={(e) => store.setState({ tokenQuery: e.currentTarget.value })}
          onKeyDown={(e) => {
            if (e.key === 'Escape') store.setState({ tokenQuery: '' })
          }}
        />
        <button
          type="button"
          className={css.tokenSearchAdd}
          aria-label="Add token"
          title="Add token"
          onClick={(e) => {
            e.preventDefault()
            addToken()
          }}
        >
          <PlusIcon size={14} strokeWidth={2} />
        </button>
      </label>
      {groups.length === 0 && (
        <div className={css.tokenEmpty}>
          {searching ? 'No tokens match.' : 'No tokens yet. Press + to add one.'}
        </div>
      )}
      {groups.map((g) => {
        const open = searching || !collapsed.has(g.id)
        return (
          <div
            key={g.id}
            className={open ? css.tokenGroup : `${css.tokenGroup} ${css.tokenGroupCollapsed}`}
          >
            <PanelSectionHeader
              title={g.label}
              count={g.entries.length}
              expanded={open}
              wide
              onClick={() => toggleGroup(g.id)}
            />
            {open && (
              <div role="listbox" aria-label={g.label} className={css.tokenList}>
                {g.entries.map((e) => (
                  <TokenRow
                    key={e.name}
                    name={e.label}
                    value={e.value}
                    kind={
                      e.group === 'colors'
                        ? 'color'
                        : e.group === 'typography'
                          ? 'typography'
                          : 'other'
                    }
                    {...(e.group === 'colors' ? { color: String(e.token.value) } : {})}
                    selected={selected === e.name}
                    onClick={() => store.setState({ selectedToken: e.name })}
                  />
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
