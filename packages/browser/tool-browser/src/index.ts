/**
 * Model-facing `browser_*` tools over `ctx.browser`. This package owns schemas,
 * prompt guidance, snapshot presentation, and approval gating, never the Chrome
 * transport. Tools stay registered when the selected provider is disconnected
 * and fail at execution with a structured `BrowserError`.
 * @module @deepseek-ai/dsh-tool-browser
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-browser'
import type {} from '@deepseek-ai/dsh-attachment'
import type { BrowserApprovalMode } from './approval.ts'
import { browserPrompt } from './prompt.ts'
import { registerBrowserTools } from './tools.ts'

export { approveBrowserAction } from './approval.ts'
export type { BrowserApprovalMode, BrowserApprover } from './approval.ts'
export { cdpClient, clickAt, dragAt, fillText, insertText, nodeCenter, pageIdentity, pressKey, scrollAt, selectAll, typeText, evaluateJson } from './cdp.ts'
export type { CdpClient, CdpSession } from './cdp.ts'
export { boundResponseBody, createNetworkCapture } from './network.ts'
export type { NetworkBodyResult, NetworkCapture, NetworkCaptureOptions, NetworkRequestEntry } from './network.ts'
export {
  browserMetaFromValue,
  formatNetworkBody,
  formatNetworkList,
  formatSnapshot,
  presentBrowserCall,
  presentBrowserResult,
} from './present.ts'
export type { BrowserToolMeta } from './present.ts'
export { BROWSER_PROMPT, browserPrompt } from './prompt.ts'
export { SNAPSHOT_REF, buildSnapshot, resolveRef, resolveRefFrom, viewSnapshot } from './snapshot.ts'
export type { AxNode, BrowserSnapshot, SnapshotNode } from './snapshot.ts'
export { waitForActionable } from './actionability.ts'
export type { ActionKind, ReadyTarget } from './actionability.ts'
export { createConsoleCapture } from './console.ts'
export type { ConsoleCapture, ConsoleCaptureOptions, ConsoleMessage } from './console.ts'
export { isOrdinaryLeftClick, modifierMask, shortcutModifier } from './input.ts'
export { createKeyedSerialQueue, createSerialQueue } from './queue.ts'
export { isImageCapableRoute } from './route.ts'
export { boundChars, boundUtf8, textContinuationId } from './text.ts'
export { flattenFrameTree, assertSameFrame } from './frames.ts'
export type { FrameTreeNode } from './frames.ts'
export { registerBrowserTools } from './tools.ts'
export type { ToolBrowserOptions } from './tools.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-browser'

/** Services required by the browser tool suite. */
export const inject = ['tools', 'browser', 'systemPrompt']

/** Default cooperative tool-call timeout budget (ms) for browser tools. */
export const DEFAULT_BROWSER_TOOL_TIMEOUT_MS = 30_000

/** Default cap on accessibility nodes in one snapshot. */
export const DEFAULT_SNAPSHOT_MAX_NODES = 200

/** Default cap on an inlined screenshot's decoded size. */
export const DEFAULT_SCREENSHOT_MAX_BYTES = 1_000_000

/** Default cap on Unicode characters in one snapshot field. */
export const DEFAULT_SNAPSHOT_MAX_FIELD_CHARS = 2_000

/** Default cap on UTF-8 bytes of one textual result. */
export const DEFAULT_TEXT_MAX_BYTES = 100_000

/** Default cap on buffered console entries per tab. */
export const DEFAULT_CONSOLE_MAX_ENTRIES = 200

/** Default cooperative timeout for `browser_evaluate`. */
export const DEFAULT_EVALUATE_TIMEOUT_MS = 15_000

/** Default ceiling on buffered requests per tab. */
export const DEFAULT_NETWORK_MAX_REQUESTS = 200

/** Default ceiling on a response body inlined by `browser_network_body`. */
export const DEFAULT_NETWORK_MAX_BODY_BYTES = 100_000

/** Plugin config: enablement, approval mode, snapshot/screenshot caps, and the raw-CDP hatch. */
export interface Config {
  /** Register the `browser_*` tools. Defaults to true. */
  enabled?: boolean
  /** When to ask before a browser side effect. */
  approval?: BrowserApprovalMode
  /** Upper bound on accessibility nodes in one snapshot. */
  snapshotMaxNodes?: number
  /** Upper bound on an inlined screenshot's decoded byte size. */
  screenshotMaxBytes?: number
  /** Upper bound on Unicode characters in one snapshot name or value. */
  snapshotMaxFieldChars?: number
  /** Upper bound on UTF-8 bytes of page text, evaluate results, and console lines. */
  textMaxBytes?: number
  /** Upper bound on console entries retained per tab. */
  consoleMaxEntries?: number
  /** Cooperative timeout budget (ms) for `browser_evaluate`. */
  evaluateTimeoutMs?: number
  /** Register the raw `browser_cdp` escape hatch. Defaults to false. */
  allowRawCdp?: boolean
  /** Upper bound on requests buffered per tab before the oldest is dropped. */
  networkMaxRequests?: number
  /** Upper bound on bytes of one response body returned by `browser_network_body`. */
  networkMaxBodyBytes?: number
  /** Cooperative timeout budget (ms) for the other browser tools. */
  timeoutMs?: number
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  approval: z.union(['always', 'user-tabs', 'never'] as const).default('never'),
  snapshotMaxNodes: z.number().default(DEFAULT_SNAPSHOT_MAX_NODES),
  screenshotMaxBytes: z.number().default(DEFAULT_SCREENSHOT_MAX_BYTES),
  snapshotMaxFieldChars: z.number().default(DEFAULT_SNAPSHOT_MAX_FIELD_CHARS),
  textMaxBytes: z.number().default(DEFAULT_TEXT_MAX_BYTES),
  consoleMaxEntries: z.number().default(DEFAULT_CONSOLE_MAX_ENTRIES),
  evaluateTimeoutMs: z.number().default(DEFAULT_EVALUATE_TIMEOUT_MS),
  allowRawCdp: z.boolean().default(false),
  networkMaxRequests: z.number().default(DEFAULT_NETWORK_MAX_REQUESTS),
  networkMaxBodyBytes: z.number().default(DEFAULT_NETWORK_MAX_BODY_BYTES),
  timeoutMs: z.number().default(DEFAULT_BROWSER_TOOL_TIMEOUT_MS),
})

/** Complete config after schemastery applies every field default. */
type ResolvedConfig = Required<Config>

/** Configured count and timeout caps must be positive integers. */
function assertPositiveInteger(field: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`tool-browser: ${field} must be a positive integer`)
  }
}

/**
 * Register the browser tools and their system-prompt guidance.
 * @param ctx - host context with tools, browser, and systemPrompt.
 * @param config - validated plugin config.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  assertPositiveInteger('snapshotMaxNodes', resolved.snapshotMaxNodes)
  assertPositiveInteger('screenshotMaxBytes', resolved.screenshotMaxBytes)
  assertPositiveInteger('snapshotMaxFieldChars', resolved.snapshotMaxFieldChars)
  assertPositiveInteger('textMaxBytes', resolved.textMaxBytes)
  assertPositiveInteger('consoleMaxEntries', resolved.consoleMaxEntries)
  assertPositiveInteger('evaluateTimeoutMs', resolved.evaluateTimeoutMs)
  assertPositiveInteger('networkMaxRequests', resolved.networkMaxRequests)
  assertPositiveInteger('networkMaxBodyBytes', resolved.networkMaxBodyBytes)
  assertPositiveInteger('timeoutMs', resolved.timeoutMs)
  if (!resolved.enabled) return
  ctx.systemPrompt.section({
    name: 'tool:browser',
    order: ctx.systemPrompt.getSectionOrder('TOOL_BROWSER'),
    text: browserPrompt(resolved.approval),
  })
  registerBrowserTools(ctx, resolved)
}
