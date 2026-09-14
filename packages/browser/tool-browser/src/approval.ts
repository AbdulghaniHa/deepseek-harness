/**
 * One-shot approval before a side-effecting browser tool runs.
 * @module @deepseek-ai/dsh-tool-browser/approval
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'

/** The request method the browser tools need from `ctx.approval`. */
export interface BrowserApprover {
  request(req: ApprovalRequest): Promise<ApprovalOutcome>
}

/** When the consumer asks before a browser side effect. */
export type BrowserApprovalMode = 'always' | 'user-tabs' | 'never'

/**
 * Ask for approval when the mode requires it.
 * @param options - mode, optional approver, and the call identity.
 */
export async function approveBrowserAction(options: {
  readonly mode: BrowserApprovalMode
  readonly kind: 'user-tab' | 'agent-tab'
  readonly approval?: BrowserApprover
  readonly agent?: Agent
  readonly toolName: string
  readonly callId?: ToolCallId
  readonly reason: string
  readonly signal?: AbortSignal
}): Promise<void> {
  if (options.mode === 'never') return
  if (options.mode === 'user-tabs' && options.kind !== 'user-tab') return
  if (options.approval === undefined) {
    throw new Error(`browser action "${options.toolName}" requires approval, but no approval service is composed`)
  }
  if (options.agent === undefined) {
    throw new Error(`browser action "${options.toolName}" requires approval, but the call has no agent to route it through`)
  }
  /* jscpd:ignore-start -- approval request and outcomes are the shared user-approval vocabulary. */
  const outcome = await options.approval.request({
    agent: options.agent,
    toolName: options.toolName,
    reason: options.reason,
    ...options.callId !== undefined ? { callId: options.callId } : {},
    ...options.signal !== undefined ? { signal: options.signal } : {},
  })
  switch (outcome) {
    case 'allowed-once': return
    case 'rejected': throw new Error(`the user rejected ${options.toolName}`)
    case 'cancelled': throw new Error(`approval for ${options.toolName} was cancelled`)
    case 'unavailable': throw new Error(`${options.toolName} requires approval, but no approval channel is available`)
    default: {
      const exhaustive: never = outcome
      throw new Error(`unhandled approval outcome ${String(exhaustive)}`)
    }
  }
  /* jscpd:ignore-end */
}
