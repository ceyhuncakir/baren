/**
 * Live-sync wire protocol on `/ws/files/:id?token=…`. Mirror of `crates/proto/src/{wire,presence}.rs`.
 *
 * Binary frames are `[type, ...payload]`:
 * - `0x01` Update: Loro update bytes (both directions).
 * - `0x02` SyncRequest: the sender's encoded oplog version vector. The receiver answers with
 *   what the sender is missing — the server with `0x03`, a client with `0x01`.
 * - `0x03` SyncResponse: updates since the requested version (server → client); empty
 *   payload = already in sync.
 *
 * Text frames are presence JSON (never persisted). Clients send {@link ClientPresence}; the
 * server sends {@link ServerText}, discriminated by `type`.
 */

import type { Role } from './types.ts'

/** First byte of a binary WebSocket frame (mirror of `baren_proto::MsgType`). */
export const MsgType = {
  Update: 0x01,
  SyncRequest: 0x02,
  SyncResponse: 0x03,
} as const
export type MsgType = (typeof MsgType)[keyof typeof MsgType]

/** Application close codes sent by the server. */
export const CloseCode = {
  BadRequest: 4400,
  Unauthorized: 4401,
  Forbidden: 4403,
  NotFound: 4404,
  Timeout: 4408,
  TooSlow: 4429,
  RoomError: 4500,
} as const
export type CloseCode = (typeof CloseCode)[keyof typeof CloseCode]

/** Close codes after which reconnecting cannot help. */
export function isTerminalClose(code: number): boolean {
  return (
    code === CloseCode.Unauthorized || code === CloseCode.Forbidden || code === CloseCode.NotFound
  )
}

export function encodeFrame(type: MsgType, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const frame = new Uint8Array(payload.length + 1)
  frame[0] = type
  frame.set(payload, 1)
  return frame
}

export interface DecodedFrame {
  type: MsgType
  payload: Uint8Array
}

/** Split a binary frame; `null` for empty frames or unknown types. */
export function decodeFrame(frame: Uint8Array): DecodedFrame | null {
  const type = frame[0]
  if (type !== MsgType.Update && type !== MsgType.SyncRequest && type !== MsgType.SyncResponse) {
    return null
  }
  return { type, payload: frame.subarray(1) }
}

export interface Point {
  x: number
  y: number
}

/**
 * A move/resize gesture in progress (world coordinates, never persisted). Same shape as
 * `@baren/canvas`'s `TransientChange`; the server validates and relays it unchanged.
 */
export interface TransientPresence {
  kind: 'move' | 'resize'
  nodes: { id: string; rect: { x: number; y: number; width: number; height: number } }[]
}

/**
 * An MCP agent working through a client (Phase 4, docs/phase4/contract.md §10.3): shown as an
 * agent avatar and as "<name> is working" on the artboards in `working`. Limits (the server drops
 * frames beyond them): ≤ 8 agents per client, `id`/`name` ≤ 64 bytes, ≤ 200 `working` ids of
 * ≤ 256 bytes each. Additive: old servers drop the field, old clients ignore it.
 */
export interface AgentWirePresence {
  /** The agent's presence id (12 base36 characters). */
  id: string
  name: string
  /** Artboard ids with an active working indicator. */
  working: string[]
}

/**
 * The world rectangle a client's canvas shows, so collaborators can follow it. Finite, size ≥ 0
 * (the server drops frames otherwise). Additive: old servers drop it, old clients ignore it.
 */
export interface ViewportPresence {
  x: number
  y: number
  width: number
  height: number
}

/** What a client reports about itself; identity is added by the server. */
export interface ClientPresence {
  pageId: string | null
  cursor: Point | null
  selection: string[]
  /** Absent or `null` when no gesture is in progress. */
  transient?: TransientPresence | null
  /** MCP agents working through this client; absent or empty when there are none. */
  agents?: AgentWirePresence[]
  /** Absent or `null` when unknown (e.g. the canvas is not mounted yet). */
  viewport?: ViewportPresence | null
}

/** One connected client, as fanned out by the server. */
export interface PeerPresence extends ClientPresence {
  /** Per connection: one user may have the file open in several windows. */
  clientId: string
  userId: string
  name: string
  /** Server-assigned per room, stable per user while connected. */
  color: string
}

export interface WelcomeMessage {
  type: 'welcome'
  clientId: string
  userId: string
  name: string
  color: string
  role: Role
}

export type ServerText =
  | WelcomeMessage
  | ({ type: 'presence' } & PeerPresence)
  | { type: 'leave'; clientId: string; userId: string }
  | { type: 'error'; code: string; message: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isViewport(value: unknown): value is ViewportPresence {
  if (!isRecord(value)) return false
  const { x, y, width, height } = value
  return (
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    (width as number) >= 0 &&
    (height as number) >= 0
  )
}

function isAgent(value: unknown): value is AgentWirePresence {
  return (
    isRecord(value) &&
    typeof value['id'] === 'string' &&
    typeof value['name'] === 'string' &&
    Array.isArray(value['working']) &&
    value['working'].every((w) => typeof w === 'string')
  )
}

/** Parse a server text frame; `null` for anything malformed or unknown. */
export function parseServerText(text: string): ServerText | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(value) || typeof value['type'] !== 'string') return null
  switch (value['type']) {
    case 'welcome':
    case 'leave':
      return typeof value['clientId'] === 'string' ? (value as ServerText) : null
    case 'presence': {
      if (typeof value['clientId'] !== 'string' || !Array.isArray(value['selection'])) return null
      // Agents and viewport are optional; malformed values are dropped, never the whole frame.
      const frame: Record<string, unknown> = { ...value }
      if ('agents' in value) {
        frame['agents'] = Array.isArray(value['agents']) ? value['agents'].filter(isAgent) : []
      }
      if ('viewport' in value && !isViewport(value['viewport'])) frame['viewport'] = null
      return frame as unknown as ServerText
    }
    case 'error':
      return typeof value['code'] === 'string' ? (value as ServerText) : null
    default:
      return null
  }
}
