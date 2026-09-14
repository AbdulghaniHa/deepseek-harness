/**
 * Newline-delimited JSON-RPC 2.0 envelopes for the computer-use helper.
 * @module @deepseek-ai/dsh-computer-use-local/protocol
 */

/** JSON-RPC protocol version carried on every request. */
export const PROTOCOL_VERSION = 1

/** A JSON-RPC request the helper or client may send. */
export interface ComputerRpcRequest {
  readonly jsonrpc: '2.0'
  readonly id: number
  readonly method: string
  readonly params?: unknown
  readonly protocolVersion: number
}

/** A successful JSON-RPC response. */
export interface ComputerRpcSuccess {
  readonly jsonrpc: '2.0'
  readonly id: number
  readonly result: unknown
}

/** A failed JSON-RPC response. */
export interface ComputerRpcFailure {
  readonly jsonrpc: '2.0'
  readonly id: number
  readonly error: { readonly code: string; readonly message: string }
}

/** A JSON-RPC success or failure response. */
export type ComputerRpcResponse = ComputerRpcSuccess | ComputerRpcFailure

/**
 * Build a request envelope.
 * @param id - caller-chosen request id.
 * @param method - RPC method name.
 * @param params - optional params.
 * @returns the request.
 */
export function rpcRequest(id: number, method: string, params?: unknown): ComputerRpcRequest {
  return {
    jsonrpc: '2.0',
    id,
    method,
    protocolVersion: PROTOCOL_VERSION,
    ...params !== undefined ? { params } : {},
  }
}

/**
 * Build a success response.
 * @param id - matching request id.
 * @param result - JSON result.
 * @returns the response.
 */
export function rpcSuccess(id: number, result: unknown): ComputerRpcSuccess {
  return { jsonrpc: '2.0', id, result }
}

/**
 * Build a failure response.
 * @param id - matching request id.
 * @param code - machine-routable code.
 * @param message - human-readable detail.
 * @returns the response.
 */
export function rpcFailure(id: number, code: string, message: string): ComputerRpcFailure {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

/**
 * Encode one JSON-RPC message as a newline-terminated line.
 * @param message - request or response.
 * @returns UTF-8 line including the trailing newline.
 */
export function encodeLine(message: ComputerRpcRequest | ComputerRpcResponse): string {
  return `${JSON.stringify(message)}\n`
}

/**
 * Split a buffer into complete JSON-RPC lines and leftover bytes.
 * @param chunk - newly read UTF-8 text.
 * @param pending - prior incomplete line.
 * @returns parsed messages and the new pending suffix.
 */
export function decodeLines(chunk: string, pending: string): {
  readonly messages: unknown[]
  readonly pending: string
} {
  const combined = pending + chunk
  const parts = combined.split('\n')
  /* v8 ignore next -- String#split always yields at least one element. */
  const nextPending = parts.pop() ?? ''
  const messages: unknown[] = []
  for (const part of parts) {
    if (part.length === 0) continue
    messages.push(JSON.parse(part) as unknown)
  }
  return { messages, pending: nextPending }
}

/**
 * Narrow a decoded value to a request.
 * @param value - decoded JSON.
 * @returns whether the value is a request.
 */
/* jscpd:ignore-start -- JSON-RPC request narrowing is identical on the browser extension protocol. */
export function isRpcRequest(value: unknown): value is ComputerRpcRequest {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return record.jsonrpc === '2.0'
    && typeof record.id === 'number'
    && typeof record.method === 'string'
    && typeof record.protocolVersion === 'number'
}

/**
 * Narrow a decoded value to a response.
 * @param value - decoded JSON.
 * @returns whether the value is a response.
 */
export function isRpcResponse(value: unknown): value is ComputerRpcResponse {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return record.jsonrpc === '2.0' && typeof record.id === 'number' && record.method === undefined
}
/* jscpd:ignore-end */

/**
 * Reject a request whose protocol version does not match this build.
 * @param request - decoded request.
 * @returns an error message when versions differ; otherwise undefined.
 */
export function protocolMismatch(request: ComputerRpcRequest): string | undefined {
  if (request.protocolVersion === PROTOCOL_VERSION) return undefined
  return `computer protocol version ${request.protocolVersion} does not match host ${PROTOCOL_VERSION}`
}
