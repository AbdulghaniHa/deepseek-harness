/**
 * Model-facing `computer_*` tools over `ctx.computer`. This package owns schemas,
 * prompt guidance, snapshot presentation, and approval gating, never the native
 * helper. Tools stay registered when the selected provider is down and fail at
 * execution with a structured `ComputerError`.
 * @module @deepseek-ai/dsh-tool-computer-use
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-computer-use'
import type {} from '@deepseek-ai/dsh-attachment'
import type { ComputerApprovalMode } from './approval.ts'
import { COMPUTER_PROMPT } from './prompt.ts'
import { registerComputerTools } from './tools.ts'

export { approveComputerAction, ensureAppGrant } from './approval.ts'
export type { ComputerApprovalMode, ComputerApprover } from './approval.ts'
export { computerMetaFromValue, formatComputerSnapshot, presentComputerCall, presentComputerResult } from './present.ts'
export type { ComputerToolMeta } from './present.ts'
export { COMPUTER_PROMPT } from './prompt.ts'
export { SNAPSHOT_REF, buildComputerSnapshot, resolveRef } from './snapshot.ts'
export type { ComputerSnapshotRow, ComputerToolSnapshot } from './snapshot.ts'
export { assertImageCapableRoute } from './route.ts'
export { registerComputerTools } from './tools.ts'
export type { ToolComputerUseOptions } from './tools.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Session-scoped app grant recorded for UI replay. Log-only, whole-value
     * replace: the last `computer/app-grant` for an appId wins.
     * @param appId - provider app id the grant covers.
     * @param appName - display name at grant time.
     * @param scope - recorded grant duration; session grants are the only ones logged.
     */
    'computer/app-grant': {
      appId: string
      appName: string
      scope: 'once' | 'session'
    }
  }
}

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-computer-use'

/** Services required by the computer tool suite. */
export const inject = ['tools', 'computer', 'systemPrompt']

/** Default cooperative tool-call timeout budget (ms) for computer tools. */
export const DEFAULT_COMPUTER_TOOL_TIMEOUT_MS = 30_000

/** Default cap on accessibility nodes in one snapshot. */
export const DEFAULT_SNAPSHOT_MAX_NODES = 200

/** Default cap on a screenshot's encoded size. */
export const DEFAULT_SCREENSHOT_MAX_BYTES = 1_000_000

/** Plugin config: enablement, approval, grants, and capture caps. */
export interface Config {
  /** Register the `computer_*` tools. Defaults to true. */
  enabled?: boolean
  /** When to ask before a computer side effect. */
  approval?: ComputerApprovalMode
  /** Grant duration offered on first use of an app. */
  grantScope?: 'once' | 'session'
  /** Upper bound on accessibility nodes in one snapshot. */
  snapshotMaxNodes?: number
  /** Upper bound on a screenshot's encoded byte size. */
  screenshotMaxBytes?: number
  /** Cooperative timeout budget (ms) for computer tools. */
  timeoutMs?: number
  /** Extra deny tokens forwarded to `ctx.computer` are owned by that service. */
  deniedApps?: string[]
  /** When false, `computer_screenshot` refuses. */
  allowScreenCapture?: boolean
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  approval: z.union(['always', 'apps', 'never'] as const).default('apps'),
  grantScope: z.union(['once', 'session'] as const).default('session'),
  snapshotMaxNodes: z.number().default(DEFAULT_SNAPSHOT_MAX_NODES),
  screenshotMaxBytes: z.number().default(DEFAULT_SCREENSHOT_MAX_BYTES),
  timeoutMs: z.number().default(DEFAULT_COMPUTER_TOOL_TIMEOUT_MS),
  deniedApps: z.array(z.string()).default([]),
  allowScreenCapture: z.boolean().default(true),
})

/** Complete config after schemastery applies every field default. */
type ResolvedConfig = Required<Config>

/** Configured count and timeout caps must be positive integers. */
function assertPositiveInteger(field: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`tool-computer-use: ${field} must be a positive integer`)
  }
}

/**
 * Register the computer tools and their system-prompt guidance.
 * @param ctx - host context with tools, computer, and systemPrompt.
 * @param config - validated plugin config.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  assertPositiveInteger('snapshotMaxNodes', resolved.snapshotMaxNodes)
  assertPositiveInteger('screenshotMaxBytes', resolved.screenshotMaxBytes)
  assertPositiveInteger('timeoutMs', resolved.timeoutMs)
  if (!resolved.enabled) return
  ctx.systemPrompt.section({
    name: 'tool:computer',
    order: ctx.systemPrompt.getSectionOrder('TOOL_COMPUTER'),
    text: COMPUTER_PROMPT,
  })
  registerComputerTools(ctx, resolved)
}
