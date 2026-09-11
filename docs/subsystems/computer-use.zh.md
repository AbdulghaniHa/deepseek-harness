# 电脑操控

[English](computer-use.md) | 中文

电脑操控 seam 是 `ctx.computer` 上的[能力 seam](../../.agents/notes/implemented/architecture/2026-09-06-computer-use-capability-seam.zh.md)：服务定义（[dsh-computer-use](../../packages/computer-use/computer-use)）、服务提供方（[dsh-computer-use-local](../../packages/computer-use/computer-use-local)）与消费者（[dsh-tool-computer-use](../../packages/computer-use/tool-computer-use)）。面向模型的 `computer_*` 名称保持稳定，原生 helper 留在提供方之后。电脑操控是一项可选能力，不是 agent-loop 脊柱的一部分。

来源：[`packages/computer-use/computer-use/src/types.ts`](../../packages/computer-use/computer-use/src/types.ts)

## 提供方与窗口

```ts type-equiv
/**
 * A computer-use backend. Registered with `ctx.computer.registerProvider`.
 * `id` is a stable string, unique within the registry.
 */
interface ComputerProvider {
  readonly id: string
  /** Cheap local usability check; must not talk to the OS GUI or the network. */
  available(): boolean
  /** Facets this backend can serve right now. */
  capabilities(): readonly ComputerCapability[]
  permissions(signal?: AbortSignal): Promise<ComputerPermissions>
  listApps(signal?: AbortSignal): Promise<readonly ComputerApp[]>
  listWindows(appId?: ComputerAppId, signal?: AbortSignal): Promise<readonly ComputerWindow[]>
  launchApp(request: ComputerLaunchRequest, signal?: AbortSignal): Promise<ComputerApp>
  focusWindow(windowId: ComputerWindowId, signal?: AbortSignal): Promise<void>
  windowAtPoint(x: number, y: number, signal?: AbortSignal): Promise<ComputerWindow | undefined>
  snapshot(request: ComputerSnapshotRequest, signal?: AbortSignal): Promise<ComputerSnapshot>
  screenshot(request: ComputerScreenshotRequest, signal?: AbortSignal): Promise<ComputerScreenshot>
  press(handle: string, signal?: AbortSignal): Promise<void>
  setValue(handle: string, text: string, signal?: AbortSignal): Promise<void>
  action(request: ComputerActionRequest, signal?: AbortSignal): Promise<void>
  click(request: ComputerClickRequest, signal?: AbortSignal): Promise<void>
  type(text: string, signal?: AbortSignal): Promise<void>
  key(request: ComputerKeyRequest, signal?: AbortSignal): Promise<void>
  scroll(request: ComputerScrollRequest, signal?: AbortSignal): Promise<void>
  drag(request: ComputerDragRequest, signal?: AbortSignal): Promise<void>
  move(request: ComputerPoint, signal?: AbortSignal): Promise<void>
  clipboardRead(signal?: AbortSignal): Promise<string>
  clipboardWrite(text: string, signal?: AbortSignal): Promise<void>
}
```

```ts type-equiv
/** One window as the seam presents it to consumers. */
interface ComputerWindow {
  readonly id: ComputerWindowId
  readonly appId: ComputerAppId
  readonly title: string
  readonly bounds: ComputerRect
  readonly focused: boolean
}
```

```ts type-equiv
/** One accessibility node as a provider returns it (opaque handle, no model ref). */
interface ComputerSnapshotNode {
  readonly handle: string
  readonly role: string
  readonly name: string
  readonly value?: string
  readonly bounds: ComputerRect
  readonly states: readonly string[]
  readonly supportsPress: boolean
  readonly supportsSetValue: boolean
  readonly actions: readonly ComputerA11yAction[]
  readonly secure: boolean
  readonly children?: readonly ComputerSnapshotNode[]
}
```

```ts type-equiv
/** One point in logical screen coordinates. */
interface ComputerPoint {
  readonly x: number
  readonly y: number
}
```

```ts type-equiv
/** Screenshot capture request. */
interface ComputerScreenshotRequest {
  readonly windowId?: ComputerWindowId
  readonly displayId?: number
  readonly region?: ComputerRect
}
```

运行时强制执行固定拒绝列表（终端应用与 harness 进程）、按 owner 授权，以及坐标命中测试，因此任何直接调用方都无法绕过工具。截图字节从不进入会话事件或 `presentationMeta`。

## 错误

`ComputerError` 继承 `HarnessError`，带开放字符串 `code`。共用代码覆盖不可用、缺失、不可用、歧义或重复的提供方、被拒绝的操作系统权限、固定拒绝列表、缺失授权、坐标命中不匹配、窗口消失、过期快照 ref、helper 崩溃，以及不受支持的平台能力。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxcomputer--computerruntime"></a>

### `ctx.computer` — `ComputerRuntime`

The computer-use access service. Registered as `ctx.computer` (one instance per context).

Selection semantics (resolved at execution time, never order-dependent):

- A configured id that is registered and `available()` → that provider.
- A configured id not registered → `COMPUTER_PROVIDER_CONFIGURED_MISSING`.
- A configured id registered but unavailable → `COMPUTER_PROVIDER_CONFIGURED_UNAVAILABLE`.
- No id configured, exactly one registered usable provider → that provider.
- No id configured, multiple usable providers → `COMPUTER_PROVIDER_AMBIGUOUS`.
- No id configured, no usable provider → `COMPUTER_PROVIDER_UNAVAILABLE`.

```ts cordis-catalog
/**
 * Register a computer-use provider. Throws {@link ComputerError}
 * `COMPUTER_DUPLICATE_PROVIDER` if its id is already registered. Returns a
 * disposer; disposed with the calling fiber.
 * @param provider - the provider; its `id` is the registry key.
 * @returns the disposer that unregisters the provider.
 */
registerProvider(provider: ComputerProvider): () => void

/**
 * Facets the selected provider currently advertises.
 * @returns the provider's capability list, or an empty list when none is usable.
 */
capabilities(): readonly ComputerCapability[]

/**
 * Probe OS permissions through the selected provider.
 * @param signal - optional cancellation forwarded to the provider.
 * @returns accessibility, screen-recording, and input-injection state.
 */
async permissions(signal?: AbortSignal): Promise<ComputerPermissions>

/**
 * Read-only discovery of the selected provider. Distinguishes a cheap
 * `available()` check from a bounded live permissions probe. Never throws
 * for a missing, ambiguous, or down provider.
 * @param signal - optional cancellation forwarded to the live probe.
 * @returns configured vs live status, advertised operations, and recovery.
 */
async status(signal?: AbortSignal): Promise<ComputerStatus>

/**
 * List running applications through the selected provider.
 * @param signal - optional cancellation forwarded to the provider.
 * @returns the current application list.
 */
async listApps(signal?: AbortSignal): Promise<readonly ComputerApp[]>

/**
 * List windows, optionally restricted to one application.
 * @param appId - optional application filter.
 * @param signal - optional cancellation forwarded to the provider.
 * @returns matching windows.
 */
async listWindows(appId?: ComputerAppId, signal?: AbortSignal): Promise<readonly ComputerWindow[]>

/**
 * Record a grant for `owner` on `appId`. Does not consume a `once` grant.
 * @param owner - exact Agent that received the grant.
 * @param appId - application the grant covers.
 * @param scope - once (next mutating call) or session.
 */
grant(owner: Agent, appId: ComputerAppId, scope: ComputerGrantScope): void

/**
 * Drop one owner grant.
 * @param owner - exact Agent that holds the grant.
 * @param appId - application to revoke.
 */
revoke(owner: Agent, appId: ComputerAppId): void

/**
 * Grants currently held by `owner`.
 * @param owner - exact Agent whose grants to list.
 * @returns a fresh snapshot of that owner's grants.
 */
listGrants(owner: Agent): readonly ComputerGrant[]

/**
 * Whether `owner` currently holds a grant for `appId`.
 * @param owner - exact Agent.
 * @param appId - application to check.
 * @returns true when a once or session grant is recorded.
 */
hasGrant(owner: Agent, appId: ComputerAppId): boolean

/**
 * Launch an application after the deny-list check. A grant is not required
 * because the launched identity is not known until the provider returns;
 * consumers then run the grant flow on the result.
 * @param owner - exact Agent that will own a later grant (reserved for deny ancestry).
 * @param request - application name.
 * @param signal - optional cancellation forwarded to the provider.
 * @returns the launched application.
 */
async launchApp(owner: Agent, request: ComputerLaunchRequest, signal?: AbortSignal): Promise<ComputerApp>

/**
 * Focus a window the owner is granted to use.
 * @param owner - exact Agent that owns the grant.
 * @param windowId - window to focus.
 * @param signal - optional cancellation forwarded to the provider.
 */
async focusWindow(owner: Agent, windowId: ComputerWindowId, signal?: AbortSignal): Promise<void>

/**
 * Accessibility snapshot of a granted window.
 * @param owner - exact Agent that owns the grant.
 * @param request - window, node cap, and optional query.
 * @param signal - optional cancellation forwarded to the provider.
 * @returns the snapshot.
 */
async snapshot(owner: Agent, request: ComputerSnapshotRequest, signal?: AbortSignal): Promise<ComputerSnapshot>

/**
 * Capture a screenshot. A window-scoped capture requires a grant; a full
 * display capture requires a grant on the focused window's app when one exists.
 * @param owner - exact Agent that owns the grant.
 * @param request - window, display, or region.
 * @param signal - optional cancellation forwarded to the provider.
 * @returns PNG bytes plus logical bounds.
 */
async screenshot(owner: Agent, request: ComputerScreenshotRequest, signal?: AbortSignal): Promise<ComputerScreenshot>

/**
 * Invoke the accessibility press action on a node in a granted window.
 * @param owner - exact Agent that owns the grant.
 * @param windowId - window that owns the node.
 * @param handle - provider node handle.
 * @param signal - optional cancellation forwarded to the provider.
 */
async press(owner: Agent, windowId: ComputerWindowId, handle: string, signal?: AbortSignal): Promise<void>

/**
 * Set an accessibility value on a node in a granted window.
 * @param owner - exact Agent that owns the grant.
 * @param windowId - window that owns the node.
 * @param handle - provider node handle.
 * @param text - replacement value.
 * @param signal - optional cancellation forwarded to the provider.
 */
async setValue(owner: Agent, windowId: ComputerWindowId, handle: string, text: string, signal?: AbortSignal): Promise<void>

/**
 * Invoke a named accessibility action on a node in a granted window.
 * @param owner - exact Agent that owns the grant.
 * @param windowId - window that owns the node.
 * @param request - handle, action, and optional setValue text.
 * @param signal - optional cancellation forwarded to the provider.
 */
async action(owner: Agent, windowId: ComputerWindowId, request: ComputerActionRequest, signal?: AbortSignal): Promise<void>

/**
 * Synthesized click after deny, grant, and hit-test checks.
 * @param owner - exact Agent that owns the grant.
 * @param windowId - declared target window.
 * @param request - coordinates and button.
 * @param signal - optional cancellation forwarded to the provider.
 */
async click(owner: Agent, windowId: ComputerWindowId, request: ComputerClickRequest, signal?: AbortSignal): Promise<void>

/**
 * Type text at the current focus after a grant check on `windowId`.
 * @param owner - exact Agent that owns the grant.
 * @param windowId - declared target window.
 * @param text - literal text.
 * @param signal - optional cancellation forwarded to the provider.
 */
async type(owner: Agent, windowId: ComputerWindowId, text: string, signal?: AbortSignal): Promise<void>

/**
 * Press a key after a grant check on `windowId`.
 * @param owner - exact Agent that owns the grant.
 * @param windowId - declared target window.
 * @param request - key and modifiers.
 * @param signal - optional cancellation forwarded to the provider.
 */
async key(owner: Agent, windowId: ComputerWindowId, request: ComputerKeyRequest, signal?: AbortSignal): Promise<void>

/**
 * Scroll after deny, grant, and hit-test checks.
 * @param owner - exact Agent that owns the grant.
 * @param windowId - declared target window.
 * @param request - coordinates, direction, and amount.
 * @param signal - optional cancellation forwarded to the provider.
 */
async scroll(owner: Agent, windowId: ComputerWindowId, request: ComputerScrollRequest, signal?: AbortSignal): Promise<void>

/**
 * Drag after deny, grant, and hit-test checks on both endpoints.
 * @param owner - exact Agent that owns the grant.
 * @param windowId - declared target window.
 * @param request - start and end coordinates.
 * @param signal - optional cancellation forwarded to the provider.
 */
async drag(owner: Agent, windowId: ComputerWindowId, request: ComputerDragRequest, signal?: AbortSignal): Promise<void>

/**
 * Move the pointer after deny, grant, and hit-test checks.
 * @param owner - exact Agent that owns the grant.
 * @param windowId - declared target window.
 * @param request - destination coordinates.
 * @param signal - optional cancellation forwarded to the provider.
 */
async move(owner: Agent, windowId: ComputerWindowId, request: ComputerPoint, signal?: AbortSignal): Promise<void>

/**
 * Read the clipboard. Observation-only; no grant is consumed.
 * @param signal - optional cancellation forwarded to the provider.
 * @returns clipboard text.
 */
async clipboardRead(signal?: AbortSignal): Promise<string>

/**
 * Write the clipboard. Requires a session-or-once grant on any currently
 * granted app so a grant-less agent cannot exfiltrate through the clipboard.
 * @param owner - exact Agent that owns at least one grant.
 * @param text - clipboard replacement.
 * @param signal - optional cancellation forwarded to the provider.
 */
async clipboardWrite(owner: Agent, text: string, signal?: AbortSignal): Promise<void>
```

Types: [Agent](core.zh.md)

Source: [`packages/computer-use/computer-use/src/index.ts`](../../packages/computer-use/computer-use/src/index.ts)
<!-- END GENERATED cordis-surface -->
