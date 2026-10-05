import { describe, expect, it } from 'vitest'
import { createBridge, toPlatform } from './bridge'
import type { EventChannels } from './channels'
import { cleanRemoteError, createTypedIpc, type IpcRendererLike } from './ipc'
import { isEditableTarget, nativeEditActionFor } from './menuCommands'
import { initialTheme, themeFromArgv } from './theme'

type Listener = (event: unknown, ...args: unknown[]) => void

/** Fake ipcRenderer: records traffic and lets tests push main → renderer events. */
function fakeIpcRenderer() {
  const invoked: [string, unknown[]][] = []
  const sent: [string, unknown[]][] = []
  const listeners = new Map<string, Set<Listener>>()
  const ipc: IpcRendererLike = {
    invoke: async (channel, ...args) => {
      invoked.push([channel, args])
      if (channel === 'files:open')
        throw new Error("Error invoking remote method 'files:open': Error: File not found: x")
      return `${channel}:ok`
    },
    send: (channel, ...args) => {
      sent.push([channel, args])
    },
    sendSync: (channel) => (channel === 'theme:get-resolved' ? 'dark' : null),
    on: (channel, listener) => {
      if (!listeners.has(channel)) listeners.set(channel, new Set())
      listeners.get(channel)!.add(listener)
    },
    removeListener: (channel, listener) => {
      listeners.get(channel)?.delete(listener)
    },
  }
  const emit = <K extends keyof EventChannels>(channel: K, ...args: EventChannels[K]) => {
    for (const l of listeners.get(channel) ?? []) l({}, ...args)
  }
  const listenerCount = (channel: string) => listeners.get(channel)?.size ?? 0
  return { ipc, invoked, sent, emit, listenerCount }
}

describe('createBridge', () => {
  it('implements every member of the BarenBridge contract', () => {
    const bridge = createBridge(createTypedIpc(fakeIpcRenderer().ipc), 'linux')
    expect(Object.keys(bridge).sort()).toEqual(
      [
        'agentRuns',
        'app',
        'assets',
        'auth',
        'clipboard',
        'export',
        'files',
        'fonts',
        'agent',
        'mcp',
        'onDeepLink',
        'platform',
        'shell',
        'theme',
        'updates',
        'window',
      ].sort(),
    )
    expect(Object.keys(bridge.theme).sort()).toEqual(
      ['initial', 'onChange', 'preference', 'setPreference'].sort(),
    )
    expect(Object.keys(bridge.updates).sort()).toEqual(
      ['check', 'install', 'onStatus', 'status'].sort(),
    )
    expect(Object.keys(bridge.window).sort()).toEqual(
      ['close', 'isMaximized', 'minimize', 'onMaximizedChange', 'toggleMaximize'].sort(),
    )
    expect(Object.keys(bridge.files).sort()).toEqual(
      [
        'applyUpdate',
        'archive',
        'create',
        'getThumbnail',
        'import',
        'list',
        'onChanged',
        'open',
        'remove',
        'rename',
        'setRemote',
        'setThumbnail',
      ].sort(),
    )
    expect(Object.keys(bridge.app).sort()).toEqual(
      [
        'checkForUpdates',
        'forceReload',
        'newWindow',
        'quit',
        'reload',
        'toggleDevTools',
        'toggleFullScreen',
        'version',
      ].sort(),
    )
    expect(Object.keys(bridge.clipboard).sort()).toEqual(['read', 'write'])
    expect(Object.keys(bridge.mcp).sort()).toEqual(
      ['onStatus', 'resetToken', 'setEnabled', 'setup', 'status'].sort(),
    )
    expect(Object.keys(bridge.agent).sort()).toEqual(
      ['host', 'onCancel', 'onPresence', 'onRequest', 'respond'].sort(),
    )
    expect(bridge.platform).toBe('linux')
  })

  it('maps the clipboard onto clipboard:write / clipboard:read', async () => {
    const fake = fakeIpcRenderer()
    const bridge = createBridge(createTypedIpc(fake.ipc), 'linux')
    const png = Uint8Array.of(137, 80)
    await bridge.clipboard.write({ text: 'a', html: '<p>a</p>', baren: '{}', png })
    await bridge.clipboard.read()
    expect(fake.invoked).toEqual([
      ['clipboard:write', [{ text: 'a', html: '<p>a</p>', baren: '{}', png }]],
      ['clipboard:read', []],
    ])
  })

  it('maps calls onto typed channels with their arguments', async () => {
    const fake = fakeIpcRenderer()
    const bridge = createBridge(createTypedIpc(fake.ipc), 'darwin')
    const update = Uint8Array.of(1, 2)
    await bridge.files.applyUpdate('f1', update)
    await bridge.files.archive('f1', true)
    await bridge.files.import(update, null)
    await bridge.files.setRemote('f1', 't1', 'r1')
    await bridge.assets.put(update, 'image/png')
    await bridge.export.html('f1', '1@2')
    await bridge.auth.setToken(null)
    await bridge.shell.openExternal('https://baren.dev')
    expect(await bridge.app.version()).toBe('app:version:ok')
    bridge.window.toggleMaximize()
    bridge.app.newWindow()
    bridge.app.toggleDevTools()
    expect(fake.invoked).toEqual([
      ['files:apply-update', ['f1', update]],
      ['files:archive', ['f1', true]],
      ['files:import', [update, null]],
      ['files:set-remote', ['f1', 't1', 'r1']],
      ['assets:put', [update, 'image/png']],
      ['export:html', ['f1', '1@2']],
      ['auth:set-token', [null]],
      ['shell:open-external', ['https://baren.dev']],
      ['app:version', []],
    ])
    expect(fake.sent.map(([c]) => c)).toEqual([
      'window:toggle-maximize',
      'app:new-window',
      'app:toggle-dev-tools',
    ])
  })

  it('surfaces main-process errors without the IPC prefix', async () => {
    const bridge = createBridge(createTypedIpc(fakeIpcRenderer().ipc), 'linux')
    await expect(bridge.files.open('x')).rejects.toThrow(/^File not found: x$/)
  })

  it('forwards maximize changes and unsubscribes', () => {
    const fake = fakeIpcRenderer()
    const bridge = createBridge(createTypedIpc(fake.ipc), 'linux')
    const seen: boolean[] = []
    const off = bridge.window.onMaximizedChange((v) => seen.push(v))
    fake.emit('window:maximized-changed', true)
    off()
    fake.emit('window:maximized-changed', false)
    expect(seen).toEqual([true])
    expect(fake.listenerCount('window:maximized-changed')).toBe(0)
  })

  it('subscribes to deep links once (so main flushes its queue) and unsubscribes with the last listener', () => {
    const fake = fakeIpcRenderer()
    const bridge = createBridge(createTypedIpc(fake.ipc), 'linux')
    const a: string[] = []
    const b: string[] = []
    const offA = bridge.onDeepLink((url) => a.push(url))
    const offB = bridge.onDeepLink((url) => {
      b.push(url)
      throw new Error('listener bug') // must not starve other listeners
    })
    expect(fake.sent.filter(([c]) => c === 'deeplink:subscribe')).toHaveLength(1)
    fake.emit('deeplink:open', 'baren://invite/t')
    offA()
    offA() // idempotent
    fake.emit('deeplink:open', 'baren://auth/c')
    offB()
    expect(a).toEqual(['baren://invite/t'])
    expect(b).toEqual(['baren://invite/t', 'baren://auth/c'])
    expect(fake.sent.map(([c]) => c)).toEqual(['deeplink:subscribe', 'deeplink:unsubscribe'])
    expect(fake.listenerCount('deeplink:open')).toBe(0)
  })

  it('rejects non-function callbacks', () => {
    const bridge = createBridge(createTypedIpc(fakeIpcRenderer().ipc), 'linux')
    expect(() => bridge.onDeepLink('nope' as never)).toThrow(TypeError)
    expect(() => bridge.theme.onChange('nope' as never)).toThrow(TypeError)
    expect(() => bridge.updates.onStatus(null as never)).toThrow(TypeError)
  })

  it('exposes the theme: initial value, preference calls and change events', async () => {
    const fake = fakeIpcRenderer()
    const bridge = createBridge(createTypedIpc(fake.ipc), 'linux', 'dark')
    expect(bridge.theme.initial).toBe('dark')
    await bridge.theme.preference()
    await bridge.theme.setPreference('system')
    expect(fake.invoked).toEqual([
      ['theme:get-preference', []],
      ['theme:set-preference', ['system']],
    ])
    const seen: string[] = []
    const off = bridge.theme.onChange((t) => seen.push(t))
    fake.emit('theme:changed', 'light')
    off()
    fake.emit('theme:changed', 'dark')
    expect(seen).toEqual(['light'])
  })

  it('replays a theme change that happened before the first subscription', async () => {
    const fake = fakeIpcRenderer()
    const bridge = createBridge(createTypedIpc(fake.ipc), 'linux', 'light')
    fake.emit('theme:changed', 'dark') // e.g. while the renderer was still booting
    const seen: string[] = []
    bridge.theme.onChange((t) => seen.push(t))
    await Promise.resolve()
    expect(seen).toEqual(['dark'])
    // Unsubscribing before the replay runs cancels it.
    const late: string[] = []
    bridge.theme.onChange((t) => late.push(t))()
    await Promise.resolve()
    expect(late).toEqual([])
  })

  it('exposes auto-update status, check, install and status events through one IPC listener', async () => {
    const fake = fakeIpcRenderer()
    const bridge = createBridge(createTypedIpc(fake.ipc), 'linux')
    await bridge.updates.status()
    await bridge.updates.check()
    bridge.updates.install()
    expect(fake.invoked).toEqual([
      ['updates:status', []],
      ['updates:check', []],
    ])
    expect(fake.sent).toEqual([['updates:install', []]])
    const a: unknown[] = []
    const b: unknown[] = []
    const offA = bridge.updates.onStatus((s) => a.push(s))
    const offB = bridge.updates.onStatus((s) => b.push(s.state))
    expect(fake.listenerCount('updates:status')).toBe(1)
    fake.emit('updates:status', { state: 'downloading', version: '1.2.0', progress: 40 })
    offA()
    fake.emit('updates:status', { state: 'ready', version: '1.2.0' })
    offB()
    expect(a).toEqual([{ state: 'downloading', version: '1.2.0', progress: 40 }])
    expect(b).toEqual(['downloading', 'ready'])
    expect(fake.listenerCount('updates:status')).toBe(0)
  })
})

describe('agentRuns', () => {
  it('maps comment request calls onto agentRuns:* channels and fans out updates', async () => {
    const fake = fakeIpcRenderer()
    const bridge = createBridge(createTypedIpc(fake.ipc), 'linux')
    await bridge.agentRuns.status()
    await bridge.agentRuns.setEnabled(false)
    await bridge.agentRuns.stop('r1')
    await bridge.agentRuns.list()
    expect(fake.invoked).toEqual([
      ['agentRuns:status', []],
      ['agentRuns:set-enabled', [false]],
      ['agentRuns:stop', ['r1']],
      ['agentRuns:list', []],
    ])
    const seen: string[] = []
    const off = bridge.agentRuns.onUpdate((run) => seen.push(run.state))
    expect(fake.listenerCount('agentRuns:update')).toBe(1)
    fake.emit('agentRuns:update', {
      id: 'r1',
      fileId: 'f',
      threadId: 't',
      messageId: 'm',
      state: 'working',
      activity: 'Replying',
      error: null,
      startedAt: 1,
      endedAt: null,
    })
    off()
    expect(seen).toEqual(['working'])
    expect(fake.listenerCount('agentRuns:update')).toBe(0)
  })
})

describe('fonts', () => {
  it('asks main for a Google Fonts family on fonts:faces', async () => {
    const fake = fakeIpcRenderer()
    const bridge = createBridge(createTypedIpc(fake.ipc), 'linux')
    await bridge.fonts.faces('Geist')
    expect(fake.invoked).toEqual([['fonts:faces', ['Geist']]])
  })
})

describe('MCP and agent members (Phase 4)', () => {
  it('maps mcp calls onto mcp:* channels and fans out status events', async () => {
    const fake = fakeIpcRenderer()
    const bridge = createBridge(createTypedIpc(fake.ipc), 'linux')
    await bridge.mcp.status()
    await bridge.mcp.setEnabled(false)
    await bridge.mcp.setup()
    await bridge.mcp.resetToken()
    expect(fake.invoked).toEqual([
      ['mcp:status', []],
      ['mcp:set-enabled', [false]],
      ['mcp:setup', []],
      ['mcp:reset-token', []],
    ])
    const seen: string[] = []
    const offA = bridge.mcp.onStatus((s) => seen.push(`a:${s.state}`))
    const offB = bridge.mcp.onStatus((s) => seen.push(`b:${s.state}`))
    expect(fake.listenerCount('mcp:status')).toBe(1)
    const status = {
      state: 'running' as const,
      enabled: true,
      url: 'http://127.0.0.1:29170/mcp',
      port: 29170,
      portChanged: false,
      error: null,
      agents: [],
    }
    fake.emit('mcp:status', status)
    offA()
    fake.emit('mcp:status', { ...status, state: 'off' })
    offB()
    expect(seen).toEqual(['a:running', 'b:running', 'b:off'])
    expect(fake.listenerCount('mcp:status')).toBe(0)
  })

  it('routes agent requests, cancels and presence to listeners and sends responses and host states', () => {
    const fake = fakeIpcRenderer()
    const bridge = createBridge(createTypedIpc(fake.ipc), 'linux')
    const requests: string[] = []
    const cancels: string[] = []
    const presence: number[] = []
    const offReq = bridge.agent.onRequest((r) => requests.push(`${r.id}:${r.tool}`))
    const offCancel = bridge.agent.onCancel((id) => cancels.push(id))
    const offPresence = bridge.agent.onPresence((u) => presence.push(u.agents.length))
    fake.emit('agent:request', {
      id: 'r1',
      fileId: 'f1',
      tool: 'get_basic_info',
      args: {},
      agent: null,
      deadline: 1,
    })
    fake.emit('agent:cancel', 'r1')
    fake.emit('agent:presence', {
      fileId: 'f1',
      agents: [{ id: 'p', name: 'Claude Code', working: ['1@2'], activeAt: 5 }],
    })
    offReq()
    offCancel()
    offPresence()
    fake.emit('agent:request', {
      id: 'r2',
      fileId: 'f1',
      tool: 'get_basic_info',
      args: {},
      agent: null,
      deadline: 1,
    })
    expect(requests).toEqual(['r1:get_basic_info'])
    expect(cancels).toEqual(['r1'])
    expect(presence).toEqual([1])
    for (const channel of ['agent:request', 'agent:cancel', 'agent:presence']) {
      expect(fake.listenerCount(channel)).toBe(0)
    }
    bridge.agent.respond({ id: 'r1', ok: true, header: null, result: { a: 1 }, touched: [] })
    bridge.agent.host({ fileId: 'f1', state: 'opened', headless: false })
    expect(fake.sent).toEqual([
      ['agent:response', [{ id: 'r1', ok: true, header: null, result: { a: 1 }, touched: [] }]],
      ['agent:host', [{ fileId: 'f1', state: 'opened', headless: false }]],
    ])
  })

  it('notifies files.onChanged without a payload', () => {
    const fake = fakeIpcRenderer()
    const bridge = createBridge(createTypedIpc(fake.ipc), 'linux')
    let calls = 0
    const off = bridge.files.onChanged(() => calls++)
    fake.emit('files:changed')
    off()
    fake.emit('files:changed')
    expect(calls).toBe(1)
    expect(() => bridge.files.onChanged(null as never)).toThrow(TypeError)
    expect(() => bridge.agent.onRequest('x' as never)).toThrow(TypeError)
  })
})

describe('initial theme (preload)', () => {
  const sources = (over: Partial<Parameters<typeof initialTheme>[0]> = {}) => ({
    argv: ['/app/electron', '--type=renderer', '--baren-theme=dark'],
    navigationType: 'navigate',
    queryMain: () => {
      throw new Error('must not be called')
    },
    prefersDark: () => false,
    ...over,
  })

  it('reads --baren-theme from argv (no IPC on a normal load)', () => {
    expect(themeFromArgv(['x', '--baren-theme=light'])).toBe('light')
    expect(themeFromArgv(['--baren-theme=light', '--baren-theme=dark'])).toBe('dark')
    expect(themeFromArgv(['--baren-theme=blue'])).toBeNull()
    expect(themeFromArgv([])).toBeNull()
    expect(initialTheme(sources())).toBe('dark')
  })

  it('asks main after a reload (argv is fixed at window creation)', () => {
    expect(initialTheme(sources({ navigationType: 'reload', queryMain: () => 'light' }))).toBe(
      'light',
    )
    // Main refused or answered garbage: argv, then prefers-color-scheme.
    expect(initialTheme(sources({ navigationType: 'reload', queryMain: () => null }))).toBe('dark')
    expect(
      initialTheme(
        sources({
          argv: [],
          navigationType: 'reload',
          queryMain: () => 'x',
          prefersDark: () => true,
        }),
      ),
    ).toBe('dark')
    expect(
      initialTheme(
        sources({
          argv: [],
          queryMain: () => {
            throw new Error('no ipc')
          },
          prefersDark: () => {
            throw new Error('no matchMedia')
          },
        }),
      ),
    ).toBe('light')
  })
})

describe('preload helpers', () => {
  it('cleans remote error prefixes', () => {
    expect(
      cleanRemoteError(new Error("Error invoking remote method 'x': CoreError: boom")).message,
    ).toBe('boom')
    const plain = new Error('plain')
    expect(cleanRemoteError(plain)).toBe(plain)
    expect(cleanRemoteError('str').message).toBe('str')
  })

  it('normalises the platform', () => {
    expect(toPlatform('darwin')).toBe('darwin')
    expect(toPlatform('win32')).toBe('win32')
    expect(toPlatform('freebsd')).toBe('linux')
  })

  it('maps edit commands to native editing actions', () => {
    expect(nativeEditActionFor('edit.undo')).toBe('undo')
    expect(nativeEditActionFor('edit.selectAll')).toBe('selectAll')
    expect(nativeEditActionFor('edit.duplicate')).toBeNull()
    expect(nativeEditActionFor('view.zoomIn')).toBeNull()
  })

  it('detects focused text fields', () => {
    expect(isEditableTarget({ tagName: 'INPUT', type: 'text' })).toBe(true)
    expect(isEditableTarget({ tagName: 'input', type: 'email' })).toBe(true)
    expect(isEditableTarget({ tagName: 'INPUT', type: 'checkbox' })).toBe(false)
    expect(isEditableTarget({ tagName: 'INPUT', type: 'text', readOnly: true })).toBe(false)
    expect(isEditableTarget({ tagName: 'TEXTAREA' })).toBe(true)
    expect(isEditableTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true)
    expect(isEditableTarget({ tagName: 'CANVAS' })).toBe(false)
    expect(isEditableTarget(null)).toBe(false)
  })
})
