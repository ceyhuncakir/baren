import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { describe, expect, it } from 'vitest'
import { allows, hiddenSenderKind, markHiddenSender } from './senders'

describe('IPC senders', () => {
  it('lets app windows use every channel and unknown senders none', () => {
    for (const channel of ['mcp:setup', 'auth:set-token', 'files:remove', 'app:quit'] as const) {
      expect(allows('app', channel)).toBe(true)
      expect(allows(null, channel)).toBe(false)
    }
    expect(allows(null, 'startup:milestone')).toBe(false)
  })

  it('gives a hidden file host what an editor session needs, and no more', () => {
    for (const channel of [
      'files:open',
      'files:apply-update',
      'files:set-remote',
      'assets:put',
      'auth:get-token',
      'fonts:faces',
      'agent:response',
      'agent:host',
      'theme:get-resolved',
    ] as const) {
      expect([channel, allows('agent-host', channel)]).toEqual([channel, true])
    }
    for (const channel of [
      'mcp:setup',
      'mcp:reset-token',
      'mcp:set-enabled',
      'agentRuns:start',
      'agentRuns:set-enabled',
      'auth:set-token',
      'shell:open-external',
      'files:remove',
      'files:rename',
      'files:create',
      'theme:set-preference',
      'clipboard:read',
      'updates:install',
      'app:new-window',
      'app:toggle-dev-tools',
    ] as const) {
      expect([channel, allows('agent-host', channel)]).toEqual([channel, false])
    }
  })

  it('keeps the render window to assets, fonts and its answers', () => {
    expect(allows('agent-render', 'assets:get')).toBe(true)
    expect(allows('agent-render', 'fonts:faces')).toBe(true)
    expect(allows('agent-render', 'agent:response')).toBe(true)
    for (const channel of ['auth:get-token', 'files:open', 'files:list', 'assets:put'] as const) {
      expect([channel, allows('agent-render', channel)]).toEqual([channel, false])
    }
  })

  it('remembers hidden windows until they are destroyed', () => {
    const contents = Object.assign(new EventEmitter(), { id: 4242 }) as unknown as WebContents
    expect(hiddenSenderKind(4242)).toBeNull()
    markHiddenSender(contents, 'agent-render')
    expect(hiddenSenderKind(4242)).toBe('agent-render')
    ;(contents as unknown as EventEmitter).emit('destroyed')
    expect(hiddenSenderKind(4242)).toBeNull()
  })
})
