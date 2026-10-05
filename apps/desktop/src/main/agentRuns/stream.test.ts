import { describe, expect, it } from 'vitest'
import { activityOf, parseStreamLine } from './stream'

const line = (v: unknown) => JSON.stringify(v)

describe('stream-json events', () => {
  it('takes the session id from init and the activity from tool calls', () => {
    expect(
      parseStreamLine(line({ type: 'system', subtype: 'init', session_id: 'abc', tools: [] })),
    ).toEqual({ sessionId: 'abc', activity: 'Starting' })
    expect(
      parseStreamLine(
        line({
          type: 'assistant',
          message: {
            content: [
              { type: 'thinking', thinking: '…' },
              { type: 'tool_use', name: 'mcp__baren__get_screenshot', input: {} },
            ],
          },
        }),
      ),
    ).toEqual({ activity: 'Taking a screenshot' })
    expect(
      parseStreamLine(
        line({ type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] } }),
      ),
    ).toEqual({ activity: 'Thinking' })
  })

  it('reads the result and ignores everything else', () => {
    expect(
      parseStreamLine(line({ type: 'result', subtype: 'success', is_error: false, result: 'ok' })),
    ).toEqual({ result: { ok: true, text: 'ok' } })
    expect(
      parseStreamLine(
        line({ type: 'result', subtype: 'error_max_turns', is_error: true, result: 'Too long' }),
      ),
    ).toEqual({ result: { ok: false, text: 'Too long' } })
    expect(parseStreamLine(line({ type: 'system', subtype: 'hook_started' }))).toEqual({})
    expect(parseStreamLine(line({ type: 'rate_limit_event' }))).toEqual({})
    expect(parseStreamLine('not json')).toEqual({})
    expect(parseStreamLine('null')).toEqual({})
  })

  it('names baren tools and falls back for others', () => {
    expect(activityOf('mcp__baren__update_styles')).toBe('Changing styles')
    expect(activityOf('mcp__baren__something_new')).toBe('Working')
    expect(activityOf('Bash')).toBe('Working')
  })
})
