import { describe, expect, it } from 'vitest'
import type { AgentRunRequest } from '../../renderer/types/bridge'
import { buildPrompt, mcpConfig, mentionsRunAgent, runArgs } from './prompt'

const request: AgentRunRequest = {
  fileId: 'f1',
  fileName: 'Interopt',
  pageName: 'Cloud posture',
  threadId: 't1',
  messageId: 'm1',
  authorName: 'Ana',
  body: '@Claude Code make this card denser\nand keep the icon',
  layer: { id: '12@3', name: 'Card' },
  artboard: { id: '1@3', name: 'Posture / Empty state' },
}

describe('comment request prompts', () => {
  it('says where the comment is, quotes it and lists the steps', () => {
    const prompt = buildPrompt(request)
    expect(prompt).toContain('File: "Interopt" (fileId: f1)')
    expect(prompt).toContain(
      'Pinned on layer "Card" (nodeId: 12@3) in artboard "Posture / Empty state" (nodeId: 1@3)',
    )
    expect(prompt).toContain('Comment thread: t1')
    expect(prompt).toContain(
      'Ana wrote:\n> @Claude Code make this card denser\n> and keep the icon',
    )
    expect(prompt).toContain(
      'get_comments({ fileId: "f1", threadId: "t1", includeResolved: true })',
    )
    expect(prompt).toContain('reply_to_comment')
    expect(buildPrompt({ ...request, layer: null, artboard: null })).toContain(
      'Pinned on the page, not on a layer',
    )
  })

  it('runs claude in print mode with only the baren tools and no prompts', () => {
    const args = runArgs({ prompt: 'P', mcpConfigPath: '/d/run.json', resumeSessionId: null })
    expect(args.slice(0, 2)).toEqual(['-p', 'P'])
    const flag = (name: string) => args[args.indexOf(name) + 1]
    expect(flag('--mcp-config')).toBe('/d/run.json')
    expect(args).toContain('--strict-mcp-config')
    expect(flag('--allowedTools')).toBe('mcp__baren__*')
    expect(flag('--permission-mode')).toBe('dontAsk')
    expect(flag('--output-format')).toBe('stream-json')
    expect(args).toContain('--verbose')
    expect(args).not.toContain('--resume')
    expect(
      runArgs({ prompt: 'P', mcpConfigPath: '/d/run.json', resumeSessionId: 's-1' }).slice(-2),
    ).toEqual(['--resume', 's-1'])
  })

  it('writes the MCP config with the token as a header', () => {
    expect(JSON.parse(mcpConfig('http://127.0.0.1:29170/mcp', 'brn_x'))).toEqual({
      mcpServers: {
        baren: {
          type: 'http',
          url: 'http://127.0.0.1:29170/mcp',
          headers: { Authorization: 'Bearer brn_x' },
        },
      },
    })
  })

  it('recognises mentions of Claude Code only', () => {
    expect(mentionsRunAgent([{ name: 'Claude Code', kind: 'agent' }])).toBe(true)
    expect(mentionsRunAgent([{ name: 'claude code', kind: 'agent' }])).toBe(true)
    expect(mentionsRunAgent([{ name: 'Claude Code', kind: 'user' }])).toBe(false)
    expect(mentionsRunAgent([{ name: 'Cursor', kind: 'agent' }])).toBe(false)
    expect(mentionsRunAgent([])).toBe(false)
  })
})
