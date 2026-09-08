# Browser

English | [中文](browser.zh.md)

The browser seam is a [capability seam](../../.agents/notes/implemented/architecture/2026-09-06-browser-capability-seam.md) on `ctx.browser`: Service Definition ([dsh-browser](../../packages/browser/browser)), Service Provider ([dsh-browser-chrome-extension](../../packages/browser/browser-chrome-extension)), and Consumer ([dsh-tool-browser](../../packages/browser/tool-browser)). The model-facing `browser_*` names stay stable while the transport (Chrome Native Messaging plus a local socket) stays behind the provider. Browser is one optional capability, not part of the agent-loop spine.

Source: [`packages/browser/browser/src/types.ts`](../../packages/browser/browser/src/types.ts)

## Provider and tab

```ts type-equiv
/**
 * A browser-capable backend. Registered with `ctx.browser.registerProvider`.
 * `id` is a stable string, unique within the registry.
 */
interface BrowserProvider {
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
}
```

```ts type-equiv
/** One open tab as the seam presents it to consumers. */
interface BrowserTab {
  readonly id: BrowserTabId
  readonly url: string
  readonly title: string
  readonly active: boolean
  readonly windowId: number
  readonly grouped: boolean
}
```

```ts type-equiv
/** What one backend is asked when opening a tab. */
interface BrowserOpenTabRequest {
  readonly url: string
  /** When true, the provider places the tab in the agent tab group. */
  readonly group?: boolean
  /** Reuse this agent-created tab's group when it still exists. */
  readonly groupWithTabId?: BrowserTabId
}
```

```ts type-equiv
/** One CDP command against an attached tab. */
interface BrowserCdpRequest {
  readonly tabId: BrowserTabId
  readonly method: string
  readonly params?: Readonly<Record<string, unknown>>
}
```

Owner-scoped attachments fence `attach` / `openTab` / `cdp` / `closeTab` to the exact `Agent` object. The provider attaches a tab once while any owner holds it; the last detach calls provider `detach`. Optional Chrome-API facets (`history`, `bookmarks`, `readingList`, `downloads`) fail at the call with `BROWSER_FACET_UNAVAILABLE` when the selected provider does not advertise them.

```ts type-equiv
/** A transient chat preview; image bytes are never implicitly sent to the model. */
interface BrowserPreview {
  readonly tabId: BrowserTabId
  readonly url: string
  readonly title: string
  readonly screenshot: string
  readonly capturedAt: number
  readonly refreshIntervalMs: number
}
```

## Errors

`BrowserError` extends `HarnessError` with an open-string `code`. Shared codes cover unavailable, missing, unusable, ambiguous, or duplicate providers, a disconnected host, a vanished tab, a stale snapshot ref, and foreign-owner attachment use.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxbrowser--browserruntime"></a>

### `ctx.browser` — `BrowserRuntime`

The browser access service. Registered as `ctx.browser` (one instance per context).

Selection semantics (resolved at execution time, never order-dependent):

- A configured id that is registered and `available()` → that provider.
- A configured id not registered → `BROWSER_PROVIDER_CONFIGURED_MISSING`.
- A configured id registered but unavailable → `BROWSER_PROVIDER_CONFIGURED_UNAVAILABLE`.
- No id configured, exactly one registered usable provider → that provider.
- No id configured, multiple usable providers → `BROWSER_PROVIDER_AMBIGUOUS`.
- No id configured, no usable provider → `BROWSER_PROVIDER_UNAVAILABLE`.

```ts cordis-catalog
/**
 * Register a browser provider. Throws {@link BrowserError}
 * `BROWSER_DUPLICATE_PROVIDER` if its id is already registered. Returns a
 * disposer; disposed with the calling fiber.
 * @param provider - the provider; its `id` is the registry key.
 * @returns the disposer that unregisters the provider.
 */
registerProvider(provider: BrowserProvider): () => void

/**
 * List every open tab through the selected provider.
 * @param signal - optional cancellation forwarded to the provider.
 * @returns the current tab list.
 */
async listTabs(signal?: AbortSignal): Promise<readonly BrowserTab[]>

/**
 * Open a tab, attach it for `owner`, and return both identities.
 * @param owner - exact Agent that owns the new attachment.
 * @param request - destination URL and optional agent-group flag.
 * @param signal - optional cancellation forwarded to the provider.
 * @returns the opened tab and the minted attachment id.
 */
async openTab(owner: Agent, request: BrowserOpenTabRequest, signal?: AbortSignal): Promise<{ tab: BrowserTab attachmentId: BrowserAttachmentId }>

/**
 * Attach `owner` to an existing tab. A second attach by the same owner
 * returns the existing attachment. The provider attach runs once per tab
 * while any owner holds it.
 * @param owner - exact Agent that owns the attachment.
 * @param tabId - tab to claim.
 * @param signal - optional cancellation forwarded to the provider.
 * @returns the attachment id authorizing later calls.
 */
async attach(owner: Agent, tabId: BrowserTabId, signal?: AbortSignal): Promise<BrowserAttachmentId>

/**
 * Drop one owner attachment. The provider detaches the tab only when no
 * other attachment still holds it.
 * @param owner - exact Agent that created the attachment.
 * @param attachmentId - attachment to drop.
 * @param signal - optional cancellation forwarded to the provider detach.
 */
async detach(owner: Agent, attachmentId: BrowserAttachmentId, signal?: AbortSignal): Promise<void>

/**
 * Close a tab the owner has attached. Drops every attachment on that tab.
 * @param owner - exact Agent that attached the tab.
 * @param tabId - tab to close.
 * @param signal - optional cancellation forwarded to the provider.
 */
async closeTab(owner: Agent, tabId: BrowserTabId, signal?: AbortSignal): Promise<void>

/**
 * Send one CDP command on a tab the owner has attached.
 * @param owner - exact Agent that attached the tab.
 * @param request - method plus optional params.
 * @param signal - optional cancellation forwarded to the provider.
 * @returns the CDP result value.
 */
async cdp(owner: Agent, request: BrowserCdpRequest, signal?: AbortSignal): Promise<unknown>

/**
 * Capture an attached tab for a chat preview without activating Chrome.
 * `url` and `title` describe the tab after the capture, so a tab that had not
 * committed its URL yet reports the page it landed on.
 * @param agent - exact live Agent whose attachment authorizes the capture.
 * @param tabId - attached tab to preview.
 * @param signal - cancellation forwarded to Chrome.
 * @returns bounded PNG data and capture time; oversized captures throw.
 */
@Remote('preview') async preview(agent: Agent, tabId: BrowserTabIdBrand, signal?: AbortSignal): Promise<BrowserPreview>

/**
 * Reveal an attached tab in Chrome after an explicit user action.
 * @param agent - exact live Agent whose attachment authorizes the reveal.
 * @param tabId - attached tab to activate.
 * @param signal - cancellation forwarded to the provider.
 */
@Remote('reveal') async reveal(agent: Agent, tabId: BrowserTabIdBrand, signal?: AbortSignal): Promise<void>

/**
 * Subscribe to CDP events from the selected provider.
 * @param listener - called with each forwarded event.
 * @returns disposer that removes this listener.
 */
onCdpEvent(listener: (event: BrowserCdpEvent) => void): () => void

/**
 * Facets the selected provider currently advertises.
 * @returns the provider's capability list, or an empty list when none is usable.
 */
capabilities(): readonly BrowserCapability[]

/**
 * Search browsing history through the optional history facet.
 * @param query - history search string.
 * @param signal - optional cancellation forwarded to the provider.
 * @returns matching history items.
 */
async historySearch(query: string, signal?: AbortSignal): Promise<readonly BrowserHistoryItem[]>

/**
 * List bookmarks through the optional bookmarks facet.
 * @param signal - optional cancellation forwarded to the provider.
 * @returns bookmark items.
 */
async listBookmarks(signal?: AbortSignal): Promise<readonly BrowserBookmarkItem[]>

/**
 * Create one bookmark through the optional bookmarks facet.
 * @param item - title and URL.
 * @param signal - optional cancellation forwarded to the provider.
 * @returns the created bookmark.
 */
async createBookmark(item: { readonly title: string; readonly url: string }, signal?: AbortSignal): Promise<BrowserBookmarkItem>

/**
 * List the reading list through the optional reading-list facet.
 * @param signal - optional cancellation forwarded to the provider.
 * @returns reading-list items.
 */
async listReadingList(signal?: AbortSignal): Promise<readonly BrowserReadingListItem[]>

/**
 * Add one reading-list entry through the optional reading-list facet.
 * @param item - title and URL.
 * @param signal - optional cancellation forwarded to the provider.
 * @returns the created entry.
 */
async addReadingList(item: { readonly title: string; readonly url: string }, signal?: AbortSignal): Promise<BrowserReadingListItem>

/**
 * List downloads through the optional downloads facet.
 * @param signal - optional cancellation forwarded to the provider.
 * @returns download items.
 */
async listDownloads(signal?: AbortSignal): Promise<readonly BrowserDownloadItem[]>

/**
 * Attachments currently held by `owner`.
 * @param owner - exact Agent whose attachments to list.
 * @returns a fresh snapshot of that owner's attachments.
 */
listAttachments(owner: Agent): readonly BrowserAttachment[]
```

Types: [Agent](core.md)

Source: [`packages/browser/browser/src/index.ts`](../../packages/browser/browser/src/index.ts)
<!-- END GENERATED cordis-surface -->
