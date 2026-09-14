/**
 * Vocabulary for the computer-use capability seam (`ctx.computer`). One
 * registry owns provider selection, per-owner app grants, the fixed deny
 * list, and coordinate hit-testing so desktop automation never binds to a
 * vendor input library.
 * @module @deepseek-ai/dsh-computer-use/types
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { HarnessError } from '@deepseek-ai/dsh-llm'

/** Opaque application identity minted by a provider and fenced by the seam. */
export type ComputerAppId = Branded<'ComputerAppId'>

/** Opaque window identity minted by a provider and fenced by the seam. */
export type ComputerWindowId = Branded<'ComputerWindowId'>

/** Opaque display identity minted by a provider and fenced by helper lifetime. */
export type ComputerDisplayId = Branded<'ComputerDisplayId'>

/**
 * Optional desktop facets a provider may advertise. The seam reports the
 * selected provider's set; a missing facet fails at the call, not at load.
 */
export type ComputerCapability =
  | 'a11y'
  | 'screenshot'
  | 'input'
  | 'clipboard'
  | 'background-actions'

/** Accessibility action a captured node may advertise. */
export type ComputerA11yAction = 'activate' | 'toggle' | 'select' | 'expandCollapse' | 'setValue'

/** Named desktop operation a status report may list as supported or blocked. */
export type ComputerOperation =
  | 'listApps'
  | 'listWindows'
  | 'launchApp'
  | 'focusWindow'
  | 'listDisplays'
  | 'setWindowBounds'
  | 'snapshot'
  | 'screenshot'
  | 'action'
  | 'focusElement'
  | 'click'
  | 'type'
  | 'key'
  | 'scroll'
  | 'drag'
  | 'move'
  | 'clipboardRead'
  | 'clipboardWrite'

/** Key synthesis: a full press, or an isolated down/up held until released. */
export type ComputerKeyAction = 'press' | 'down' | 'up'

/**
 * Configured vs live connection for the selected provider.
 * `configured` means `available()` succeeded; `live` means a bounded probe
 * reached the helper; `probe-failed` means the cheap check passed and the
 * probe did not.
 */
export type ComputerConnectionState = 'unconfigured' | 'configured' | 'live' | 'probe-failed'

/** One recovery-bearing issue from {@link ComputerStatus}. */
export interface ComputerStatusIssue {
  readonly code: string
  readonly message: string
  readonly recovery: string
}

/**
 * Read-only discovery result. Distinguishes a cheap `available()` check from a
 * bounded live probe. Never throws for a missing or down provider.
 */
export interface ComputerStatus {
  readonly configuredProvider?: string
  readonly selectedProvider?: string
  readonly registeredProviders: readonly string[]
  readonly available: boolean
  readonly connection: ComputerConnectionState
  readonly capabilities: readonly ComputerCapability[]
  readonly operations: readonly ComputerOperation[]
  readonly unsupportedOperations: readonly ComputerOperation[]
  readonly permissions?: ComputerPermissions
  readonly issues: readonly ComputerStatusIssue[]
}

/** OS permission probe outcome for one desktop capability. */
export type ComputerPermissionState = 'granted' | 'denied' | 'unknown' | 'not-required'

/** Current OS permission state as the provider reports it. */
export interface ComputerPermissions {
  readonly accessibility: ComputerPermissionState
  readonly screenRecording: ComputerPermissionState
  readonly inputInjection: ComputerPermissionState
}

/** One point in logical screen coordinates. */
export interface ComputerPoint {
  readonly x: number
  readonly y: number
}

/** Axis-aligned rectangle in logical screen coordinates. */
export interface ComputerRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** One running application as the seam presents it to consumers. */
export interface ComputerApp {
  readonly id: ComputerAppId
  readonly name: string
  readonly pid: number
  readonly bundleId?: string
  readonly path?: string
}

/** One window as the seam presents it to consumers. */
export interface ComputerWindow {
  readonly id: ComputerWindowId
  readonly appId: ComputerAppId
  readonly title: string
  readonly bounds: ComputerRect
  readonly focused: boolean
}

/** One display as the seam presents it to consumers. */
export interface ComputerDisplay {
  readonly id: ComputerDisplayId
  readonly bounds: ComputerRect
  readonly scale: number
  readonly primary: boolean
}

/** What one backend is asked when launching an application. */
export interface ComputerLaunchRequest {
  readonly name: string
}

/** Accessibility snapshot request against one window. */
export interface ComputerSnapshotRequest {
  readonly windowId: ComputerWindowId
  readonly maxNodes: number
  readonly query?: string
  /**
   * Include nodes through this depth (root is 0). Omitted means no depth cap.
   * Output caps do not bound the native library's full-tree traversal.
   */
  readonly maxDepth?: number
  /** Walk this node as the subtree root; omitted walks the window root. */
  readonly rootHandle?: string
  /** Abort native traversal after this many milliseconds and return a truncated tree. */
  readonly timeoutMs?: number
}

/** One accessibility node as a provider returns it (opaque handle, no model ref). */
export interface ComputerSnapshotNode {
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

/** Window accessibility tree as the seam presents it to consumers. */
export interface ComputerSnapshot {
  readonly windowId: ComputerWindowId
  readonly appId: ComputerAppId
  readonly title: string
  readonly nodes: readonly ComputerSnapshotNode[]
  readonly truncated: boolean
}

/** Screenshot capture request. */
export interface ComputerScreenshotRequest {
  readonly windowId?: ComputerWindowId
  readonly displayId?: ComputerDisplayId
  readonly region?: ComputerRect
}

/** PNG screenshot plus the logical region it covers. */
export interface ComputerScreenshot {
  readonly png: Uint8Array
  readonly width: number
  readonly height: number
  readonly scale: number
  readonly bounds: ComputerRect
}

/** Synthesized pointer click. */
export interface ComputerClickRequest {
  readonly x: number
  readonly y: number
  readonly button?: 'left' | 'right' | 'middle'
  readonly count?: number
  readonly modifiers?: readonly string[]
}

/** Synthesized key press, or an isolated down/up. */
export interface ComputerKeyRequest {
  readonly key: string
  readonly modifiers?: readonly string[]
  readonly repeat?: number
  /** Defaults to a full press (down then up). */
  readonly action?: ComputerKeyAction
}

/** Synthesized scroll. */
export interface ComputerScrollRequest {
  readonly x: number
  readonly y: number
  readonly direction: 'up' | 'down' | 'left' | 'right'
  readonly amount: number
  readonly modifiers?: readonly string[]
}

/** Synthesized drag. */
export interface ComputerDragRequest {
  readonly fromX: number
  readonly fromY: number
  readonly toX: number
  readonly toY: number
  readonly modifiers?: readonly string[]
}

/** Accessibility action against one captured node handle. */
export interface ComputerActionRequest {
  readonly handle: string
  readonly action: ComputerA11yAction
  readonly value?: string
}

/** Grant duration stored by the runtime. */
export type ComputerGrantScope = 'once' | 'session'

/** One owner grant currently held by the runtime. */
export interface ComputerGrant {
  readonly appId: ComputerAppId
  readonly scope: ComputerGrantScope
  readonly owner: Agent
}

/**
 * A computer-use backend. Registered with `ctx.computer.registerProvider`.
 * `id` is a stable string, unique within the registry.
 */
export interface ComputerProvider {
  readonly id: string
  /** Cheap local usability check; must not talk to the OS GUI or the network. */
  available(): boolean
  /** Facets this backend can serve right now. */
  capabilities(): readonly ComputerCapability[]
  permissions(signal?: AbortSignal): Promise<ComputerPermissions>
  listApps(signal?: AbortSignal): Promise<readonly ComputerApp[]>
  listWindows(appId?: ComputerAppId, signal?: AbortSignal): Promise<readonly ComputerWindow[]>
  listDisplays(signal?: AbortSignal): Promise<readonly ComputerDisplay[]>
  launchApp(request: ComputerLaunchRequest, signal?: AbortSignal): Promise<ComputerApp>
  focusWindow(windowId: ComputerWindowId, signal?: AbortSignal): Promise<void>
  setWindowBounds(windowId: ComputerWindowId, bounds: ComputerRect, signal?: AbortSignal): Promise<void>
  windowAtPoint(x: number, y: number, signal?: AbortSignal): Promise<ComputerWindow | undefined>
  snapshot(request: ComputerSnapshotRequest, signal?: AbortSignal): Promise<ComputerSnapshot>
  screenshot(request: ComputerScreenshotRequest, signal?: AbortSignal): Promise<ComputerScreenshot>
  press(handle: string, signal?: AbortSignal): Promise<void>
  setValue(handle: string, text: string, signal?: AbortSignal): Promise<void>
  focusElement(handle: string, signal?: AbortSignal): Promise<void>
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

/**
 * Typed computer-use error with a machine-routable, open-string `code` and chained `cause`.
 * Shared codes cover unavailable, missing, unusable, ambiguous, or duplicate
 * providers, denied OS permissions, the fixed deny list, a missing grant, a
 * coordinate hit-test mismatch, held input belonging to another owner,
 * changed window geometry, a vanished or ambiguous window, a stale snapshot
 * ref, a crashed helper, an unsupported accessibility action, and an
 * unsupported platform facet.
 */
export class ComputerError extends HarnessError {}
