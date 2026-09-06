/**
 * JSON-RPC 2.0 envelopes for the browser bridge, plus version negotiation.
 * @module @deepseek-ai/dsh-browser-chrome-extension/protocol/rpc
 */

import { PROTOCOL_VERSION } from './constants.ts'

/** A JSON-RPC request the host, extension, or dsh client may send. */
export interface BrowserRpcRequest {
  readonly jsonrpc: '2.0'
  readonly id: number
  readonly method: string
  readonly params?: unknown
  readonly protocolVersion: number
  readonly clientId?: string
}

/** A successful JSON-RPC response. */
export interface BrowserRpcSuccess {
  readonly jsonrpc: '2.0'
  readonly id: number
  readonly result: unknown
}

/** A failed JSON-RPC response. */
export interface BrowserRpcFailure {
  readonly jsonrpc: '2.0'
  readonly id: number
  readonly error: { readonly code: number; readonly message: string }
}

/** A JSON-RPC notification (no id). */
export interface BrowserRpcNotification {
  readonly jsonrpc: '2.0'
  readonly method: string
  readonly params?: unknown
}

/** A JSON-RPC success or failure response. */
export type BrowserRpcResponse = BrowserRpcSuccess | BrowserRpcFailure

/** Any JSON-RPC message the browser bridge may decode. */
export type BrowserRpcMessage = BrowserRpcRequest | BrowserRpcResponse | BrowserRpcNotification

/**
 * Build a request envelope.
 * @param id - caller-chosen request id.
 * @param method - RPC method name.
 * @param params - optional params.
 * @param clientId - optional multiplexing client id.
 * @returns the request.
 */
export function rpcRequest(id: number, method: string, params?: unknown, clientId?: string): BrowserRpcRequest {
  return {
    jsonrpc: '2.0',
    id,
    method,
    protocolVersion: PROTOCOL_VERSION,
    ...params !== undefined ? { params } : {},
    ...clientId !== undefined ? { clientId } : {},
  }
}

/**
 * Build a success response.
 * @param id - matching request id.
 * @param result - JSON result.
 * @returns the response.
 */
export function rpcSuccess(id: number, result: unknown): BrowserRpcSuccess {
  return { jsonrpc: '2.0', id, result }
}

/**
 * Build a failure response.
 * @param id - matching request id.
 * @param code - machine-routable numeric code.
 * @param message - human-readable detail.
 * @returns the response.
 */
export function rpcFailure(id: number, code: number, message: string): BrowserRpcFailure {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

/**
 * Build a notification.
 * @param method - notification method.
 * @param params - optional params.
 * @returns the notification.
 */
export function rpcNotify(method: string, params?: unknown): BrowserRpcNotification {
  return { jsonrpc: '2.0', method, ...params !== undefined ? { params } : {} }
}

/**
 * Reject a request whose protocol version does not match this build.
 * @param request - decoded request.
 * @returns an error message when versions differ; otherwise undefined.
 */
export function protocolMismatch(request: BrowserRpcRequest): string | undefined {
  if (request.protocolVersion === PROTOCOL_VERSION) return undefined
  return `browser protocol version ${request.protocolVersion} does not match host ${PROTOCOL_VERSION}`
}

/**
 * Narrow a decoded value to a request.
 * @param value - decoded JSON.
 * @returns whether the value is a request.
 */
export function isRpcRequest(value: unknown): value is BrowserRpcRequest {
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
export function isRpcResponse(value: unknown): value is BrowserRpcResponse {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return record.jsonrpc === '2.0' && typeof record.id === 'number' && record.method === undefined
}

/**
 * Narrow a decoded value to a notification.
 * @param value - decoded JSON.
 * @returns whether the value is a notification.
 */
export function isRpcNotification(value: unknown): value is BrowserRpcNotification {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return record.jsonrpc === '2.0' && typeof record.method === 'string' && record.id === undefined
}
