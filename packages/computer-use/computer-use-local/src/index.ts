/**
 * Local desktop provider plugin. Registers on `ctx.computer` and spawns the
 * crash-isolated helper through `ctx.subprocess`.
 * @module @deepseek-ai/dsh-computer-use-local
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-computer-use'
import type {} from '@deepseek-ai/dsh-subprocess'
import { LocalComputerProvider } from './provider.ts'

export { isHostProcessEntry, resolveHostArgv, ComputerHostClient } from './client.ts'
export type { ComputerHostClientOptions, ComputerHostProcess, SpawnComputerHost } from './client.ts'
export { computerDoctorRemediation, doctor, formatDoctorReport } from './doctor.ts'
export type { ComputerDoctorBackend, ComputerDoctorOptions, ComputerDoctorReport } from './doctor.ts'
export { LOCAL_COMPUTER_PROVIDER_ID, LocalComputerProvider } from './provider.ts'
export type { LocalComputerProviderOptions } from './provider.ts'
export {
  PROTOCOL_VERSION,
  decodeLines,
  encodeLine,
  isRpcRequest,
  isRpcResponse,
  protocolMismatch,
  rpcFailure,
  rpcRequest,
  rpcSuccess,
} from './protocol.ts'
export { handleComputerMethod } from './dispatch.ts'
export { createPlatformBackend, defaultPlatformIo } from './platform.ts'
export type { PlatformBackendOptions, PlatformIo } from './platform.ts'
export { createSimulangBackend, loadSimulang } from './simulang.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'computer-use-local'

/** The computer-use seam and the subprocess seam this provider registers into. */
export const inject = ['computer', 'subprocess']

/** Plugin config: helper RPC timeout and terminate grace. */
export interface Config {
  /** Per-RPC timeout in milliseconds. */
  requestTimeoutMs?: number
  /** SIGTERM-to-SIGKILL grace for the helper process tree, in milliseconds. */
  graceMs?: number
}

export const Config: z<Config> = z.object({
  requestTimeoutMs: z.number().default(30_000),
  graceMs: z.number().default(5_000),
})

/** Complete config after schemastery applies every field default. */
type ResolvedConfig = {
  requestTimeoutMs: number
  graceMs: number
}

/** A timeout must be a positive finite number. */
function assertPositiveFinite(field: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`computer-use-local: ${field} must be a positive finite number`)
  }
}

/**
 * Register the local provider with `ctx.computer` and dispose the helper with the fiber.
 * @param ctx - the host context that owns `ctx.computer` and `ctx.subprocess`.
 * @param config - validated plugin config.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  assertPositiveFinite('requestTimeoutMs', resolved.requestTimeoutMs)
  assertPositiveFinite('graceMs', resolved.graceMs)
  const provider = new LocalComputerProvider(ctx, {
    requestTimeoutMs: resolved.requestTimeoutMs,
    graceMs: resolved.graceMs,
  })
  ctx.computer.registerProvider(provider)
  ctx.effect(() => () => {
    void provider.dispose()
  }, 'computer-use-local helper teardown')
}
