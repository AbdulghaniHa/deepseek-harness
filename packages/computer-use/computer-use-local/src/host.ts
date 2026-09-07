/**
 * Crash-isolated computer-use helper. Reads newline-delimited JSON-RPC on stdin.
 * @module @deepseek-ai/dsh-computer-use-local/host
 */

import { createInterface } from 'node:readline'
import { ComputerError } from '@deepseek-ai/dsh-computer-use'
import type { DesktopBackend } from './backend.ts'
import { handleComputerMethod, errorPair } from './dispatch.ts'
import { createPlatformBackend } from './platform.ts'
import { decodeLines, encodeLine, isRpcRequest, protocolMismatch, rpcFailure, rpcSuccess } from './protocol.ts'
import { createSimulangBackend, loadSimulang } from './simulang.ts'

/**
 * Resolve the desktop backend: simulang when present, otherwise the OS fallback.
 * @param load - optional native import override for tests.
 * @returns a DesktopBackend.
 */
export async function resolveBackend(
  load: typeof loadSimulang = loadSimulang,
): Promise<DesktopBackend> {
  const simulang = await load()
  if (simulang !== undefined) return createSimulangBackend(simulang)
  return createPlatformBackend()
}

/**
 * Handle one decoded JSON-RPC request.
 * @param backend - desktop implementation.
 * @param value - decoded stdin line.
 * @returns the encoded response line.
 */
export async function handleHostLine(backend: DesktopBackend, value: unknown): Promise<string> {
  if (!isRpcRequest(value)) {
    return encodeLine(rpcFailure(0, 'COMPUTER_UNSUPPORTED', 'invalid computer-use RPC request'))
  }
  const mismatch = protocolMismatch(value)
  if (mismatch !== undefined) {
    return encodeLine(rpcFailure(value.id, 'COMPUTER_UNSUPPORTED', mismatch))
  }
  try {
    const result = await handleComputerMethod(backend, value.method, value.params)
    return encodeLine(rpcSuccess(value.id, result))
  } catch (error) {
    const pair = errorPair(error)
    return encodeLine(rpcFailure(value.id, pair.code, pair.message))
  }
}

/**
 * Start the stdin loop. Exported for tests that inject a backend.
 * @param backend - desktop implementation.
 * @param input - readable stream.
 * @param output - writable stream.
 * @returns a promise that resolves when input closes.
 */
export async function serveHost(
  backend: DesktopBackend,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<void> {
  const rl = createInterface({ input, crlfDelay: Infinity })
  let pending = ''
  for await (const line of rl) {
    const decoded = decodeLines(`${line}\n`, pending)
    pending = decoded.pending
    for (const message of decoded.messages) {
      output.write(await handleHostLine(backend, message))
    }
  }
}

/** Injectable streams and backend for {@link main}. */
export interface HostMainOptions {
  readonly backend?: DesktopBackend
  readonly input?: NodeJS.ReadableStream
  readonly output?: NodeJS.WritableStream
  readonly stderr?: NodeJS.WritableStream
}

/**
 * Helper process entry. Not used by the plugin client except via spawn.
 * @param options - injectable streams and backend for tests.
 */
export async function main(options: HostMainOptions = {}): Promise<void> {
  try {
    const backend = options.backend ?? await resolveBackend()
    await serveHost(backend, options.input, options.output)
  } catch (error) {
    const message = error instanceof ComputerError ? error.message : error instanceof Error ? error.message : String(error)
    ;(options.stderr ?? process.stderr).write(`${message}\n`)
    if (options.stderr === undefined) process.exitCode = 1
  }
}

/**
 * Whether `argv[1]` is this helper's entry script (built `host.js` or source `host.ts`).
 * @param argv1 - `process.argv[1]` of the current process.
 * @returns true when this module should call {@link main} as the process entry.
 */
export function shouldRunHostMain(argv1: string): boolean {
  return argv1.endsWith('host.js') || argv1.endsWith('host.ts')
}

/* v8 ignore start -- helper process entry; serveHost and main are unit-tested. */
const entry = process.argv[1] ?? ''
if (shouldRunHostMain(entry)) {
  void main()
}
/* v8 ignore stop */
