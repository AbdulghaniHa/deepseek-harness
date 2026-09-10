/**
 * JSON-RPC client over a spawned computer-use helper's stdio.
 * @module @deepseek-ai/dsh-computer-use-local/client
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Readable, Writable } from 'node:stream'
import { ComputerError } from '@deepseek-ai/dsh-computer-use'
import { decodeLines, encodeLine, isRpcResponse, rpcRequest, type ComputerRpcResponse } from './protocol.ts'

/** Minimal process handle the client needs from `ctx.subprocess` or a test fake. */
export interface ComputerHostProcess {
  readonly stdin: Writable | undefined
  readonly stdout: Readable | undefined
  terminate(): void
  waitForExit(signal?: AbortSignal): Promise<boolean>
  readonly done: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>
}

/** Spawn one helper process. */
export type SpawnComputerHost = (argv: readonly string[]) => ComputerHostProcess

interface PendingCall {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: unknown) => void
}

/**
 * Resolve the helper argv: bundled `host.js` next to the plugin, otherwise
 * source `host.ts` through tsx.
 * @param metaUrl - `import.meta.url` of the calling module.
 * @returns node argv for the helper.
 */
export function resolveHostArgv(metaUrl: string = import.meta.url): readonly string[] {
  const dir = dirname(fileURLToPath(metaUrl))
  const bundled = join(dir, 'host.js')
  if (existsSync(bundled)) return [process.execPath, bundled]
  const source = join(dir, 'host.ts')
  if (existsSync(source)) return [process.execPath, '--import', 'tsx/esm', source]
  throw new ComputerError(`computer-use helper is missing next to ${dir}`, 'COMPUTER_HOST_CRASHED')
}

/**
 * Whether `process.argv[1]` is this package's helper entry.
 * @param argv1 - `process.argv[1]`.
 * @returns true when this process should run the host loop.
 */
export function isHostProcessEntry(argv1: string): boolean {
  return argv1.endsWith('host.js') || argv1.endsWith('host.ts')
}

/** Client knobs. */
export interface ComputerHostClientOptions {
  readonly spawn: SpawnComputerHost
  readonly argv?: readonly string[]
  readonly requestTimeoutMs?: number
}

/**
 * Lazy stdio JSON-RPC client. A crash fails in-flight calls with
 * `COMPUTER_HOST_CRASHED`; the next call starts a new helper.
 */
export class ComputerHostClient {
  private process: ComputerHostProcess | undefined
  private starting: Promise<ComputerHostProcess> | undefined
  private nextId = 1
  private pending = ''
  private readonly inflight = new Map<number, PendingCall>()
  private readonly spawn: SpawnComputerHost
  private readonly argv: readonly string[]
  private readonly requestTimeoutMs: number

  constructor(options: ComputerHostClientOptions) {
    this.spawn = options.spawn
    this.argv = options.argv ?? resolveHostArgv()
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000
  }

  /**
   * Call one helper method.
   * @param method - RPC method name.
   * @param params - JSON params.
   * @param signal - optional cancellation.
   * @returns the JSON result.
   */
  async call(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown> {
    const process = await this.ensureProcess()
    const id = this.nextId
    this.nextId += 1
    const stdin = process.stdin
    if (stdin === undefined) {
      this.forgetProcess(process)
      throw new ComputerError('computer-use helper has no stdin pipe', 'COMPUTER_HOST_CRASHED')
    }
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        this.inflight.delete(id)
        reject(signal?.reason instanceof Error ? signal.reason : new ComputerError('computer-use RPC cancelled', 'COMPUTER_UNSUPPORTED'))
      }
      if (signal?.aborted) {
        onAbort()
        return
      }
      const timer = setTimeout(() => {
        this.inflight.delete(id)
        reject(new ComputerError(`computer-use RPC ${method} timed out`, 'COMPUTER_UNSUPPORTED'))
      }, this.requestTimeoutMs)
      this.inflight.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          reject(error)
        },
      })
      signal?.addEventListener('abort', onAbort, { once: true })
      stdin.write(encodeLine(rpcRequest(id, method, params)))
    })
  }

  /**
   * Terminate the helper if it is running and wait for exit.
   * @param signal - optional bound for the wait.
   */
  async dispose(signal?: AbortSignal): Promise<void> {
    const process = this.process
    this.process = undefined
    this.starting = undefined
    this.rejectAll(new ComputerError('computer-use helper disposed', 'COMPUTER_HOST_CRASHED'))
    if (process === undefined) return
    process.terminate()
    await process.waitForExit(signal)
  }

  private async ensureProcess(): Promise<ComputerHostProcess> {
    if (this.process !== undefined) return this.process
    if (this.starting !== undefined) return this.starting
    this.starting = this.start()
    try {
      this.process = await this.starting
      return this.process
    } finally {
      this.starting = undefined
    }
  }

  private async start(): Promise<ComputerHostProcess> {
    const process = this.spawn(this.argv)
    const stdout = process.stdout
    if (stdout === undefined) {
      process.terminate()
      throw new ComputerError('computer-use helper has no stdout pipe', 'COMPUTER_HOST_CRASHED')
    }
    stdout.setEncoding('utf8')
    stdout.on('data', (chunk: string) => {
      const decoded = decodeLines(chunk, this.pending)
      this.pending = decoded.pending
      for (const message of decoded.messages) this.onMessage(message)
    })
    void process.done.then(() => {
      this.forgetProcess(process)
      this.rejectAll(new ComputerError('computer-use helper exited', 'COMPUTER_HOST_CRASHED'))
    }, () => {
      this.forgetProcess(process)
      this.rejectAll(new ComputerError('computer-use helper failed to spawn', 'COMPUTER_HOST_CRASHED'))
    })
    return process
  }

  private onMessage(value: unknown): void {
    if (!isRpcResponse(value)) return
    const pending = this.inflight.get(value.id)
    if (pending === undefined) return
    this.inflight.delete(value.id)
    const response = value as ComputerRpcResponse
    if ('error' in response) {
      pending.reject(new ComputerError(response.error.message, response.error.code))
      return
    }
    pending.resolve(response.result)
  }

  private forgetProcess(process: ComputerHostProcess): void {
    if (this.process === process) this.process = undefined
  }

  private rejectAll(error: ComputerError): void {
    const pending = [...this.inflight.values()]
    this.inflight.clear()
    for (const call of pending) call.reject(error)
  }
}
