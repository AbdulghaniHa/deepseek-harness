/**
 * Bounded per-tab capture of Chrome DevTools Protocol Network events. One
 * capture belongs to the tool-browser plugin fiber: it buffers only tabs an
 * agent armed, retains the newest entries per tab, and is discarded with the
 * fiber. Chrome emits these events only for a tab with the debugger attached.
 * @module @deepseek-ai/dsh-tool-browser/network
 */

import type { BrowserCdpEvent } from '@deepseek-ai/dsh-browser'

/** One captured request as `browser_network` presents it. */
export interface NetworkRequestEntry {
  readonly requestId: string
  readonly method: string
  readonly url: string
  /** Chrome's CDP resource type, such as `Document`, `XHR`, or `Script`. */
  readonly resourceType: string
  readonly status?: number
  readonly statusText?: string
  readonly mimeType?: string
  /** CDP `errorText`, `canceled`, or `failed` when the request never completed. */
  readonly failed?: string
  /** Payload bytes Chrome reported once the request finished loading. */
  readonly encodedDataLength?: number
}

/** Buffer record mutated as the request's later events arrive. */
interface MutableEntry {
  requestId: string
  method: string
  url: string
  resourceType: string
  status?: number
  statusText?: string
  mimeType?: string
  failed?: string
  encodedDataLength?: number
}

/** Resolved caps for one capture. */
export interface NetworkCaptureOptions {
  /** Entries one tab retains before the oldest is dropped. */
  readonly maxRequests: number
}

/**
 * Per-tab request buffer shared by the network tools.
 */
export interface NetworkCapture {
  /**
   * Whether capture is on for one tab.
   * @param tabId - tab to test.
   * @returns true once {@link NetworkCapture.arm} ran for that tab.
   */
  isArmed(tabId: string): boolean
  /**
   * Begin buffering one tab. Call only after Chrome accepted `Network.enable`,
   * so a rejected enable leaves the tab unarmed and the next call retries.
   * @param tabId - tab to buffer.
   */
  arm(tabId: string): void
  /**
   * Fold one forwarded CDP event into the buffers.
   * @param event - CDP event; unarmed tabs and non-Network methods are ignored.
   */
  record(event: BrowserCdpEvent): void
  /**
   * Buffered entries for one tab.
   * @param tabId - tab whose buffer to read.
   * @returns owned copies, oldest first, empty for a tab that never armed.
   */
  list(tabId: string): readonly NetworkRequestEntry[]
  /**
   * Forget one tab's buffer and capture state, e.g. when its tab closes.
   * @param tabId - tab to forget.
   */
  drop(tabId: string): void
}

/**
 * Create an empty capture holding no tab state.
 * @param options - resolved caps.
 * @returns the capture the network tools share.
 */
export function createNetworkCapture(options: NetworkCaptureOptions): NetworkCapture {
  const buffers = new Map<string, MutableEntry[]>()
  return {
    isArmed: tabId => buffers.has(tabId),
    arm(tabId) {
      if (!buffers.has(tabId)) buffers.set(tabId, [])
    },
    record(event) {
      const buffer = buffers.get(event.tabId)
      if (buffer === undefined) return
      fold(buffer, event, options.maxRequests)
    },
    list: tabId => (buffers.get(tabId) ?? []).map(entry => ({ ...entry })),
    drop(tabId) {
      buffers.delete(tabId)
    },
  }
}

/**
 * Fold one CDP Network event into a tab buffer.
 * @param buffer - the tab's mutable entries in arrival order.
 * @param event - CDP event to reduce.
 * @param maxRequests - entry ceiling before the oldest is dropped.
 */
function fold(buffer: MutableEntry[], event: BrowserCdpEvent, maxRequests: number): void {
  const params = event.params
  if (typeof params.requestId !== 'string') return
  switch (event.method) {
    case 'Network.requestWillBeSent': {
      const request = asRecord(params.request)
      if (request === undefined || typeof request.method !== 'string' || typeof request.url !== 'string') return
      const entry: MutableEntry = {
        requestId: params.requestId,
        method: request.method,
        url: request.url,
        // Chrome reports its own `Network.ResourceType` casing, with `Other` as the enum's fallback.
        resourceType: typeof params.type === 'string' ? params.type : 'Other',
      }
      const existing = buffer.findIndex(item => item.requestId === params.requestId)
      if (existing >= 0) {
        // A redirect reuses the request id: the newest hop replaces the previous one.
        buffer[existing] = entry
        return
      }
      buffer.push(entry)
      if (buffer.length > maxRequests) buffer.shift()
      return
    }
    case 'Network.responseReceived': {
      const entry = buffer.find(item => item.requestId === params.requestId)
      if (entry === undefined) return
      const response = asRecord(params.response)
      if (response === undefined) return
      if (typeof response.status === 'number') entry.status = response.status
      if (typeof response.statusText === 'string') entry.statusText = response.statusText
      if (typeof response.mimeType === 'string') entry.mimeType = response.mimeType
      return
    }
    case 'Network.loadingFinished': {
      const entry = buffer.find(item => item.requestId === params.requestId)
      if (entry === undefined) return
      if (typeof params.encodedDataLength === 'number') entry.encodedDataLength = params.encodedDataLength
      return
    }
    case 'Network.loadingFailed': {
      const entry = buffer.find(item => item.requestId === params.requestId)
      if (entry === undefined) return
      entry.failed = typeof params.errorText === 'string'
        ? params.errorText
        : params.canceled === true ? 'canceled' : 'failed'
      return
    }
    default: return
  }
}

/**
 * Read one CDP payload field as a record.
 * @param value - payload field of unknown type.
 * @returns the record, or undefined when the field is not a record.
 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** One response body reduced to what the model may receive. */
export interface NetworkBodyResult {
  readonly encoding: 'utf8' | 'base64'
  /** Complete body size in bytes, before any truncation of a text body. */
  readonly bytes: number
  /** Whether `body` holds only the leading part of a larger text body. */
  readonly truncated: boolean
  readonly body?: string
}

/**
 * Reduce a `Network.getResponseBody` result to a bounded text body. A binary
 * body is reported by size and never inlined, because base64 payloads cost
 * tokens without carrying readable content.
 * @param result - CDP result carrying `body` and `base64Encoded`.
 * @param maxBytes - retention ceiling for a text body.
 * @returns the body, its complete byte size, and whether it was truncated.
 */
export function boundResponseBody(result: unknown, maxBytes: number): NetworkBodyResult {
  const record = asRecord(result)
  const body = typeof record?.body === 'string' ? record.body : ''
  if (record?.base64Encoded === true) {
    return { encoding: 'base64', bytes: Buffer.byteLength(body, 'base64'), truncated: false }
  }
  const decoded = Buffer.from(body, 'utf8')
  if (decoded.byteLength <= maxBytes) {
    return { encoding: 'utf8', bytes: decoded.byteLength, truncated: false, body }
  }
  // Streaming decode holds back a multi-byte character split by the byte bound
  // instead of emitting a replacement character for it.
  const retained = new TextDecoder().decode(decoded.subarray(0, maxBytes), { stream: true })
  return { encoding: 'utf8', bytes: decoded.byteLength, truncated: true, body: retained }
}
