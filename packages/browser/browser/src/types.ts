/**
 * Vocabulary for the browser capability seam (`ctx.browser`). One registry owns
 * provider selection, owner-scoped attachments, and the CDP relay so page
 * automation never binds to a vendor transport.
 * @module @deepseek-ai/dsh-browser/types
 */

import type { BrowserTabId } from './client.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { HarnessError } from '@deepseek-ai/dsh-llm'

/** Opaque Chrome-tab identity minted by a provider and fenced by the seam. */
export type { BrowserTabId, BrowserPreview } from './client.ts'

/** Opaque attachment identity minted by {@link BrowserRuntime} for one owner + tab. */
export type BrowserAttachmentId = Branded<'BrowserAttachmentId'>

/** Opaque document-frame identity minted by a provider and fenced by the seam. */
export type BrowserFrameId = Branded<'BrowserFrameId'>

/** Opaque Chrome-download identity minted by a provider and fenced by the seam. */
export type BrowserDownloadId = Branded<'BrowserDownloadId'>

/**
 * Optional Chrome-API facets a provider may advertise. The seam reports the
 * selected provider's set; a missing facet fails at the call, not at load.
 */
export type BrowserCapability =
  | 'tabs'
  | 'cdp'
  | 'history'
  | 'bookmarks'
  | 'readingList'
  | 'downloads'
  | 'notifications'

/** Named browser operation a status report may list as supported or blocked. */
export type BrowserOperation =
  | 'listTabs'
  | 'openTab'
  | 'attach'
  | 'cdp'
  | 'historySearch'
  | 'listBookmarks'
  | 'listReadingList'
  | 'listDownloads'

/**
 * Configured vs live connection for the selected provider.
 * `configured` means `available()` succeeded; `live` means a bounded probe
 * reached Chrome; `probe-failed` means the cheap check passed and the probe
 * did not.
 */
export type BrowserConnectionState = 'unconfigured' | 'configured' | 'live' | 'probe-failed'

/** One recovery-bearing issue from {@link BrowserStatus}. */
export interface BrowserStatusIssue {
  readonly code: string
  readonly message: string
  readonly recovery: string
}

/**
 * Read-only discovery result. Distinguishes a cheap `available()` check from a
 * bounded live probe. Never throws for a missing or disconnected provider.
 */
export interface BrowserStatus {
  readonly configuredProvider?: string
  readonly selectedProvider?: string
  readonly registeredProviders: readonly string[]
  readonly available: boolean
  readonly connection: BrowserConnectionState
  readonly capabilities: readonly BrowserCapability[]
  readonly operations: readonly BrowserOperation[]
  readonly unsupportedOperations: readonly BrowserOperation[]
  readonly issues: readonly BrowserStatusIssue[]
}

/** One open tab as the seam presents it to consumers. */
export interface BrowserTab {
  readonly id: BrowserTabId
  readonly url: string
  readonly title: string
  readonly active: boolean
  readonly windowId: number
  readonly grouped: boolean
}

/** What one backend is asked when opening a tab. */
export interface BrowserOpenTabRequest {
  readonly url: string
  /** When true, the provider places the tab in the agent tab group. */
  readonly group?: boolean
  /** Reuse this agent-created tab's group when it still exists. */
  readonly groupWithTabId?: BrowserTabId
}

/** One CDP command against an attached tab, optionally a child debugger session. */
export interface BrowserCdpRequest {
  readonly tabId: BrowserTabId
  readonly method: string
  readonly params?: Readonly<Record<string, unknown>>
  /** Flattened CDP session for a child target; omitted uses the tab session. */
  readonly sessionId?: string
  /** Chrome debugger target id when the command must not use the tab debuggee. */
  readonly targetId?: string
}

/** One CDP event forwarded from an attached tab or child session. */
export interface BrowserCdpEvent {
  readonly tabId: BrowserTabId
  readonly method: string
  readonly params: Readonly<Record<string, unknown>>
  readonly sessionId?: string
  readonly targetId?: string
}

/** One history hit from the optional history facet. */
export interface BrowserHistoryItem {
  readonly url: string
  readonly title: string
  readonly lastVisitTime: number
}

/** One bookmark from the optional bookmarks facet. */
export interface BrowserBookmarkItem {
  readonly id: string
  readonly title: string
  readonly url?: string
}

/** One reading-list entry from the optional reading-list facet. */
export interface BrowserReadingListItem {
  readonly url: string
  readonly title: string
  readonly hasBeenRead: boolean
}

/** One download from the optional downloads facet. */
export type BrowserDownloadState = 'in_progress' | 'interrupted' | 'complete'

/** One download from the optional downloads facet. */
export interface BrowserDownloadItem {
  readonly id: BrowserDownloadId
  readonly url: string
  readonly filename: string
  readonly state: BrowserDownloadState
  readonly bytesReceived?: number
  readonly totalBytes?: number
  readonly exists?: boolean
  readonly error?: string
  readonly filePath?: string
}

/** One document frame in an attached tab. */
export interface BrowserFrame {
  readonly frameId: BrowserFrameId
  readonly parentFrameId?: BrowserFrameId
  readonly url: string
  readonly name?: string
  readonly securityOrigin?: string
  readonly sessionId?: string
  readonly targetId?: string
}

/**
 * A browser-capable backend. Registered with `ctx.browser.registerProvider`.
 * `id` is a stable string, unique within the registry.
 */
export interface BrowserProvider {
  readonly id: string
  /** Cheap local usability check; must not talk to Chrome or the network. */
  available(): boolean
  /** Facets this backend can serve right now. */
  capabilities(): readonly BrowserCapability[]
  listTabs(signal?: AbortSignal): Promise<readonly BrowserTab[]>
  /** Open without changing the active tab or focused window. */
  openTab(request: BrowserOpenTabRequest, signal?: AbortSignal): Promise<BrowserTab>
  /** Activate the selected tab and focus its window only on explicit user request. */
  revealTab?(tabId: BrowserTabId, signal?: AbortSignal): Promise<void>
  attach(tabId: BrowserTabId, signal?: AbortSignal): Promise<void>
  detach(tabId: BrowserTabId, signal?: AbortSignal): Promise<void>
  closeTab(tabId: BrowserTabId, signal?: AbortSignal): Promise<void>
  cdp(request: BrowserCdpRequest, signal?: AbortSignal): Promise<unknown>
  onCdpEvent(listener: (event: BrowserCdpEvent) => void): () => void
  historySearch?(query: string, signal?: AbortSignal): Promise<readonly BrowserHistoryItem[]>
  listBookmarks?(signal?: AbortSignal): Promise<readonly BrowserBookmarkItem[]>
  createBookmark?(item: { readonly title: string; readonly url: string }, signal?: AbortSignal): Promise<BrowserBookmarkItem>
  listReadingList?(signal?: AbortSignal): Promise<readonly BrowserReadingListItem[]>
  addReadingList?(item: { readonly title: string; readonly url: string }, signal?: AbortSignal): Promise<BrowserReadingListItem>
  listDownloads?(signal?: AbortSignal): Promise<readonly BrowserDownloadItem[]>
  getDownload?(id: BrowserDownloadId, signal?: AbortSignal): Promise<BrowserDownloadItem | undefined>
}

/** Owner plus the tab the attachment authorizes. */
export interface BrowserAttachment {
  readonly id: BrowserAttachmentId
  readonly tabId: BrowserTabId
  readonly owner: Agent
}

/**
 * Typed browser error with a machine-routable, open-string `code` and chained `cause`.
 * Shared codes cover unavailable, missing, unusable, ambiguous, or duplicate
 * providers, a disconnected host, a vanished tab, a detached or navigated
 * frame, a stale snapshot ref, an unsupported drag target, an interrupted
 * download, and foreign-owner attachment use. Tool execution exposes the code
 * in structured error metadata.
 */
export class BrowserError extends HarnessError {}
