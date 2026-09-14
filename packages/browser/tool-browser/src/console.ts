/**
 * Bounded per-tab Chrome console buffer. Listeners must be installed before
 * `Runtime.enable` so messages emitted from attachment onward are retained.
 * @module @deepseek-ai/dsh-tool-browser/console
 */

import type { BrowserCdpEvent } from '@deepseek-ai/dsh-browser'

/** One console line as `browser_console` presents it. */
export interface ConsoleMessage {
  readonly level: string
  readonly text: string
  readonly timestamp?: number
}

/** Resolved caps for one console buffer. */
export interface ConsoleCaptureOptions {
  /** Entries one tab retains before the oldest is dropped. */
  readonly maxEntries: number
}

/** Per-tab console buffer shared by the console tool. */
export interface ConsoleCapture {
  /**
   * Begin buffering one tab. Call before enabling Runtime/console events.
   * @param tabId - tab to buffer.
   */
  arm(tabId: string): void
  /**
   * Whether capture is on for one tab.
   * @param tabId - tab to test.
   */
  isArmed(tabId: string): boolean
  /**
   * Fold one forwarded CDP event into the buffers.
   * @param event - CDP event; unarmed tabs are ignored.
   */
  record(event: BrowserCdpEvent): void
  /**
   * Buffered messages for one tab.
   * @param tabId - tab whose buffer to read.
   * @param filter - optional substring, ignoring case.
   * @param limit - optional newest-kept ceiling.
   * @returns owned copies, oldest first.
   */
  list(tabId: string, filter?: string, limit?: number): readonly ConsoleMessage[]
  /**
   * Drop retained messages for one tab without disarming capture.
   * @param tabId - tab to clear.
   */
  clear(tabId: string): void
  /**
   * Forget one tab's buffer and capture state.
   * @param tabId - tab to forget.
   */
  drop(tabId: string): void
}

/**
 * Create an empty console capture holding no tab state.
 * @param options - resolved caps.
 * @returns the capture the console tool shares.
 */
export function createConsoleCapture(options: ConsoleCaptureOptions): ConsoleCapture {
  const buffers = new Map<string, ConsoleMessage[]>()
  return {
    arm(tabId) {
      if (!buffers.has(tabId)) buffers.set(tabId, [])
    },
    isArmed: tabId => buffers.has(tabId),
    record(event) {
      const buffer = buffers.get(String(event.tabId))
      if (buffer === undefined) return
      const message = fromEvent(event)
      if (message === undefined) return
      buffer.push(message)
      if (buffer.length > options.maxEntries) buffer.shift()
    },
    list(tabId, filter, limit) {
      const matched = (buffers.get(tabId) ?? []).filter(entry =>
        filter === undefined || entry.text.toLowerCase().includes(filter.toLowerCase())
        || entry.level.toLowerCase().includes(filter.toLowerCase()))
      const capped = limit !== undefined && matched.length > limit ? matched.slice(-limit) : matched
      return capped.map(entry => ({ ...entry }))
    },
    clear(tabId) {
      const buffer = buffers.get(tabId)
      if (buffer !== undefined) buffer.length = 0
    },
    drop(tabId) {
      buffers.delete(tabId)
    },
  }
}

function fromEvent(event: BrowserCdpEvent): ConsoleMessage | undefined {
  if (event.method === 'Runtime.consoleAPICalled') {
    const type = typeof event.params.type === 'string' ? event.params.type : 'log'
    const args = Array.isArray(event.params.args) ? event.params.args : []
    const text = args.map(argText).filter(part => part.length > 0).join(' ')
    const timestamp = typeof event.params.timestamp === 'number' ? event.params.timestamp : undefined
    return { level: type, text, ...timestamp !== undefined ? { timestamp } : {} }
  }
  if (event.method === 'Runtime.exceptionThrown') {
    const detail = asRecord(event.params.exceptionDetails)
    const text = typeof detail?.text === 'string'
      ? detail.text
      : typeof detail?.exception === 'object' && detail.exception !== null && 'description' in detail.exception
        && typeof (detail.exception as { description?: unknown }).description === 'string'
        ? (detail.exception as { description: string }).description
        : 'exception'
    return { level: 'error', text }
  }
  return undefined
}

function argText(arg: unknown): string {
  if (typeof arg !== 'object' || arg === null) return ''
  const record = arg as { value?: unknown; description?: unknown; type?: unknown }
  if (typeof record.value === 'string') return record.value
  if (typeof record.value === 'number' || typeof record.value === 'boolean') return String(record.value)
  if (record.value === null) return 'null'
  if (typeof record.description === 'string') return record.description
  if (typeof record.type === 'string') return record.type
  return ''
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}
