/**
 * @baren/sync-client — typed REST client for the baren server and the WebSocket
 * live-sync client for Loro documents.
 *
 * Startup code that only needs the REST API should import `@baren/sync-client/api`,
 * which does not load `loro-crdt` (and its WASM) at all.
 */

export * from './api-entry.ts'
export {
  connectFile,
  type ConnectFileOptions,
  type FileConnection,
  type ServerErrorMessage,
  type StatusInfo,
  type SyncStatus,
} from './connect.ts'
export {
  CloseCode,
  MsgType,
  decodeFrame,
  encodeFrame,
  isTerminalClose,
  parseServerText,
  type AgentWirePresence,
  type ClientPresence,
  type DecodedFrame,
  type PeerPresence,
  type Point,
  type ServerText,
  type TransientPresence,
  type WelcomeMessage,
} from './protocol.ts'
export {
  fileSocketUrl,
  webSocketFactory,
  type SocketFactory,
  type SyncSocket,
  type SyncSocketEvents,
} from './socket.ts'
export { DEFAULT_BACKOFF, backoffDelay, type BackoffOptions } from './backoff.ts'
export { throttleLatest, type Throttled } from './throttle.ts'
