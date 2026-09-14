/**
 * Image-capability check for browser screenshots. Duplicated from
 * tool-computer-use so this consumer does not depend on that package.
 * @module @deepseek-ai/dsh-tool-browser/route
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'

/**
 * Whether the calling route declares image input.
 * @param ctx - plugin context used to resolve the optional `llm` service.
 * @param exec - tool execution supplying the calling agent.
 * @returns true when screenshots may emit an image block.
 */
/* jscpd:ignore-start -- duplicated in tool-computer-use so this consumer does not depend on that package. */
export async function isImageCapableRoute(ctx: Context, exec: ToolExecution): Promise<boolean> {
  const routed = exec.agent?.session?.requestHeader()?.config
  const provider = routed?.provider ?? exec.agent?.options?.provider
  const model = routed?.model ?? exec.agent?.options?.model
  const llm = ctx.get('llm')
  if (provider === undefined || model === undefined || llm === undefined) return false
  const active = await llm.resolveModelInfo(provider, model, exec.signal)
  return active.inputModalities !== undefined && active.inputModalities.includes('image')
}
/* jscpd:ignore-end */
