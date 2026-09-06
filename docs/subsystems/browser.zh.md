# 浏览器

[English](browser.md) | 中文

浏览器 seam 是 `ctx.browser` 上的[能力 seam](../../.agents/notes/implemented/architecture/2026-09-06-browser-capability-seam.zh.md)：Service Definition（[dsh-browser](../../packages/browser/browser)）、Service Provider（[dsh-browser-chrome-extension](../../packages/browser/browser-chrome-extension)）和 Consumer（[dsh-tool-browser](../../packages/browser/tool-browser)）。面向模型的 `browser_*` 名称保持稳定，传输（Chrome Native Messaging 加本地套接字）留在提供方之后。浏览器是一项可选能力，不是 agent-loop 脊柱的一部分。

来源：[`packages/browser/browser/src/types.ts`](../../packages/browser/browser/src/types.ts)

## 提供方与标签页

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
  openTab(request: BrowserOpenTabRequest, signal?: AbortSignal): Promise<BrowserTab>
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

按 owner 限定的附件把 `attach` / `openTab` / `cdp` / `closeTab` 围栏到精确的 `Agent` 对象。任一 owner 持有标签页时，提供方只 attach 一次；最后一次 detach 才调用提供方 `detach`。可选的 Chrome API 侧面（`history`、`bookmarks`、`readingList`、`downloads`）在所选提供方未声明时，于调用处失败，错误码为 `BROWSER_FACET_UNAVAILABLE`。

## 错误

`BrowserError` 继承 `HarnessError`，带开放字符串 `code`。共享码覆盖不可用、缺失、不可用、歧义或重复的提供方、未连接的 host、已消失的标签页、过期的快照 ref，以及外 owner 附件使用。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Types: [Agent](core.zh.md)

Source: [`packages/browser/browser/src/index.ts`](../../packages/browser/browser/src/index.ts)
<!-- END GENERATED cordis-surface -->
