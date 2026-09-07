/**
 * Image-capability gate for computer_screenshot. Duplicated from tool-fs so
 * this consumer does not depend on the filesystem tools package.
 * @module @deepseek-ai/dsh-tool-computer-use/route
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'

/**
 * Refuse screenshots when the calling route does not declare image input.
 * @param ctx - plugin context used to resolve the optional `llm` service.
 * @param exec - tool execution supplying the calling agent.
 */
export async function assertImageCapableRoute(ctx: Context, exec: ToolExecution): Promise<void> {
  const routed = exec.agent?.session.requestHeader()?.config
  const provider = routed?.provider ?? exec.agent?.options.provider
  const model = routed?.model ?? exec.agent?.options.model
  const llm = ctx.get('llm')
  if (provider === undefined || model === undefined || llm === undefined) {
    throw new Error('computer_screenshot requires an image-capable model route, but the current route could not be resolved; use computer_snapshot instead')
  }
  const active = await llm.resolveModelInfo(provider, model, exec.signal)
  if (active.inputModalities === undefined || !active.inputModalities.includes('image')) {
    throw new Error(`computer_screenshot cannot run: model "${model}" does not declare image input; use computer_snapshot, or switch to an image-capable model`)
  }
}
