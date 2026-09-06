/**
 * Shared wire protocol for the Chrome native-messaging host and socket client.
 * @module @deepseek-ai/dsh-browser-chrome-extension/protocol
 */

export {
  FRAME_HEADER_BYTES,
  MAX_NATIVE_MESSAGE_BYTES,
  NATIVE_HOST_NAME,
  PROTOCOL_VERSION,
} from './constants.ts'
export { ChunkAssembler, chunkNativePayload, decodeFrames, encodeFrame } from './framing.ts'
export type { FrameDecodeResult } from './framing.ts'
export {
  isRpcNotification,
  isRpcRequest,
  isRpcResponse,
  protocolMismatch,
  rpcFailure,
  rpcNotify,
  rpcRequest,
  rpcSuccess,
} from './rpc.ts'
export type {
  BrowserRpcFailure,
  BrowserRpcMessage,
  BrowserRpcNotification,
  BrowserRpcRequest,
  BrowserRpcResponse,
  BrowserRpcSuccess,
} from './rpc.ts'
