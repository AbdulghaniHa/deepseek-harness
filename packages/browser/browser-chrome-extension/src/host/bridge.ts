/**
 * Native-host multiplexer: Chrome speaks length-prefixed JSON on stdio; dsh
 * clients connect to a listening socket. The host listens; dsh connects.
 * @module @deepseek-ai/dsh-browser-chrome-extension/host/bridge
 */

import { chmodSync, mkdirSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { createServer, type Server, type Socket } from 'node:net'
import type { Readable, Writable } from 'node:stream'
import { ChunkAssembler, chunkNativePayload, decodeFrames, encodeFrame } from '../protocol/framing.ts'
import {
  isRpcNotification,
  isRpcRequest,
  isRpcResponse,
  protocolMismatch,
  rpcFailure,
  rpcNotify,
  rpcSuccess,
  type BrowserRpcNotification,
  type BrowserRpcRequest,
} from '../protocol/rpc.ts'

/** One connected dsh client. */
interface ClientSession {
  readonly id: string
  readonly socket: Socket
  buffer: Buffer
  readonly assembler: ChunkAssembler
}

/** Injectable stdio and socket factory for tests. */
export interface NativeHostOptions {
  readonly socketPath: string
  readonly stdin: Readable
  readonly stdout: Writable
  readonly mkdir?: typeof mkdirSync
  readonly chmod?: typeof chmodSync
  readonly unlink?: typeof unlinkSync
  readonly listen?: (path: string, onConnection: (socket: Socket) => void) => Server
}

/**
 * Chrome-launched native host. Listens on `socketPath` and relays JSON-RPC
 * between connected dsh clients and the extension on stdio.
 */
export class NativeHost {
  private stdinBuffer = Buffer.alloc(0)
  private readonly stdinAssembler = new ChunkAssembler()
  private readonly clients = new Map<string, ClientSession>()
  private nextClient = 0
  private nextStdioId = 0
  private readonly stdioWaiters = new Map<number, {
    readonly clientId: string
    readonly requestId: number
  }>()
  private server: Server | undefined
  private extensionReady = false

  constructor(private readonly options: NativeHostOptions) {}

  /**
   * Bind the socket (0700 directory, stale-socket unlink) and start reading
   * native-messaging frames from stdin.
   */
  start(): void {
    const mkdir = this.options.mkdir ?? mkdirSync
    const chmod = this.options.chmod ?? chmodSync
    const unlink = this.options.unlink ?? unlinkSync
    const dir = dirname(this.options.socketPath)
    if (!this.options.socketPath.startsWith('\\\\.\\pipe\\')) {
      mkdir(dir, { recursive: true, mode: 0o700 })
      chmod(dir, 0o700)
      try {
        unlink(this.options.socketPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    const listen = this.options.listen ?? defaultListen
    this.server = listen(this.options.socketPath, (socket) => { this.accept(socket) })
    if (!this.options.socketPath.startsWith('\\\\.\\pipe\\')) {
      try {
        chmod(this.options.socketPath, 0o600)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    this.options.stdin.on('data', (chunk: Buffer) => { this.onStdin(chunk) })
    this.options.stdin.on('end', () => { this.stop() })
  }

  /** Close the socket server and every client. */
  stop(): void {
    for (const client of this.clients.values()) client.socket.destroy()
    this.clients.clear()
    this.server?.close()
    this.server = undefined
  }

  /**
   * Whether at least one dsh client is connected.
   * @returns true when a client socket is live.
   */
  hasClients(): boolean {
    return this.clients.size > 0
  }

  /**
   * Whether the extension has sent a hello (or any request), proving stdio is live.
   * @returns true after the first well-formed stdin frame.
   */
  extensionConnected(): boolean {
    return this.extensionReady
  }

  private accept(socket: Socket): void {
    const id = `client-${++this.nextClient}`
    const session: ClientSession = { id, socket, buffer: Buffer.alloc(0), assembler: new ChunkAssembler() }
    this.clients.set(id, session)
    socket.on('data', (chunk) =>{  this.onClientData(session, chunk) })
    socket.on('close', () =>{  this.dropClient(id) })
    socket.on('error', () =>{  this.dropClient(id) })
  }

  private dropClient(id: string): void {
    const session = this.clients.get(id)
    if (session === undefined) return
    this.clients.delete(id)
    session.socket.destroy()
    for (const [stdioId, waiter] of this.stdioWaiters) {
      /* v8 ignore next -- waiters belonging to other still-connected clients. */
      if (waiter.clientId === id) this.stdioWaiters.delete(stdioId)
    }
  }

  private onClientData(session: ClientSession, chunk: Buffer): void {
    const decoded = decodeFrames(Buffer.concat([session.buffer, chunk]))
    session.buffer = Buffer.from(decoded.rest)
    for (const raw of decoded.messages) {
      const message = session.assembler.push(raw)
      if (message === undefined) continue
      if (!isRpcRequest(message)) continue
      const mismatch = protocolMismatch(message)
      if (mismatch !== undefined) {
        session.socket.write(encodeFrame(rpcFailure(message.id, -32000, mismatch)))
        continue
      }
      this.forwardToExtension(session, message)
    }
  }

  private forwardToExtension(session: ClientSession, request: BrowserRpcRequest): void {
    const stdioId = ++this.nextStdioId
    this.stdioWaiters.set(stdioId, { clientId: session.id, requestId: request.id })
    const forwarded = { ...request, id: stdioId, clientId: session.id }
    for (const part of chunkNativePayload(forwarded)) {
      this.options.stdout.write(encodeFrame(part))
    }
  }

  private onStdin(chunk: Buffer): void {
    const decoded = decodeFrames(Buffer.concat([this.stdinBuffer, chunk]))
    this.stdinBuffer = Buffer.from(decoded.rest)
    for (const raw of decoded.messages) {
      const message = this.stdinAssembler.push(raw)
      if (message === undefined) continue
      this.extensionReady = true
      if (isRpcResponse(message)) {
        const waiter = this.stdioWaiters.get(message.id)
        if (waiter === undefined) continue
        this.stdioWaiters.delete(message.id)
        const client = this.clients.get(waiter.clientId)
        /* v8 ignore next -- dropClient already deletes waiters for a gone client. */
        if (client === undefined) continue
        const remapped = 'error' in message
          ? rpcFailure(waiter.requestId, message.error.code, message.error.message)
          : rpcSuccess(waiter.requestId, message.result)
        client.socket.write(encodeFrame(remapped))
        continue
      }
      if (isRpcNotification(message)) {
        this.broadcast(message)
        continue
      }
      /* v8 ignore next -- stdin frames that are neither response, notify, nor request. */
      if (isRpcRequest(message)) {
        this.options.stdout.write(encodeFrame(rpcSuccess(message.id, { ok: true })))
      }
    }
  }

  private broadcast(message: BrowserRpcNotification): void {
    const frame = encodeFrame(rpcNotify(message.method, message.params))
    for (const client of this.clients.values()) client.socket.write(frame)
  }
}

function defaultListen(path: string, onConnection: (socket: Socket) => void): Server {
  const server = createServer(onConnection)
  server.listen(path)
  return server
}
