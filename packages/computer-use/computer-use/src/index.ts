/**
 * Service Definition for the computer-use capability seam (`ctx.computer`): a
 * provider registry, per-owner app grants, the fixed deny list, and coordinate
 * hit-testing. Duplicate ids are rejected. At execution time, a configured
 * provider must exist and be usable; without one, exactly one usable provider
 * is required, so selection never depends on registration order.
 * @module @deepseek-ai/dsh-computer-use
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { isDeniedApp, isHarnessPid } from './deny.ts'
import type {
  ComputerActionRequest,
  ComputerApp,
  ComputerAppId as ComputerAppIdBrand,
  ComputerCapability,
  ComputerClickRequest,
  ComputerDragRequest,
  ComputerGrant,
  ComputerGrantScope,
  ComputerKeyRequest,
  ComputerLaunchRequest,
  ComputerPermissions,
  ComputerProvider,
  ComputerScreenshot,
  ComputerScreenshotRequest,
  ComputerScrollRequest,
  ComputerSnapshot,
  ComputerSnapshotRequest,
  ComputerStatus,
  ComputerWindow,
  ComputerWindowId as ComputerWindowIdBrand,
} from './types.ts'
import { ComputerError } from './types.ts'
import {
  connectionState,
  operationsForCapabilities,
  permissionIssues,
  recoveryForComputerCode,
  unsupportedOperationsForCapabilities,
} from './status.ts'

export { ComputerError } from './types.ts'
export { isDeniedApp, isHarnessPid, normalizeDenyToken, TERMINAL_DENY_IDS } from './deny.ts'
export type {
  ComputerA11yAction,
  ComputerActionRequest,
  ComputerApp,
  ComputerCapability,
  ComputerClickRequest,
  ComputerConnectionState,
  ComputerDragRequest,
  ComputerGrant,
  ComputerGrantScope,
  ComputerKeyRequest,
  ComputerLaunchRequest,
  ComputerOperation,
  ComputerPermissions,
  ComputerPermissionState,
  ComputerProvider,
  ComputerRect,
  ComputerScreenshot,
  ComputerScreenshotRequest,
  ComputerScrollRequest,
  ComputerSnapshot,
  ComputerSnapshotNode,
  ComputerSnapshotRequest,
  ComputerStatus,
  ComputerStatusIssue,
  ComputerWindow,
} from './types.ts'
export {
  connectionState,
  operationsForCapabilities,
  permissionIssues,
  recoveryForComputerCode,
  unsupportedOperationsForCapabilities,
} from './status.ts'

/** Opaque application identity minted by a provider and fenced by the seam. */
export type ComputerAppId = ComputerAppIdBrand

/** Opaque window identity minted by a provider and fenced by the seam. */
export type ComputerWindowId = ComputerWindowIdBrand

declare module '@deepseek-ai/cordis' {
  interface Context {
    computer: ComputerRuntime
  }
}

/** Selection inputs for execution-time provider resolution. */
interface Selection {
  readonly configuredId?: string
  readonly providers: ReadonlyMap<string, ComputerProvider>
}

/**
 * Config for the computer-use seam. `provider` pins which backend wins; it is
 * optional (a single registered usable provider auto-selects). Operational
 * overrides such as environment variables must feed this same field rather
 * than introduce a hidden priority chain.
 */
export interface ComputerRuntimeConfig {
  /** Explicit provider id. Omitted = auto-select when exactly one usable. */
  readonly provider?: string
  /** Extra deny tokens (bundle ids, names, or executable basenames) beyond the fixed terminal list. */
  readonly deniedApps?: string[]
}

/**
 * Brand one provider-issued app id.
 * @param value - raw app id from the selected provider.
 * @returns the same string with the computer-app brand.
 */
export function ComputerAppId(value: string): ComputerAppId {
  return brandString<ComputerAppIdBrand>(value)
}

/**
 * Brand one provider-issued window id.
 * @param value - raw window id from the selected provider.
 * @returns the same string with the computer-window brand.
 */
export function ComputerWindowId(value: string): ComputerWindowId {
  return brandString<ComputerWindowIdBrand>(value)
}

/**
 * The computer-use access service. Registered as `ctx.computer` (one instance per context).
 *
 * Selection semantics (resolved at execution time, never order-dependent):
 * - A configured id that is registered and `available()` → that provider.
 * - A configured id not registered → `COMPUTER_PROVIDER_CONFIGURED_MISSING`.
 * - A configured id registered but unavailable →
 *   `COMPUTER_PROVIDER_CONFIGURED_UNAVAILABLE`.
 * - No id configured, exactly one registered usable provider → that provider.
 * - No id configured, multiple usable providers → `COMPUTER_PROVIDER_AMBIGUOUS`.
 * - No id configured, no usable provider → `COMPUTER_PROVIDER_UNAVAILABLE`.
 */
export class ComputerRuntime extends Service {
  /**
   * Provider selection config. Operational env overrides feed the SAME field:
   * `$DSH_COMPUTER_PROVIDER` is equivalent to `provider` and is NOT a hidden
   * priority chain.
   */
  static Config: z<ComputerRuntimeConfig> = z.object({
    provider: z.string(),
    deniedApps: z.array(z.string()).default([]),
  })

  private providers = new Map<string, ComputerProvider>()
  private readonly grants = new WeakMap<Agent, Map<string, ComputerGrantScope>>()
  private readonly providerId: string | undefined
  private readonly extraDenied: readonly string[]

  constructor(ctx: Context, config: ComputerRuntimeConfig = {}) {
    super(ctx, 'computer')
    this.providerId = config.provider ?? process.env.DSH_COMPUTER_PROVIDER
    this.extraDenied = config.deniedApps ?? []
    ctx.effect(() => () => this.providers.clear(), 'computer teardown')
  }

  /**
   * Register a computer-use provider. Throws {@link ComputerError}
   * `COMPUTER_DUPLICATE_PROVIDER` if its id is already registered. Returns a
   * disposer; disposed with the calling fiber.
   * @param provider - the provider; its `id` is the registry key.
   * @returns the disposer that unregisters the provider.
   */
  registerProvider(provider: ComputerProvider): () => void {
    if (this.providers.has(provider.id)) {
      throw new ComputerError(`a computer provider with id "${provider.id}" is already registered`, 'COMPUTER_DUPLICATE_PROVIDER')
    }
    const dispose = this.ctx.effect(() => {
      this.providers.set(provider.id, provider)
      return () => {
        this.providers.delete(provider.id)
      }
    }, 'computer.registerProvider()')
    return () => void dispose()
  }

  /**
   * Facets the selected provider currently advertises.
   * @returns the provider's capability list, or an empty list when none is usable.
   */
  capabilities(): readonly ComputerCapability[] {
    try {
      return this.resolveProvider().capabilities()
    } catch (error) {
      if (error instanceof ComputerError) return []
      throw error
    }
  }

  /**
   * Probe OS permissions through the selected provider.
   * @param signal - optional cancellation forwarded to the provider.
   * @returns accessibility, screen-recording, and input-injection state.
   */
  async permissions(signal?: AbortSignal): Promise<ComputerPermissions> {
    return this.resolveProvider().permissions(signal)
  }

  /**
   * Read-only discovery of the selected provider. Distinguishes a cheap
   * `available()` check from a bounded live permissions probe. Never throws
   * for a missing, ambiguous, or down provider.
   * @param signal - optional cancellation forwarded to the live probe.
   * @returns configured vs live status, advertised operations, and recovery.
   */
  async status(signal?: AbortSignal): Promise<ComputerStatus> {
    const registeredProviders = [...this.providers.keys()]
    const configuredProvider = this.providerId
    const empty = (issues: ComputerStatus['issues']): ComputerStatus => ({
      ...configuredProvider === undefined ? {} : { configuredProvider },
      registeredProviders,
      available: false,
      connection: 'unconfigured',
      capabilities: [],
      operations: [],
      unsupportedOperations: unsupportedOperationsForCapabilities([]),
      issues,
    })
    let provider: ComputerProvider
    try {
      provider = this.resolveProvider()
    } catch (error) {
      /* v8 ignore next -- resolveProvider throws ComputerError. */
      if (!(error instanceof ComputerError)) throw error
      return empty([{
        code: error.code,
        message: error.message,
        recovery: recoveryForComputerCode(error.code, configuredProvider),
      }])
    }
    const capabilities = provider.capabilities()
    const base: ComputerStatus = {
      ...configuredProvider === undefined ? {} : { configuredProvider },
      selectedProvider: provider.id,
      registeredProviders,
      available: true,
      connection: connectionState(true, false, false),
      capabilities,
      operations: operationsForCapabilities(capabilities),
      unsupportedOperations: unsupportedOperationsForCapabilities(capabilities),
      issues: [],
    }
    try {
      const permissions = await provider.permissions(signal)
      return {
        ...base,
        connection: connectionState(true, true, true),
        permissions,
        issues: permissionIssues(permissions, process.platform),
      }
    } catch (error) {
      const code = error instanceof ComputerError ? error.code : 'COMPUTER_HOST_CRASHED'
      const message = error instanceof Error ? error.message : String(error)
      return {
        ...base,
        connection: connectionState(true, true, false),
        issues: [{
          code,
          message,
          recovery: recoveryForComputerCode(code),
        }],
      }
    }
  }

  /**
   * List running applications through the selected provider.
   * @param signal - optional cancellation forwarded to the provider.
   * @returns the current application list.
   */
  async listApps(signal?: AbortSignal): Promise<readonly ComputerApp[]> {
    return this.resolveProvider().listApps(signal)
  }

  /**
   * List windows, optionally restricted to one application.
   * @param appId - optional application filter.
   * @param signal - optional cancellation forwarded to the provider.
   * @returns matching windows.
   */
  async listWindows(appId?: ComputerAppId, signal?: AbortSignal): Promise<readonly ComputerWindow[]> {
    return this.resolveProvider().listWindows(appId, signal)
  }

  /**
   * Record a grant for `owner` on `appId`. Does not consume a `once` grant.
   * @param owner - exact Agent that received the grant.
   * @param appId - application the grant covers.
   * @param scope - once (next mutating call) or session.
   */
  grant(owner: Agent, appId: ComputerAppId, scope: ComputerGrantScope): void {
    const existing = this.grants.get(owner) ?? new Map<string, ComputerGrantScope>()
    existing.set(appId, scope)
    this.grants.set(owner, existing)
  }

  /**
   * Drop one owner grant.
   * @param owner - exact Agent that holds the grant.
   * @param appId - application to revoke.
   */
  revoke(owner: Agent, appId: ComputerAppId): void {
    this.grants.get(owner)?.delete(appId)
  }

  /**
   * Grants currently held by `owner`.
   * @param owner - exact Agent whose grants to list.
   * @returns a fresh snapshot of that owner's grants.
   */
  listGrants(owner: Agent): readonly ComputerGrant[] {
    const held = this.grants.get(owner)
    if (held === undefined) return []
    return [...held.entries()].map(([appId, scope]) => ({
      appId: ComputerAppId(appId),
      scope,
      owner,
    }))
  }

  /**
   * Whether `owner` currently holds a grant for `appId`.
   * @param owner - exact Agent.
   * @param appId - application to check.
   * @returns true when a once or session grant is recorded.
   */
  hasGrant(owner: Agent, appId: ComputerAppId): boolean {
    return this.grants.get(owner)?.has(appId) === true
  }

  /**
   * Launch an application after the deny-list check. A grant is not required
   * because the launched identity is not known until the provider returns;
   * consumers then run the grant flow on the result.
   * @param owner - exact Agent that will own a later grant (reserved for deny ancestry).
   * @param request - application name.
   * @param signal - optional cancellation forwarded to the provider.
   * @returns the launched application.
   */
  async launchApp(owner: Agent, request: ComputerLaunchRequest, signal?: AbortSignal): Promise<ComputerApp> {
    void owner
    const app = await this.resolveProvider().launchApp(request, signal)
    if (isHarnessPid(app.pid) || isDeniedApp(app, this.extraDenied)) {
      throw new ComputerError(`application "${app.name}" is on the computer-use deny list`, 'COMPUTER_APP_DENIED')
    }
    return app
  }

  /**
   * Focus a window the owner is granted to use.
   * @param owner - exact Agent that owns the grant.
   * @param windowId - window to focus.
   * @param signal - optional cancellation forwarded to the provider.
   */
  async focusWindow(owner: Agent, windowId: ComputerWindowId, signal?: AbortSignal): Promise<void> {
    const window = await this.requireWindow(windowId, signal)
    this.assertAppAllowed(owner, await this.requireApp(window.appId, signal), { consumeOnce: true })
    await this.resolveProvider().focusWindow(windowId, signal)
  }

  /**
   * Accessibility snapshot of a granted window.
   * @param owner - exact Agent that owns the grant.
   * @param request - window, node cap, and optional query.
   * @param signal - optional cancellation forwarded to the provider.
   * @returns the snapshot.
   */
  async snapshot(owner: Agent, request: ComputerSnapshotRequest, signal?: AbortSignal): Promise<ComputerSnapshot> {
    const window = await this.requireWindow(request.windowId, signal)
    this.assertAppAllowed(owner, await this.requireApp(window.appId, signal), { consumeOnce: false })
    return this.resolveProvider().snapshot(request, signal)
  }

  /**
   * Capture a screenshot. A window-scoped capture requires a grant; a full
   * display capture requires a grant on the focused window's app when one exists.
   * @param owner - exact Agent that owns the grant.
   * @param request - window, display, or region.
   * @param signal - optional cancellation forwarded to the provider.
   * @returns PNG bytes plus logical bounds.
   */
  async screenshot(owner: Agent, request: ComputerScreenshotRequest, signal?: AbortSignal): Promise<ComputerScreenshot> {
    if (request.windowId !== undefined) {
      const window = await this.requireWindow(request.windowId, signal)
      this.assertAppAllowed(owner, await this.requireApp(window.appId, signal), { consumeOnce: false })
    }
    return this.resolveProvider().screenshot(request, signal)
  }

  /**
   * Invoke the accessibility press action on a node in a granted window.
   * @param owner - exact Agent that owns the grant.
   * @param windowId - window that owns the node.
   * @param handle - provider node handle.
   * @param signal - optional cancellation forwarded to the provider.
   */
  async press(owner: Agent, windowId: ComputerWindowId, handle: string, signal?: AbortSignal): Promise<void> {
    const window = await this.requireWindow(windowId, signal)
    this.assertAppAllowed(owner, await this.requireApp(window.appId, signal), { consumeOnce: true })
    await this.resolveProvider().press(handle, signal)
  }

  /**
   * Set an accessibility value on a node in a granted window.
   * @param owner - exact Agent that owns the grant.
   * @param windowId - window that owns the node.
   * @param handle - provider node handle.
   * @param text - replacement value.
   * @param signal - optional cancellation forwarded to the provider.
   */
  async setValue(owner: Agent, windowId: ComputerWindowId, handle: string, text: string, signal?: AbortSignal): Promise<void> {
    const window = await this.requireWindow(windowId, signal)
    this.assertAppAllowed(owner, await this.requireApp(window.appId, signal), { consumeOnce: true })
    await this.resolveProvider().setValue(handle, text, signal)
  }

  /**
   * Invoke a named accessibility action on a node in a granted window.
   * @param owner - exact Agent that owns the grant.
   * @param windowId - window that owns the node.
   * @param request - handle, action, and optional setValue text.
   * @param signal - optional cancellation forwarded to the provider.
   */
  async action(owner: Agent, windowId: ComputerWindowId, request: ComputerActionRequest, signal?: AbortSignal): Promise<void> {
    const window = await this.requireWindow(windowId, signal)
    this.assertAppAllowed(owner, await this.requireApp(window.appId, signal), { consumeOnce: true })
    await this.resolveProvider().action(request, signal)
  }

  /**
   * Synthesized click after deny, grant, and hit-test checks.
   * @param owner - exact Agent that owns the grant.
   * @param windowId - declared target window.
   * @param request - coordinates and button.
   * @param signal - optional cancellation forwarded to the provider.
   */
  async click(owner: Agent, windowId: ComputerWindowId, request: ComputerClickRequest, signal?: AbortSignal): Promise<void> {
    await this.assertCoordinateTarget(owner, windowId, request.x, request.y, signal)
    await this.resolveProvider().click(request, signal)
  }

  /**
   * Type text at the current focus after a grant check on `windowId`.
   * @param owner - exact Agent that owns the grant.
   * @param windowId - declared target window.
   * @param text - literal text.
   * @param signal - optional cancellation forwarded to the provider.
   */
  async type(owner: Agent, windowId: ComputerWindowId, text: string, signal?: AbortSignal): Promise<void> {
    const window = await this.requireWindow(windowId, signal)
    this.assertAppAllowed(owner, await this.requireApp(window.appId, signal), { consumeOnce: true })
    await this.resolveProvider().type(text, signal)
  }

  /**
   * Press a key after a grant check on `windowId`.
   * @param owner - exact Agent that owns the grant.
   * @param windowId - declared target window.
   * @param request - key and modifiers.
   * @param signal - optional cancellation forwarded to the provider.
   */
  async key(owner: Agent, windowId: ComputerWindowId, request: ComputerKeyRequest, signal?: AbortSignal): Promise<void> {
    const window = await this.requireWindow(windowId, signal)
    this.assertAppAllowed(owner, await this.requireApp(window.appId, signal), { consumeOnce: true })
    await this.resolveProvider().key(request, signal)
  }

  /**
   * Scroll after deny, grant, and hit-test checks.
   * @param owner - exact Agent that owns the grant.
   * @param windowId - declared target window.
   * @param request - coordinates, direction, and amount.
   * @param signal - optional cancellation forwarded to the provider.
   */
  async scroll(owner: Agent, windowId: ComputerWindowId, request: ComputerScrollRequest, signal?: AbortSignal): Promise<void> {
    await this.assertCoordinateTarget(owner, windowId, request.x, request.y, signal)
    await this.resolveProvider().scroll(request, signal)
  }

  /**
   * Drag after deny, grant, and hit-test checks on both endpoints.
   * @param owner - exact Agent that owns the grant.
   * @param windowId - declared target window.
   * @param request - start and end coordinates.
   * @param signal - optional cancellation forwarded to the provider.
   */
  async drag(owner: Agent, windowId: ComputerWindowId, request: ComputerDragRequest, signal?: AbortSignal): Promise<void> {
    await this.assertCoordinateTarget(owner, windowId, request.fromX, request.fromY, signal)
    await this.assertCoordinateTarget(owner, windowId, request.toX, request.toY, signal)
    await this.resolveProvider().drag(request, signal)
  }

  /**
   * Move the pointer after deny, grant, and hit-test checks.
   * @param owner - exact Agent that owns the grant.
   * @param windowId - declared target window.
   * @param request - destination coordinates.
   * @param signal - optional cancellation forwarded to the provider.
   */
  async move(owner: Agent, windowId: ComputerWindowId, request: { readonly x: number; readonly y: number }, signal?: AbortSignal): Promise<void> {
    await this.assertCoordinateTarget(owner, windowId, request.x, request.y, signal)
    await this.resolveProvider().move(request, signal)
  }

  /**
   * Read the clipboard. Observation-only; no grant is consumed.
   * @param signal - optional cancellation forwarded to the provider.
   * @returns clipboard text.
   */
  async clipboardRead(signal?: AbortSignal): Promise<string> {
    return this.resolveProvider().clipboardRead(signal)
  }

  /**
   * Write the clipboard. Requires a session-or-once grant on any currently
   * granted app so a grant-less agent cannot exfiltrate through the clipboard.
   * @param owner - exact Agent that owns at least one grant.
   * @param text - clipboard replacement.
   * @param signal - optional cancellation forwarded to the provider.
   */
  async clipboardWrite(owner: Agent, text: string, signal?: AbortSignal): Promise<void> {
    const held = this.grants.get(owner)
    if (held === undefined || held.size === 0) {
      throw new ComputerError('clipboard write requires a granted application', 'COMPUTER_APP_NOT_ALLOWED')
    }
    await this.resolveProvider().clipboardWrite(text, signal)
  }

  private resolveProvider(): ComputerProvider {
    return resolveProvider({
      providers: this.providers,
      ...this.providerId !== undefined ? { configuredId: this.providerId } : {},
    })
  }

  private async requireWindow(windowId: ComputerWindowId, signal?: AbortSignal): Promise<ComputerWindow> {
    const windows = await this.resolveProvider().listWindows(undefined, signal)
    const window = windows.find(item => item.id === windowId)
    if (window === undefined) {
      throw new ComputerError(`window "${windowId}" is gone`, 'COMPUTER_WINDOW_GONE')
    }
    return window
  }

  private async requireApp(appId: ComputerAppId, signal?: AbortSignal): Promise<ComputerApp> {
    const apps = await this.resolveProvider().listApps(signal)
    const app = apps.find(item => item.id === appId)
    if (app === undefined) {
      throw new ComputerError(`application "${appId}" is gone`, 'COMPUTER_WINDOW_GONE')
    }
    return app
  }

  private assertAppAllowed(owner: Agent, app: ComputerApp, options: { consumeOnce: boolean }): void {
    if (isHarnessPid(app.pid) || isDeniedApp(app, this.extraDenied)) {
      throw new ComputerError(`application "${app.name}" is on the computer-use deny list`, 'COMPUTER_APP_DENIED')
    }
    const held = this.grants.get(owner)
    const scope = held?.get(app.id)
    if (scope === undefined) {
      throw new ComputerError(`agent is not granted access to "${app.name}"`, 'COMPUTER_APP_NOT_ALLOWED')
    }
    if (options.consumeOnce && scope === 'once') held?.delete(app.id)
  }

  private async assertCoordinateTarget(
    owner: Agent,
    windowId: ComputerWindowId,
    x: number,
    y: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const window = await this.requireWindow(windowId, signal)
    const app = await this.requireApp(window.appId, signal)
    this.assertAppAllowed(owner, app, { consumeOnce: true })
    const hit = await this.resolveProvider().windowAtPoint(x, y, signal)
    if (hit !== undefined && hit.appId !== window.appId) {
      throw new ComputerError(
        `coordinate (${x}, ${y}) hits "${hit.appId}" rather than the declared window's app "${window.appId}"`,
        'COMPUTER_TARGET_MISMATCH',
      )
    }
  }
}

/** Resolve the selected provider or throw the matching {@link ComputerError}. */
function resolveProvider(selection: Selection): ComputerProvider {
  const { configuredId, providers } = selection
  if (configuredId !== undefined) {
    const provider = providers.get(configuredId)
    if (!provider) {
      throw new ComputerError(`configured computer provider "${configuredId}" is not registered`, 'COMPUTER_PROVIDER_CONFIGURED_MISSING')
    }
    if (!provider.available()) {
      throw new ComputerError(`configured computer provider "${configuredId}" is registered but unavailable`, 'COMPUTER_PROVIDER_CONFIGURED_UNAVAILABLE')
    }
    return provider
  }
  const usable = [...providers.values()].filter(provider => provider.available())
  const [single] = usable
  if (single === undefined) {
    throw new ComputerError('no usable computer provider is registered', 'COMPUTER_PROVIDER_UNAVAILABLE')
  }
  if (usable.length > 1) {
    const ids = usable.map(provider => provider.id).join(', ')
    throw new ComputerError(`multiple usable computer providers are registered (${ids}); configure one explicitly`, 'COMPUTER_PROVIDER_AMBIGUOUS')
  }
  return single
}

export default ComputerRuntime
