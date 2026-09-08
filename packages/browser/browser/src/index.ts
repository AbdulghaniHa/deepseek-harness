/**
 * Service Definition for the browser capability seam (`ctx.browser`): a provider
 * registry, owner-scoped tab attachments, and a CDP relay. Duplicate ids are
 * rejected. At execution time, a configured provider must exist and be usable;
 * without one, exactly one usable provider is required, so selection never
 * depends on registration order.
 * @module @deepseek-ai/dsh-browser
 */

import { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import z from '@deepseek-ai/schemastery'
import type { BrowserPreview, BrowserTabId as BrowserTabIdBrand } from './client.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {
  BrowserAttachment,
  BrowserAttachmentId as BrowserAttachmentIdBrand,
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
} from './types.ts'
import { BrowserError } from './types.ts'

export type { BrowserPreview } from './client.ts'
export {
  BrowserError,
} from './types.ts'
export type {
  BrowserAttachment,
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
} from './types.ts'

/** Opaque Chrome-tab identity minted by a provider and fenced by the seam. */
export type BrowserTabId = BrowserTabIdBrand

/** Opaque attachment identity minted by {@link BrowserRuntime} for one owner + tab. */
export type BrowserAttachmentId = BrowserAttachmentIdBrand

declare module '@deepseek-ai/cordis' {
  interface Context {
    browser: BrowserRuntime
  }
}

/** Selection inputs for execution-time provider resolution. */
interface Selection {
  readonly configuredId?: string
  readonly providers: ReadonlyMap<string, BrowserProvider>
}

/**
 * Config for the browser seam. `provider` pins which backend wins; it is
 * optional (a single registered usable provider auto-selects). Operational
 * overrides such as environment variables must feed this same field rather
 * than introduce a hidden priority chain.
 */
export interface BrowserRuntimeConfig {
  /** Explicit provider id. Omitted = auto-select when exactly one usable. */
  readonly provider?: string
  /** Maximum decoded PNG bytes returned by the chat preview. */
  readonly previewMaxBytes?: number
  /** Delay between visible chat preview refreshes, in milliseconds. */
  readonly previewIntervalMs?: number
}

interface AttachmentRecord extends BrowserAttachment {
  readonly tabId: BrowserTabId
}

/**
 * Brand one provider-issued tab id.
 * @param value - raw tab id from the selected provider.
 * @returns the same string with the browser-tab brand.
 */
export function BrowserTabId(value: string): BrowserTabId {
  return brandString<BrowserTabIdBrand>(value)
}

/**
 * Brand one registry-minted attachment id.
 * @param value - raw registry-issued id.
 * @returns the same string with the attachment brand.
 */
export function BrowserAttachmentId(value: string): BrowserAttachmentId {
  return brandString<BrowserAttachmentIdBrand>(value)
}

/**
 * The browser access service. Registered as `ctx.browser` (one instance per context).
 *
 * Selection semantics (resolved at execution time, never order-dependent):
 * - A configured id that is registered and `available()` → that provider.
 * - A configured id not registered → `BROWSER_PROVIDER_CONFIGURED_MISSING`.
 * - A configured id registered but unavailable →
 *   `BROWSER_PROVIDER_CONFIGURED_UNAVAILABLE`.
 * - No id configured, exactly one registered usable provider → that provider.
 * - No id configured, multiple usable providers → `BROWSER_PROVIDER_AMBIGUOUS`.
 * - No id configured, no usable provider → `BROWSER_PROVIDER_UNAVAILABLE`.
 */
export class BrowserRuntime extends TypertRemoteService {
  /**
   * Provider selection config. Operational env overrides feed the SAME field:
   * `$DSH_BROWSER_PROVIDER` is equivalent to `provider` and is NOT a hidden
   * priority chain.
   */
  static Config: z<BrowserRuntimeConfig> = z.object({
    provider: z.string(),
    previewMaxBytes: z.number().default(1_000_000),
    previewIntervalMs: z.number().default(2_000),
  })

  private providers = new Map<string, BrowserProvider>()
  private attachments = new Map<BrowserAttachmentId, AttachmentRecord>()
  private readonly providerId: string | undefined
  private readonly previewMaxBytes: number
  private readonly previewIntervalMs: number
  private readonly groupTabs = new WeakMap<Agent, Set<BrowserTabId>>()
  private readonly openings = new WeakMap<Agent, Promise<unknown>>()
  private readonly captures = new Map<BrowserTabId, Promise<unknown>>()
  private nextAttachment = 0
  private readonly eventListeners = new Set<(event: BrowserCdpEvent) => void>()
  private providerEventDisposers = new Map<string, () => void>()

  constructor(ctx: Context, config: BrowserRuntimeConfig = {}) {
    super(ctx, 'browser')
    this.providerId = config.provider ?? process.env.DSH_BROWSER_PROVIDER
    this.previewMaxBytes = config.previewMaxBytes ?? 1_000_000
    this.previewIntervalMs = config.previewIntervalMs ?? 2_000
    for (const [field, value] of [['previewMaxBytes', this.previewMaxBytes], ['previewIntervalMs', this.previewIntervalMs]] as const) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`browser: ${field} must be a positive integer`)
    }
    ctx.effect(() => () => { this.detachAll() }, 'browser teardown')
  }

  /**
   * Register a browser provider. Throws {@link BrowserError}
   * `BROWSER_DUPLICATE_PROVIDER` if its id is already registered. Returns a
   * disposer; disposed with the calling fiber.
   * @param provider - the provider; its `id` is the registry key.
   * @returns the disposer that unregisters the provider.
   */
  registerProvider(provider: BrowserProvider): () => void {
    if (this.providers.has(provider.id)) {
      throw new BrowserError(`a browser provider with id "${provider.id}" is already registered`, 'BROWSER_DUPLICATE_PROVIDER')
    }
    const dispose = this.ctx.effect(() => {
      this.providers.set(provider.id, provider)
      this.providerEventDisposers.set(provider.id, provider.onCdpEvent((event) => { this.forwardCdpEvent(event) }))
      return () => {
        this.providerEventDisposers.get(provider.id)?.()
        this.providerEventDisposers.delete(provider.id)
        this.providers.delete(provider.id)
      }
    }, 'browser.registerProvider()')
    return () => void dispose()
  }

  /**
   * List every open tab through the selected provider.
   * @param signal - optional cancellation forwarded to the provider.
   * @returns the current tab list.
   */
  async listTabs(signal?: AbortSignal): Promise<readonly BrowserTab[]> {
    return this.resolveProvider().listTabs(signal)
  }

  /**
   * Open a tab, attach it for `owner`, and return both identities.
   * @param owner - exact Agent that owns the new attachment.
   * @param request - destination URL and optional agent-group flag.
   * @param signal - optional cancellation forwarded to the provider.
   * @returns the opened tab and the minted attachment id.
   */
  async openTab(owner: Agent, request: BrowserOpenTabRequest, signal?: AbortSignal): Promise<{
    tab: BrowserTab
    attachmentId: BrowserAttachmentId
  }> {
    const previous = this.openings.get(owner) ?? Promise.resolve()
    const opening = previous.then(async () => {
      signal?.throwIfAborted()
      const provider = this.resolveProvider()
      const ownedTabs = this.groupTabs.get(owner)
      const groupWithTabId = request.group === true && ownedTabs !== undefined
        ? (await provider.listTabs(signal)).find(tab => ownedTabs.has(tab.id))?.id
        : undefined
      const tab = await provider.openTab({ ...request,
        ...groupWithTabId === undefined ? {} : { groupWithTabId },
      }, signal)
      if (request.group === true) {
        const tabs = ownedTabs ?? new Set<BrowserTabId>()
        tabs.add(tab.id)
        this.groupTabs.set(owner, tabs)
      }
      const attachmentId = await this.attach(owner, tab.id, signal)
      return { tab, attachmentId }
    })
    const settled = opening.then(() => undefined, () => undefined)
    this.openings.set(owner, settled)
    void settled.then(() => {
      if (this.openings.get(owner) === settled) this.openings.delete(owner)
    })
    return opening
  }

  /**
   * Attach `owner` to an existing tab. A second attach by the same owner
   * returns the existing attachment. The provider attach runs once per tab
   * while any owner holds it.
   * @param owner - exact Agent that owns the attachment.
   * @param tabId - tab to claim.
   * @param signal - optional cancellation forwarded to the provider.
   * @returns the attachment id authorizing later calls.
   */
  async attach(owner: Agent, tabId: BrowserTabId, signal?: AbortSignal): Promise<BrowserAttachmentId> {
    const existing = this.findAttachment(owner, tabId)
    if (existing !== undefined) return existing.id
    const provider = this.resolveProvider()
    const firstForTab = [...this.attachments.values()].every(record => record.tabId !== tabId)
    if (firstForTab) await provider.attach(tabId, signal)
    const id = BrowserAttachmentId(`browser-att-${++this.nextAttachment}`)
    this.attachments.set(id, { id, tabId, owner })
    return id
  }

  /**
   * Drop one owner attachment. The provider detaches the tab only when no
   * other attachment still holds it.
   * @param owner - exact Agent that created the attachment.
   * @param attachmentId - attachment to drop.
   * @param signal - optional cancellation forwarded to the provider detach.
   */
  async detach(owner: Agent, attachmentId: BrowserAttachmentId, signal?: AbortSignal): Promise<void> {
    const record = this.requireAttachment(owner, attachmentId)
    this.attachments.delete(attachmentId)
    const stillHeld = [...this.attachments.values()].some(item => item.tabId === record.tabId)
    if (!stillHeld) await this.resolveProvider().detach(record.tabId, signal)
  }

  /**
   * Close a tab the owner has attached. Drops every attachment on that tab.
   * @param owner - exact Agent that attached the tab.
   * @param tabId - tab to close.
   * @param signal - optional cancellation forwarded to the provider.
   */
  async closeTab(owner: Agent, tabId: BrowserTabId, signal?: AbortSignal): Promise<void> {
    this.requireTabOwner(owner, tabId)
    await this.resolveProvider().closeTab(tabId, signal)
    this.groupTabs.get(owner)?.delete(tabId)
    for (const [id, record] of this.attachments) {
      if (record.tabId === tabId) this.attachments.delete(id)
    }
  }

  /**
   * Send one CDP command on a tab the owner has attached.
   * @param owner - exact Agent that attached the tab.
   * @param request - method plus optional params.
   * @param signal - optional cancellation forwarded to the provider.
   * @returns the CDP result value.
   */
  async cdp(owner: Agent, request: BrowserCdpRequest, signal?: AbortSignal): Promise<unknown> {
    this.requireTabOwner(owner, request.tabId)
    return this.resolveProvider().cdp(request, signal)
  }

  /**
   * Capture an attached tab for a chat preview without activating Chrome.
   * `url` and `title` describe the tab after the capture, so a tab that had not
   * committed its URL yet reports the page it landed on.
   * @param agent - exact live Agent whose attachment authorizes the capture.
   * @param tabId - attached tab to preview.
   * @param signal - cancellation forwarded to Chrome.
   * @returns bounded PNG data and capture time; oversized captures throw.
   */
  @Remote('preview')
  async preview(agent: Agent, tabId: BrowserTabIdBrand, signal?: AbortSignal): Promise<BrowserPreview> {
    this.requireTabOwner(agent, tabId)
    const previous = this.captures.get(tabId) ?? Promise.resolve()
    const capture = previous.then(async () => {
      signal?.throwIfAborted()
      this.requireTabOwner(agent, tabId)
      const provider = this.resolveProvider()
      let tab = (await provider.listTabs(signal)).find(tab => tab.id === tabId)
      if (tab === undefined) throw new BrowserError('preview tab is closed', 'BROWSER_TAB_GONE')
      const result = await provider.cdp({ tabId, method: 'Page.captureScreenshot', params: {
        format: 'png', fromSurface: true, captureBeyondViewport: false,
      } }, signal) as { data?: unknown }
      if (typeof result.data !== 'string' || result.data.length === 0) {
        throw new BrowserError('Chrome returned no valid preview image', 'BROWSER_PREVIEW_UNAVAILABLE')
      }
      if (Buffer.byteLength(result.data, 'base64') > this.previewMaxBytes) {
        throw new BrowserError('preview exceeds previewMaxBytes', 'BROWSER_PREVIEW_TOO_LARGE')
      }
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(result.data) || result.data.length % 4 !== 0) {
        throw new BrowserError('Chrome returned no valid preview image', 'BROWSER_PREVIEW_UNAVAILABLE')
      }
      signal?.throwIfAborted()
      this.requireTabOwner(agent, tabId)
      // A tab opened moments ago has no committed URL yet; re-read identity so
      // the preview names the page instead of reporting an empty URL.
      if (tab.url === '') {
        tab = (await provider.listTabs(signal)).find(candidate => candidate.id === tabId) ?? tab
      }
      return { tabId, url: tab.url, title: tab.title, screenshot: result.data,
        capturedAt: Date.now(), refreshIntervalMs: this.previewIntervalMs }
    })
    const settled = capture.then(() => undefined, () => undefined)
    this.captures.set(tabId, settled)
    void settled.then(() => {
      if (this.captures.get(tabId) === settled) this.captures.delete(tabId)
    })
    return capture
  }

  /**
   * Reveal an attached tab in Chrome after an explicit user action.
   * @param agent - exact live Agent whose attachment authorizes the reveal.
   * @param tabId - attached tab to activate.
   * @param signal - cancellation forwarded to the provider.
   */
  @Remote('reveal')
  async reveal(agent: Agent, tabId: BrowserTabIdBrand, signal?: AbortSignal): Promise<void> {
    this.requireTabOwner(agent, tabId)
    const provider = this.resolveProvider()
    if (provider.revealTab === undefined) throw new BrowserError('provider cannot reveal tabs', 'BROWSER_FACET_UNAVAILABLE')
    await provider.revealTab(tabId, signal)
  }

  /**
   * Subscribe to CDP events from the selected provider.
   * @param listener - called with each forwarded event.
   * @returns disposer that removes this listener.
   */
  onCdpEvent(listener: (event: BrowserCdpEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => { this.eventListeners.delete(listener) }
  }

  /**
   * Facets the selected provider currently advertises.
   * @returns the provider's capability list, or an empty list when none is usable.
   */
  capabilities(): readonly BrowserCapability[] {
    try {
      return this.resolveProvider().capabilities()
    } catch (error) {
      if (error instanceof BrowserError) return []
      throw error
    }
  }

  /**
   * Search browsing history through the optional history facet.
   * @param query - history search string.
   * @param signal - optional cancellation forwarded to the provider.
   * @returns matching history items.
   */
  async historySearch(query: string, signal?: AbortSignal): Promise<readonly BrowserHistoryItem[]> {
    const provider = this.resolveProvider()
    if (provider.historySearch === undefined) {
      throw new BrowserError('the selected browser provider does not expose history', 'BROWSER_FACET_UNAVAILABLE')
    }
    return provider.historySearch(query, signal)
  }

  /**
   * List bookmarks through the optional bookmarks facet.
   * @param signal - optional cancellation forwarded to the provider.
   * @returns bookmark items.
   */
  async listBookmarks(signal?: AbortSignal): Promise<readonly BrowserBookmarkItem[]> {
    const provider = this.resolveProvider()
    if (provider.listBookmarks === undefined) {
      throw new BrowserError('the selected browser provider does not expose bookmarks', 'BROWSER_FACET_UNAVAILABLE')
    }
    return provider.listBookmarks(signal)
  }

  /**
   * Create one bookmark through the optional bookmarks facet.
   * @param item - title and URL.
   * @param signal - optional cancellation forwarded to the provider.
   * @returns the created bookmark.
   */
  async createBookmark(item: { readonly title: string; readonly url: string }, signal?: AbortSignal): Promise<BrowserBookmarkItem> {
    const provider = this.resolveProvider()
    if (provider.createBookmark === undefined) {
      throw new BrowserError('the selected browser provider does not expose bookmarks', 'BROWSER_FACET_UNAVAILABLE')
    }
    return provider.createBookmark(item, signal)
  }

  /**
   * List the reading list through the optional reading-list facet.
   * @param signal - optional cancellation forwarded to the provider.
   * @returns reading-list items.
   */
  async listReadingList(signal?: AbortSignal): Promise<readonly BrowserReadingListItem[]> {
    const provider = this.resolveProvider()
    if (provider.listReadingList === undefined) {
      throw new BrowserError('the selected browser provider does not expose the reading list', 'BROWSER_FACET_UNAVAILABLE')
    }
    return provider.listReadingList(signal)
  }

  /**
   * Add one reading-list entry through the optional reading-list facet.
   * @param item - title and URL.
   * @param signal - optional cancellation forwarded to the provider.
   * @returns the created entry.
   */
  async addReadingList(item: { readonly title: string; readonly url: string }, signal?: AbortSignal): Promise<BrowserReadingListItem> {
    const provider = this.resolveProvider()
    if (provider.addReadingList === undefined) {
      throw new BrowserError('the selected browser provider does not expose the reading list', 'BROWSER_FACET_UNAVAILABLE')
    }
    return provider.addReadingList(item, signal)
  }

  /**
   * List downloads through the optional downloads facet.
   * @param signal - optional cancellation forwarded to the provider.
   * @returns download items.
   */
  async listDownloads(signal?: AbortSignal): Promise<readonly BrowserDownloadItem[]> {
    const provider = this.resolveProvider()
    if (provider.listDownloads === undefined) {
      throw new BrowserError('the selected browser provider does not expose downloads', 'BROWSER_FACET_UNAVAILABLE')
    }
    return provider.listDownloads(signal)
  }

  /**
   * Attachments currently held by `owner`.
   * @param owner - exact Agent whose attachments to list.
   * @returns a fresh snapshot of that owner's attachments.
   */
  listAttachments(owner: Agent): readonly BrowserAttachment[] {
    return [...this.attachments.values()].filter(record => record.owner === owner)
  }

  private resolveProvider(): BrowserProvider {
    return resolveProvider({
      providers: this.providers,
      ...this.providerId !== undefined ? { configuredId: this.providerId } : {},
    })
  }

  private findAttachment(owner: Agent, tabId: BrowserTabId): AttachmentRecord | undefined {
    return [...this.attachments.values()].find(record => record.owner === owner && record.tabId === tabId)
  }

  private requireAttachment(owner: Agent, attachmentId: BrowserAttachmentId): AttachmentRecord {
    const record = this.attachments.get(attachmentId)
    if (record === undefined) {
      throw new BrowserError(`browser attachment "${attachmentId}" is not registered`, 'BROWSER_NOT_ATTACHED')
    }
    if (record.owner !== owner) {
      throw new BrowserError(`browser attachment "${attachmentId}" belongs to another agent`, 'BROWSER_FOREIGN_ATTACHMENT')
    }
    return record
  }

  private requireTabOwner(owner: Agent, tabId: BrowserTabId): AttachmentRecord {
    const record = this.findAttachment(owner, tabId)
    if (record === undefined) {
      throw new BrowserError(`agent is not attached to tab "${tabId}"`, 'BROWSER_NOT_ATTACHED')
    }
    return record
  }

  private forwardCdpEvent(event: BrowserCdpEvent): void {
    for (const listener of this.eventListeners) listener(event)
  }

  private detachAll(): void {
    this.attachments.clear()
    this.eventListeners.clear()
  }
}

/** Resolve the selected provider or throw the matching {@link BrowserError}. */
function resolveProvider(selection: Selection): BrowserProvider {
  const { configuredId, providers } = selection
  if (configuredId !== undefined) {
    const provider = providers.get(configuredId)
    if (!provider) {
      throw new BrowserError(`configured browser provider "${configuredId}" is not registered`, 'BROWSER_PROVIDER_CONFIGURED_MISSING')
    }
    if (!provider.available()) {
      throw new BrowserError(`configured browser provider "${configuredId}" is registered but unavailable`, 'BROWSER_PROVIDER_CONFIGURED_UNAVAILABLE')
    }
    return provider
  }
  const usable = [...providers.values()].filter(provider => provider.available())
  const [single] = usable
  if (single === undefined) {
    throw new BrowserError('no usable browser provider is registered', 'BROWSER_PROVIDER_UNAVAILABLE')
  }
  if (usable.length > 1) {
    const ids = usable.map(provider => provider.id).join(', ')
    throw new BrowserError(`multiple usable browser providers are registered (${ids}); configure one explicitly`, 'BROWSER_PROVIDER_AMBIGUOUS')
  }
  return single
}

export default BrowserRuntime
