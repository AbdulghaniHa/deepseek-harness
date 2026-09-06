/**
 * Length-prefixed JSON-RPC client over a unix socket or Windows named pipe.
 * @module @deepseek-ai/dsh-browser-chrome-extension/socket
 */

import { createConnection, type Socket } from 'node:net'
import { ChunkAssembler, decodeFrames, encodeFrame } from './protocol/framing.ts'
import {
  isRpcNotification,
  isRpcResponse,
  protocolMismatch,
  rpcRequest,
  type BrowserRpcNotification,
  type BrowserRpcRequest,
} from './protocol/rpc.ts'

/** One in-flight RPC waiter. */
interface Pending {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
}

/**
 * Connect to the native host's listening socket and speak JSON-RPC.
 */
export class BrowserHostClient {
  private socket: Socket | undefined
  private buffer = Buffer.alloc(0)
  private readonly assembler = new ChunkAssembler()
  private nextId = 0
  private readonly pending = new Map<number, Pending>()
  private readonly notifications = new Set<(message: BrowserRpcNotification) => void>()

  /**
   * Open the socket.
   * @param socketPath - unix socket or Windows named pipe.
   * @param timeoutMs - connect timeout.
   */
  async connect(socketPath: string, timeoutMs: number): Promise<void> {
    if (this.socket !== undefined) return
    this.socket = await new Promise<Socket>((resolve, reject) => {
      const socket = createConnection(socketPath)
      /* v8 ignore start -- connect timeout needs a peer that neither accepts nor errors. */
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error(`browser host connect timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      /* v8 ignore stop */
      socket.once('connect', () => {
        clearTimeout(timer)
        resolve(socket)
      })
      socket.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
    })
    this.socket.on('data', chunk => this.onData(chunk))
    this.socket.on('close', () => this.failAll(new Error('browser host socket closed')))
  }

  /**
   * Whether the socket is currently open.
   * @returns true after a successful {@link connect} that has not closed.
   */
  connected(): boolean {
    return this.socket !== undefined && !this.socket.destroyed
  }

  /**
   * Send one RPC request and wait for its response.
   * @param method - RPC method.
   * @param params - optional params.
   * @param options - client id, timeout, and abort.
   * @returns the JSON result.
   */
  async request(method: string, params?: unknown, options: {
    readonly clientId?: string
    readonly timeoutMs?: number
    readonly signal?: AbortSignal
  } = {}): Promise<unknown> {
    const socket = this.socket
    if (socket === undefined) throw new Error('browser host is not connected')
    const id = ++this.nextId
    const request: BrowserRpcRequest = rpcRequest(id, method, params, options.clientId)
    /* v8 ignore next -- rpcRequest always stamps PROTOCOL_VERSION; mismatch is tested on the host. */
    const mismatch = protocolMismatch(request)
    /* v8 ignore next */
    if (mismatch !== undefined) throw new Error(mismatch)
    return await new Promise<unknown>((resolve, reject) => {
      const timer = options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
          this.pending.delete(id)
          reject(new Error(`browser host request "${method}" timed out after ${options.timeoutMs}ms`))
        }, options.timeoutMs)
      const signal = options.signal
      const onAbort = () => {
        this.pending.delete(id)
        if (timer !== undefined) clearTimeout(timer)
        const reason = signal?.reason
        /* v8 ignore next -- AbortSignal.reason is an Error in the tests that abort with a value. */
        reject(reason instanceof Error ? reason : new Error('browser host request aborted'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, {
        resolve: (value) => {
          /* v8 ignore next -- timeoutMs is omitted in the no-timer success path. */
          if (timer !== undefined) clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          resolve(value)
        },
        reject: (error) => {
          if (timer !== undefined) clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          reject(error)
        },
      })
      socket.write(encodeFrame(request))
    })
  }

  /**
   * Subscribe to host notifications (CDP events).
   * @param listener - notification handler.
   * @returns disposer.
   */
  onNotification(listener: (message: BrowserRpcNotification) => void): () => void {
    this.notifications.add(listener)
    return () => { this.notifications.delete(listener) }
  }

  /** Close the socket and reject in-flight requests. */
  close(): void {
    this.socket?.destroy()
    this.socket = undefined
    this.failAll(new Error('browser host client closed'))
  }

  private onData(chunk: Buffer): void {
    const decoded = decodeFrames(Buffer.concat([this.buffer, chunk]))
    this.buffer = Buffer.from(decoded.rest)
    for (const raw of decoded.messages) {
      const message = this.assembler.push(raw)
      /* v8 ignore next -- incomplete native-message chunk on a live socket. */
      if (message === undefined) continue
      if (isRpcResponse(message)) {
        const waiter = this.pending.get(message.id)
        if (waiter === undefined) continue
        this.pending.delete(message.id)
        if ('error' in message) waiter.reject(new Error(message.error.message))
        else waiter.resolve(message.result)
        continue
      }
      if (isRpcNotification(message)) {
        for (const listener of this.notifications) listener(message)
      }
    }
  }

  private failAll(error: Error): void {
    for (const waiter of this.pending.values()) waiter.reject(error)
    this.pending.clear()
    this.socket = undefined
  }
}
