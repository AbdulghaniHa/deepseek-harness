/**
 * Per-app grants and optional per-action approval for computer-use tools.
 * @module @deepseek-ai/dsh-tool-computer-use/approval
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ComputerApp, ComputerGrantScope, ComputerRuntime } from '@deepseek-ai/dsh-computer-use'
import { ComputerError } from '@deepseek-ai/dsh-computer-use'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { UserQuestionService } from '@deepseek-ai/dsh-user-questions'

/** The request method computer tools need from `ctx.approval`. */
export interface ComputerApprover {
  request(req: ApprovalRequest): Promise<ApprovalOutcome>
}

/** When the consumer asks before a computer side effect. */
export type ComputerApprovalMode = 'always' | 'apps' | 'never'

const ALLOW_ONCE = 'Allow once'
const ALLOW_SESSION = 'Allow for this session'
const DENY = 'Deny'

/**
 * Ask for a per-action approval when the mode is `always`.
 * @param options - mode, optional approver, and the call identity.
 */
export async function approveComputerAction(options: {
  readonly mode: ComputerApprovalMode
  readonly approval?: ComputerApprover
  readonly agent?: Agent
  readonly toolName: string
  readonly callId?: ToolCallId
  readonly reason: string
  readonly signal?: AbortSignal
}): Promise<void> {
  if (options.mode !== 'always') return
  if (options.approval === undefined) {
    throw new Error(`computer action "${options.toolName}" requires approval, but no approval service is composed`)
  }
  if (options.agent === undefined) {
    throw new Error(`computer action "${options.toolName}" requires approval, but the call has no agent to route it through`)
  }
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
}

/**
 * Ensure `owner` holds a grant for `app`, asking the user on first use.
 * @param options - runtime, owner, app, and composed interaction services.
 * @returns the grant that now covers the app.
 */
export async function ensureAppGrant(options: {
  readonly computer: ComputerRuntime
  readonly owner: Agent
  readonly app: ComputerApp
  readonly mode: ComputerApprovalMode
  readonly grantScope: ComputerGrantScope
  readonly userQuestions?: UserQuestionService
  readonly approval?: ComputerApprover
  readonly toolName: string
  readonly callId?: ToolCallId
  readonly signal?: AbortSignal
}): Promise<ComputerGrantScope> {
  if (options.mode === 'never') {
    if (!options.computer.hasGrant(options.owner, options.app.id)) {
      options.computer.grant(options.owner, options.app.id, 'session')
    }
    return 'session'
  }
  if (options.computer.hasGrant(options.owner, options.app.id)) {
    const held = options.computer.listGrants(options.owner).find(item => item.appId === options.app.id)
    /* v8 ignore next -- hasGrant is true only when listGrants still records the app. */
    return held?.scope ?? 'session'
  }
  const scope = await askForGrant(options)
  options.computer.grant(options.owner, options.app.id, scope)
  if (scope === 'session') {
    options.owner.session.append('computer/app-grant', {
      appId: options.app.id,
      appName: options.app.name,
      scope,
    })
  }
  return scope
}

async function askForGrant(options: {
  readonly owner: Agent
  readonly app: ComputerApp
  readonly grantScope: ComputerGrantScope
  readonly userQuestions?: UserQuestionService
  readonly approval?: ComputerApprover
  readonly toolName: string
  readonly callId?: ToolCallId
  readonly signal?: AbortSignal
}): Promise<ComputerGrantScope> {
  if (options.userQuestions !== undefined) {
    const answer = await options.userQuestions.ask({
      questions: [{
        id: 'computer-app-grant',
        question: `Allow computer use of ${options.app.name}?`,
        options: [
          { label: ALLOW_ONCE },
          { label: ALLOW_SESSION },
          { label: DENY },
        ],
      }],
      agent: options.owner,
      ...options.signal !== undefined ? { signal: options.signal } : {},
    })
    const selected = answer.answers[0]?.selected[0]
    if (selected === ALLOW_ONCE) return 'once'
    if (selected === ALLOW_SESSION) return 'session'
    throw new ComputerError(`the user denied computer use of "${options.app.name}"`, 'COMPUTER_APP_NOT_ALLOWED')
  }
  if (options.approval !== undefined) {
    const outcome = await options.approval.request({
      agent: options.owner,
      toolName: options.toolName,
      reason: `use ${options.app.name}`,
      ...options.callId !== undefined ? { callId: options.callId } : {},
      ...options.signal !== undefined ? { signal: options.signal } : {},
    })
    switch (outcome) {
      case 'allowed-once': return 'once'
      case 'rejected':
      case 'cancelled':
      case 'unavailable':
        throw new ComputerError(`the user did not grant computer use of "${options.app.name}"`, 'COMPUTER_APP_NOT_ALLOWED')
      default: {
        const exhaustive: never = outcome
        throw new Error(`unhandled approval outcome ${String(exhaustive)}`)
      }
    }
  }
  throw new Error(`computer action "${options.toolName}" requires a grant for "${options.app.name}", but no userQuestions or approval service is composed`)
}
