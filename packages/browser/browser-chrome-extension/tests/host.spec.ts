import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { NativeHost } from '../src/host/bridge.ts'
import { encodeFrame, decodeFrames, rpcFailure, rpcNotify, rpcRequest, rpcSuccess } from '../src/protocol/index.ts'

class FakeSocket extends EventEmitter {
  readonly writes: Buffer[] = []
  destroyed = false

  write(chunk: Buffer): boolean {
    this.writes.push(chunk)
    return true
  }

  destroy(): void {
    this.destroyed = true
    this.emit('close')
  }

  push(payload: unknown): void {
    this.emit('data', encodeFrame(payload))
  }
}

function startHost(): {
  host: NativeHost
  stdin: PassThrough
  stdoutChunks: Buffer[]
  connect: () => FakeSocket
} {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stdoutChunks: Buffer[] = []
  stdout.on('data', (chunk: Buffer) => { stdoutChunks.push(chunk) })
  let onConnection: ((socket: FakeSocket) => void) | undefined
  const host = new NativeHost({
    socketPath: '/tmp/dsh-browser-test.sock',
    stdin,
    stdout,
    mkdir: () => {},
    chmod: () => {},
    unlink: () => {
      const error = new Error('gone') as NodeJS.ErrnoException
      error.code = 'ENOENT'
      throw error
    },
    listen: (_path, handler) => {
      onConnection = handler as unknown as (socket: FakeSocket) => void
      return { close: () => {} } as never
    },
  })
  host.start()
  return {
    host,
    stdin,
    stdoutChunks,
    connect: () => {
      const socket = new FakeSocket()
      onConnection!(socket)
      return socket
    },
  }
}

describe('NativeHost multiplexer', () => {
  it('forwards a client request to stdio and remaps the extension response', () => {
    const { host, stdin, stdoutChunks, connect } = startHost()
    const client = connect()
    expect(host.hasClients()).toBe(true)
    client.push(rpcRequest(7, 'tabs.list', undefined, 'c1'))
    const toExtension = decodeFrames(Buffer.concat(stdoutChunks)).messages[0] as { id: number; method: string }
    expect(toExtension.method).toBe('tabs.list')
    stdin.write(encodeFrame(rpcSuccess(toExtension.id, [{ id: '1' }])))
    const back = decodeFrames(Buffer.concat(client.writes)).messages[0]
    expect(back).toEqual(rpcSuccess(7, [{ id: '1' }]))
    expect(host.extensionConnected()).toBe(true)
    host.stop()
  })

  it('rejects a mismatched protocol version without contacting the extension', () => {
    const { host, connect } = startHost()
    const client = connect()
    client.push({ ...rpcRequest(1, 'tabs.list'), protocolVersion: 99 })
    const failure = decodeFrames(Buffer.concat(client.writes)).messages[0] as { error: { message: string } }
    expect(failure.error.message).toContain('does not match host')
    host.stop()
  })

  it('broadcasts extension notifications to every client and acks extension hellos', () => {
    const { host, stdin, connect } = startHost()
    const a = connect()
    const b = connect()
    stdin.write(encodeFrame(rpcNotify('debugger.event', { tabId: '1' })))
    expect(decodeFrames(Buffer.concat(a.writes)).messages[0]).toEqual(rpcNotify('debugger.event', { tabId: '1' }))
    expect(decodeFrames(Buffer.concat(b.writes)).messages[0]).toEqual(rpcNotify('debugger.event', { tabId: '1' }))
    stdin.write(encodeFrame(rpcRequest(3, 'hello')))
    host.stop()
  })

  it('drops a client on close and ignores ENOENT when unlinking a stale socket', () => {
    const { host, connect } = startHost()
    const client = connect()
    client.destroy()
    expect(host.hasClients()).toBe(false)
    host.stop()
  })

  it('skips posix mkdir when the path is a Windows named pipe', () => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const mkdirCalls: string[] = []
    const host = new NativeHost({
      socketPath: '\\\\.\\pipe\\dsh-browser-host',
      stdin,
      stdout,
      mkdir: (path) => { mkdirCalls.push(String(path)) },
      chmod: () => {},
      unlink: () => {},
      listen: () => ({ close: () => {} }) as never,
    })
    host.start()
    expect(mkdirCalls).toEqual([])
    host.stop()
  })

  it('swallows ENOENT on stale-socket unlink and rethrows other unlink errors', () => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const host = new NativeHost({
      socketPath: '/tmp/missing.sock',
      stdin,
      stdout,
      mkdir: () => {},
      chmod: () => {},
      unlink: () => {
        const error = new Error('gone') as NodeJS.ErrnoException
        error.code = 'ENOENT'
        throw error
      },
      listen: () => ({ close: () => {} }) as never,
    })
    host.start()
    host.stop()
    const failing = new NativeHost({
      socketPath: '/tmp/missing.sock',
      stdin,
      stdout,
      mkdir: () => {},
      chmod: () => {},
      unlink: () => {
        throw new Error('busy')
      },
      listen: () => ({ close: () => {} }) as never,
    })
    expect(() => failing.start()).toThrow('busy')
  })

  it('swallows ENOENT when chmod of the new socket races and rethrows other chmod errors', () => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    let chmodCalls = 0
    const host = new NativeHost({
      socketPath: '/tmp/chmod.sock',
      stdin,
      stdout,
      mkdir: () => {},
      chmod: () => {
        chmodCalls += 1
        if (chmodCalls === 2) {
          const error = new Error('gone') as NodeJS.ErrnoException
          error.code = 'ENOENT'
          throw error
        }
      },
      unlink: () => {},
      listen: () => ({ close: () => {} }) as never,
    })
    host.start()
    host.stop()
    const failing = new NativeHost({
      socketPath: '/tmp/chmod.sock',
      stdin,
      stdout,
      mkdir: () => {},
      chmod: () => {
        chmodCalls += 1
        if (chmodCalls > 3) throw new Error('chmod-denied')
      },
      unlink: () => {},
      listen: () => ({ close: () => {} }) as never,
    })
    expect(() => failing.start()).toThrow('chmod-denied')
  })

  it('remaps extension failures, ignores leftover chunks, and drops clients on error', () => {
    const { host, stdin, stdoutChunks, connect } = startHost()
    const client = connect()
    client.push('not-a-request')
    client.push({ chunked: true, id: 'x', index: 0, total: 2, data: '{' })
    client.push(rpcRequest(4, 'tabs.list'))
    const toExtension = decodeFrames(Buffer.concat(stdoutChunks)).messages.at(-1) as { id: number }
    stdin.write(encodeFrame({ chunked: true, id: 'y', index: 0, total: 2, data: '{' }))
    stdin.write(encodeFrame(rpcFailure(toExtension.id, -32000, 'TAB_GONE')))
    stdin.write(encodeFrame(rpcSuccess(999, 'nobody')))
    const back = decodeFrames(Buffer.concat(client.writes)).messages.at(-1)
    expect(back).toEqual(rpcFailure(4, -32000, 'TAB_GONE'))
    client.emit('error', new Error('reset'))
    expect(host.hasClients()).toBe(false)
    host.stop()
    stdin.end()
  })

  it('keeps another client\'s in-flight waiter when a sibling disconnects', () => {
    const { host, stdoutChunks, connect } = startHost()
    const keeper = connect()
    const sibling = connect()
    keeper.push(rpcRequest(9, 'tabs.list'))
    expect(decodeFrames(Buffer.concat(stdoutChunks)).messages.at(-1)).toMatchObject({ method: 'tabs.list' })
    sibling.destroy()
    expect(host.hasClients()).toBe(true)
    host.stop()
  })

  it('drops in-flight waiters with the client and ignores a late extension reply', () => {
    const { host, stdin, stdoutChunks, connect } = startHost()
    const client = connect()
    client.push(rpcRequest(8, 'tabs.list'))
    const toExtension = decodeFrames(Buffer.concat(stdoutChunks)).messages.at(-1) as { id: number }
    client.destroy()
    stdin.write(encodeFrame(rpcSuccess(toExtension.id, [])))
    expect(host.hasClients()).toBe(false)
    host.stop()
  })

  it('listens on a real unix socket when no listen hook is supplied', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { createConnection } = await import('node:net')
    const dir = await mkdtemp(join(tmpdir(), 'dsh-browser-listen-'))
    const path = join(dir, 'host.sock')
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const host = new NativeHost({ socketPath: path, stdin, stdout })
    host.start()
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(path)
      socket.once('connect', () => {
        socket.end()
        resolve()
      })
      socket.once('error', reject)
    })
    host.stop()
    stdin.end()
    await rm(dir, { recursive: true, force: true })
  })
})
