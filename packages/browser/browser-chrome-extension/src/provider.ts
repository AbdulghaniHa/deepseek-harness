/**
 * `ctx.browser` provider that talks to the Chrome native host over a local socket.
 * @module @deepseek-ai/dsh-browser-chrome-extension/provider
 */

import { BrowserError, BrowserDownloadId, BrowserTabId } from '@deepseek-ai/dsh-browser'
import type {
  BrowserBookmarkItem,
  BrowserCapability,
  BrowserCdpEvent,
  BrowserCdpRequest,
  BrowserDownloadItem,
  BrowserHistoryItem,
  BrowserOpenTabRequest,
  BrowserProvider,
  BrowserReadingListItem,
  BrowserTab,
} from '@deepseek-ai/dsh-browser'
import { BrowserHostClient } from './socket.ts'

/** Shipped provider id. */
export const CHROME_EXTENSION_PROVIDER_ID = 'chrome-extension'

/** Runtime knobs the plugin resolved from Config. */
export interface ChromeExtensionProviderOptions {
  readonly socketPath: string
  readonly connectTimeoutMs: number
  readonly requestTimeoutMs: number
  readonly tabGroupTitle: string
  readonly clientId: string
}

/**
 * Chrome-extension backend. Connects lazily on first use, reconnects on the
 * next call after the socket drops, and throws `BROWSER_NOT_CONNECTED` when the
 * native host is not listening.
 */
export class ChromeExtensionProvider implements BrowserProvider {
  readonly id = CHROME_EXTENSION_PROVIDER_ID
  private readonly client = new BrowserHostClient()
  private connecting: Promise<void> | undefined
  private readonly listeners = new Set<(event: BrowserCdpEvent) => void>()

  constructor(private readonly options: ChromeExtensionProviderOptions) {
    this.client.onNotification((message) => {
      if (message.method !== 'debugger.event') return
      const params = message.params as BrowserCdpEvent | undefined
      if (params === undefined) return
      for (const listener of this.listeners) listener(params)
    })
  }

  /**
   * The shipped backend is always selectable. Connect happens on the first
   * method call and throws `BROWSER_NOT_CONNECTED` when the host is down.
   * @returns true.
   */
  available(): boolean {
    return true
  }

  /**
   * Facets this backend always advertises. Chrome may still refuse a facet at
   * call time if the user denied the matching permission.
   * @returns the full facet list.
   */
  capabilities(): readonly BrowserCapability[] {
    return ['tabs', 'cdp', 'history', 'bookmarks', 'readingList', 'downloads', 'notifications']
  }

  async listTabs(signal?: AbortSignal): Promise<readonly BrowserTab[]> {
    const rows = await this.call('tabs.list', undefined, signal) as readonly BrowserTab[]
    return rows.map(normalizeTab)
  }

  async openTab(request: BrowserOpenTabRequest, signal?: AbortSignal): Promise<BrowserTab> {
    const tab = await this.call('tabs.create', {
      url: request.url,
      group: request.group === true,
      groupTitle: this.options.tabGroupTitle,
      ...request.groupWithTabId === undefined ? {} : { groupWithTabId: request.groupWithTabId },
    }, signal) as BrowserTab
    return normalizeTab(tab)
  }

  async revealTab(tabId: ReturnType<typeof BrowserTabId>, signal?: AbortSignal): Promise<void> {
    await this.call('tabs.activate', { tabId }, signal)
  }

  async attach(tabId: ReturnType<typeof BrowserTabId>, signal?: AbortSignal): Promise<void> {
    await this.call('debugger.attach', { tabId }, signal)
  }

  async detach(tabId: ReturnType<typeof BrowserTabId>, signal?: AbortSignal): Promise<void> {
    await this.call('debugger.detach', { tabId }, signal)
  }

  async closeTab(tabId: ReturnType<typeof BrowserTabId>, signal?: AbortSignal): Promise<void> {
    await this.call('tabs.close', { tabId }, signal)
  }

  async cdp(request: BrowserCdpRequest, signal?: AbortSignal): Promise<unknown> {
    return this.call('debugger.sendCommand', request, signal)
  }

  onCdpEvent(listener: (event: BrowserCdpEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async historySearch(query: string, signal?: AbortSignal): Promise<readonly BrowserHistoryItem[]> {
    return await this.call('history.search', { query }, signal) as readonly BrowserHistoryItem[]
  }

  async listBookmarks(signal?: AbortSignal): Promise<readonly BrowserBookmarkItem[]> {
    return await this.call('bookmarks.list', undefined, signal) as readonly BrowserBookmarkItem[]
  }

  async createBookmark(item: { readonly title: string; readonly url: string }, signal?: AbortSignal): Promise<BrowserBookmarkItem> {
    return await this.call('bookmarks.create', item, signal) as BrowserBookmarkItem
  }

  async listReadingList(signal?: AbortSignal): Promise<readonly BrowserReadingListItem[]> {
    return await this.call('readingList.list', undefined, signal) as readonly BrowserReadingListItem[]
  }

  async addReadingList(item: { readonly title: string; readonly url: string }, signal?: AbortSignal): Promise<BrowserReadingListItem> {
    return await this.call('readingList.add', item, signal) as BrowserReadingListItem
  }

  async listDownloads(signal?: AbortSignal): Promise<readonly BrowserDownloadItem[]> {
    const rows = await this.call('downloads.list', undefined, signal) as readonly BrowserDownloadItem[]
    return rows.map(normalizeDownload)
  }

  async getDownload(id: ReturnType<typeof BrowserDownloadId>, signal?: AbortSignal): Promise<BrowserDownloadItem | undefined> {
    const row = await this.call('downloads.get', { id }, signal)
    return row === null || row === undefined ? undefined : normalizeDownload(row as BrowserDownloadItem)
  }

  /**
   * Connect once, wrapping a failure in `BROWSER_NOT_CONNECTED`.
   * @returns a promise that settles with the socket established or fails typed.
   */
  private async connectOnce(): Promise<void> {
    try {
      await this.client.connect(this.options.socketPath, this.options.connectTimeoutMs)
    } catch (error) {
      /* v8 ignore next -- createConnection rejects with Error. */
      const message = error instanceof Error ? error.message : String(error)
      throw new BrowserError(
        `Chrome native host is not connected (${message})`,
        'BROWSER_NOT_CONNECTED',
        {
          /* v8 ignore next -- createConnection rejects with Error. */
          cause: error instanceof Error ? error : undefined,
        },
      )
    }
  }

  /**
   * Ensure a live socket. A connect attempt is shared with concurrent callers
   * only while it is in flight, so a dropped socket reconnects on the next call
   * instead of awaiting an already-settled attempt.
   */
  private async ensureConnected(): Promise<void> {
    if (this.client.connected()) return
    const attempt = this.connectOnce()
    this.connecting = attempt
    try {
      await attempt
    } finally {
      if (this.connecting === attempt) this.connecting = undefined
    }
    /* v8 ignore start -- connectOnce resolves only after the socket is up. */
    if (!this.client.connected()) {
      throw new BrowserError('Chrome native host is not connected', 'BROWSER_NOT_CONNECTED')
    }
    /* v8 ignore stop */
  }

  private async call(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown> {
    await this.ensureConnected()
    try {
      return await this.client.request(method, params, {
        clientId: this.options.clientId,
        timeoutMs: this.options.requestTimeoutMs,
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error) {
      /* v8 ignore next -- request() rejects with Error, never BrowserError. */
      if (error instanceof BrowserError) throw error
      /* v8 ignore next -- request() rejects with Error. */
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('not connected') || message.includes('socket closed') || message.includes('connect')) {
        throw new BrowserError(message, 'BROWSER_NOT_CONNECTED', {
          /* v8 ignore next -- request() rejects with Error. */
          cause: error instanceof Error ? error : undefined,
        })
      }
      if (message.includes('No tab with id') || message.includes('TAB_GONE')) {
        throw new BrowserError(message, 'BROWSER_TAB_GONE', {
          /* v8 ignore next -- request() rejects with Error. */
          cause: error instanceof Error ? error : undefined,
        })
      }
      throw new BrowserError(message, 'BROWSER_PROTOCOL', {
        /* v8 ignore next -- request() rejects with Error. */
        cause: error instanceof Error ? error : undefined,
      })
    }
  }
}

function normalizeTab(tab: BrowserTab): BrowserTab {
  return { ...tab, id: BrowserTabId(String(tab.id)) }
}

function normalizeDownload(item: BrowserDownloadItem): BrowserDownloadItem {
  const state = item.state === 'interrupted' || item.state === 'complete' ? item.state : 'in_progress'
  return {
    ...item,
    id: BrowserDownloadId(String(item.id)),
    state,
  }
}
