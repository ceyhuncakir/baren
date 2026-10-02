/**
 * Test fakes for the MCP server (Node, no Electron): renderer targets that answer agent requests
 * with a scripted executor, headless windows, a render window and a platform.
 */
import type {
  AgentPresenceUpdate,
  AgentRequest,
  AgentResponse,
  McpStatus,
} from '../../renderer/types/bridge'
import type { HeadlessWindow, VisibleWindowInfo } from './hosts'
import type { AgentRpc, RpcTarget } from './ipc'
import type { CapturedImage, RenderWindow } from './render'
import type { McpPlatform } from './service'

export type Executor = (
  request: AgentRequest,
) => Omit<AgentResponse, 'id'> | Promise<Omit<AgentResponse, 'id'>> | null

let nextId = 1000

/** A renderer: requests go to `executor` and its answers come back through `rpc`. */
export class FakeTarget implements RpcTarget {
  readonly webContentsId: number
  destroyed = false
  readonly requests: AgentRequest[] = []
  readonly cancels: string[] = []
  readonly presence: AgentPresenceUpdate[] = []

  constructor(
    private readonly rpc: () => AgentRpc,
    public executor: Executor = () => ({ ok: true, header: null, result: {} }),
    id?: number,
  ) {
    this.webContentsId = id ?? nextId++
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  send(channel: string, payload: unknown): void {
    if (this.destroyed) throw new Error('destroyed')
    if (channel === 'agent:cancel') {
      this.cancels.push(payload as string)
      return
    }
    if (channel === 'agent:presence') {
      this.presence.push(payload as AgentPresenceUpdate)
      return
    }
    const request = payload as AgentRequest
    this.requests.push(request)
    void Promise.resolve()
      .then(() => this.executor(request))
      .then((answer) => {
        if (answer === null || this.destroyed) return
        this.rpc().handleResponse(this.webContentsId, {
          ...answer,
          id: request.id,
        } as AgentResponse)
      })
      .catch((error: unknown) => {
        this.rpc().handleResponse(this.webContentsId, {
          id: request.id,
          ok: false,
          error: { code: 'internal', message: String(error) },
        })
      })
  }
}

export class FakeHeadless extends FakeTarget implements HeadlessWindow {
  destroyCalls = 0
  destroy(): void {
    this.destroyCalls++
    this.destroyed = true
  }
}

export function fakeImage(width: number, height: number): CapturedImage {
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, width & 0xff, height & 0xff])
  return {
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    resize: (size) => fakeImage(size.width, size.height),
    toPNG: () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, width & 0xff, height & 0xff]),
    toJPEG: () => bytes,
  }
}

export class FakeRenderWindow extends FakeTarget implements RenderWindow {
  readonly loaded = Promise.resolve()
  size = { width: 64, height: 64 }
  captures: { width: number; height: number }[] = []
  setContentSize(width: number, height: number): void {
    this.size = { width, height }
  }
  async nextPaint(): Promise<void> {}
  async capture(rect: { width: number; height: number }): Promise<CapturedImage> {
    this.captures.push({ width: rect.width, height: rect.height })
    return fakeImage(rect.width, rect.height)
  }
  async printToPdf(): Promise<Uint8Array> {
    return new TextEncoder().encode('%PDF-1.7 fake')
  }
  destroy(): void {
    this.destroyed = true
  }
}

export interface FakePlatform extends McpPlatform {
  visible: VisibleWindowInfo[]
  statuses: McpStatus[]
  filesChanged: number
  shown: string[]
  /** `signInShown()`: the shown window redirected to the sign-in screen. */
  signedOut: boolean
  headless: FakeHeadless[]
  renderWindows: FakeRenderWindow[]
  headlessExecutor: Executor
  renderExecutor: Executor
}

export function fakePlatform(rpc: () => AgentRpc): FakePlatform {
  const platform: FakePlatform = {
    visible: [],
    statuses: [],
    filesChanged: 0,
    shown: [],
    signedOut: false,
    headless: [],
    renderWindows: [],
    headlessExecutor: () => null,
    renderExecutor: () => ({ ok: true, header: null, result: {} }),
    visibleWindows: () => platform.visible,
    createHeadless: () => {
      const win = new FakeHeadless(rpc, (req) => platform.headlessExecutor(req))
      platform.headless.push(win)
      return win
    },
    createRenderWindow: () => {
      const win = new FakeRenderWindow(rpc, (req) => platform.renderExecutor(req))
      platform.renderWindows.push(win)
      return win
    },
    showFile: (fileId) => {
      platform.shown.push(fileId)
    },
    signInShown: () => platform.signedOut,
    focusIfAppFocused: () => undefined,
    broadcastStatus: (status) => {
      platform.statuses.push(status)
    },
    broadcastFilesChanged: () => {
      platform.filesChanged++
    },
    sendPresence: (target, update) => target.send('agent:presence', update),
    fetch: async () => new Response('not found', { status: 404 }),
    codec: { toJpeg: () => null },
    stdioCommand: () => '/usr/bin/baren',
  }
  return platform
}
