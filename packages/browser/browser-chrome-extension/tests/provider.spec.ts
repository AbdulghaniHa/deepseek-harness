import { createServer, type Server, type Socket as NetSocket } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import BrowserRuntime, { BrowserTabId } from '@deepseek-ai/dsh-browser'
import { apply, Config, ChromeExtensionProvider, CHROME_EXTENSION_PROVIDER_ID, defaultBrowserSocketPath } from '@deepseek-ai/dsh-browser-chrome-extension'
import { decodeFrames, encodeFrame, rpcFailure, rpcNotify, rpcRequest, rpcSuccess } from '../src/protocol/index.ts'
import { BrowserHostClient } from '../src/socket.ts'

let root: string | undefined
let server: Server | undefined

afterEach(async () => {
  server?.close()
  server = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function listen(): Promise<{ path: string; onClient: Promise<NetSocket> }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-browser-sock-'))
  const path = join(root, 'host.sock')
  let resolveClient: (socket: NetSocket) => void
  const onClient = new Promise<NetSocket>((resolve) => { resolveClient = resolve })
  server = createServer(socket => resolveClient(socket))
  await new Promise<void>((resolve, reject) => {
    server!.listen(path, resolve)
    server!.once('error', reject)
  })
  return { path, onClient }
}

describe('BrowserHostClient', () => {
  it('connects, requests, receives notifications, and times out', async () => {
    const { path, onClient } = await listen()
    const client = new BrowserHostClient()
    const connecting = client.connect(path, 1000)
    const socket = await onClient
    await connecting
    expect(client.connected()).toBe(true)
    const seen: unknown[] = []
    const stopNotify = client.onNotification((message) => { seen.push(message) })
    const pending = client.request('tabs.list', undefined, { clientId: 'c', timeoutMs: 200 })
    const first = await new Promise<unknown>((resolve) => {
      socket.once('data', chunk => resolve(decodeFrames(chunk).messages[0]))
    })
    expect(first).toMatchObject({ method: 'tabs.list' })
    socket.write(encodeFrame(rpcSuccess((first as { id: number }).id, [{ id: '1' }])))
    await expect(pending).resolves.toEqual([{ id: '1' }])
    socket.write(encodeFrame(rpcNotify('debugger.event', { tabId: '1', method: 'x', params: {} })))
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(seen).toHaveLength(1)
    stopNotify()
    await expect(client.request('slow', undefined, { timeoutMs: 10 }))
      .rejects.toThrow('timed out')
    client.close()
    expect(client.connected()).toBe(false)
  })

  it('rejects connect on timeout and maps RPC errors', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-browser-miss-'))
    const client = new BrowserHostClient()
    await expect(client.connect(join(root, 'missing.sock'), 50)).rejects.toThrow()
    const { path, onClient } = await listen()
    const ok = new BrowserHostClient()
    const connecting = ok.connect(path, 1000)
    const socket = await onClient
    await connecting
    const pending = ok.request('tabs.list')
    socket.once('data', (chunk) => {
      const request = decodeFrames(chunk).messages[0] as { id: number }
      socket.write(encodeFrame(rpcFailure(request.id, -32000, 'No tab with id 9')))
    })
    await expect(pending).rejects.toThrow('No tab with id')
    ok.close()
  })

  it('throws when requesting without a connection', async () => {
    const client = new BrowserHostClient()
    await expect(client.request('ping')).rejects.toThrow('not connected')
  })
})

describe('ChromeExtensionProvider', () => {
  it('connects lazily and normalizes tabs', async () => {
    const { path, onClient } = await listen()
    const provider = new ChromeExtensionProvider({
      socketPath: path,
      connectTimeoutMs: 1000,
      requestTimeoutMs: 1000,
      tabGroupTitle: 'DeepSeek',
      clientId: 'test',
    })
    expect(provider.id).toBe(CHROME_EXTENSION_PROVIDER_ID)
    expect(provider.available()).toBe(true)
    expect(provider.capabilities()).toContain('tabs')
    const listing = provider.listTabs()
    const socket = await onClient
    socket.on('data', (chunk) => {
      for (const message of decodeFrames(chunk).messages) {
        const request = message as { id: number; method: string }
        if (request.method === 'tabs.list') {
          socket.write(encodeFrame(rpcSuccess(request.id, [{
            id: 12, url: 'https://example.com', title: 'Ex', active: true, windowId: 1, grouped: false,
          }])))
        }
      }
    })
    await expect(listing).resolves.toEqual([expect.objectContaining({ id: '12', url: 'https://example.com' })])
    const withSignal = provider.listTabs(new AbortController().signal)
    await expect(withSignal).resolves.toEqual([expect.objectContaining({ id: '12' })])
    expect(provider.available()).toBe(true)
    const events: unknown[] = []
    const stop = provider.onCdpEvent((event) => { events.push(event) })
    socket.write(encodeFrame(rpcNotify('ignored.event', { tabId: '12' })))
    socket.write(encodeFrame(rpcNotify('debugger.event')))
    socket.write(encodeFrame(rpcNotify('debugger.event', {
      tabId: BrowserTabId('12'), method: 'Page.loadEventFired', params: {},
    })))
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(events).toHaveLength(1)
    stop()
  })

  it('throws BROWSER_NOT_CONNECTED when the host socket is missing', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-browser-gone-'))
    const provider = new ChromeExtensionProvider({
      socketPath: join(root, 'nope.sock'),
      connectTimeoutMs: 50,
      requestTimeoutMs: 50,
      tabGroupTitle: 'DeepSeek',
      clientId: 'test',
    })
    await expect(provider.listTabs()).rejects.toThrow(expect.objectContaining({ code: 'BROWSER_NOT_CONNECTED' }))
  })
})

describe('plugin apply', () => {
  it('registers the provider on ctx.browser and rejects non-positive timeouts', async () => {
    const ctx = new Context()
    await ctx.plugin(BrowserRuntime, {})
    expect(() => apply(ctx, { connectTimeoutMs: 0, requestTimeoutMs: 1000 } as never))
      .toThrow('connectTimeoutMs')
    expect(() => apply(ctx, { connectTimeoutMs: 10, requestTimeoutMs: 0 } as never))
      .toThrow('requestTimeoutMs')
    apply(ctx, Config({ requestTimeoutMs: 1000, connectTimeoutMs: 10, tabGroupTitle: 'X' }))
    await expect(ctx.browser.listTabs()).rejects.toThrow(expect.objectContaining({ code: 'BROWSER_NOT_CONNECTED' }))
    const ctx2 = new Context()
    await ctx2.plugin(BrowserRuntime, {})
    apply(ctx2, Config({
      socketPath: defaultBrowserSocketPath('win32'),
      requestTimeoutMs: 1000,
      connectTimeoutMs: 10,
    }))
    await expect(ctx2.browser.listTabs()).rejects.toThrow(expect.objectContaining({ code: 'BROWSER_NOT_CONNECTED' }))
  })
})

describe('ChromeExtensionProvider methods', () => {
  it('relays every facet and maps host errors', async () => {
    const { path, onClient } = await listen()
    const provider = new ChromeExtensionProvider({
      socketPath: path,
      connectTimeoutMs: 1000,
      requestTimeoutMs: 1000,
      tabGroupTitle: 'DeepSeek',
      clientId: 'test',
    })
    const listing = provider.listTabs()
    const socket = await onClient
    socket.on('data', (chunk) => {
      for (const message of decodeFrames(chunk).messages) {
        const request = message as { id: number; method: string; params?: Record<string, unknown> }
        if (request.method === 'tabs.list') {
          socket.write(encodeFrame(rpcSuccess(request.id, [{
            id: '1', url: 'https://example.com', title: 'Ex', active: true, windowId: 1, grouped: false,
          }])))
        } else if (request.method === 'tabs.create') {
          socket.write(encodeFrame(rpcSuccess(request.id, {
            id: '2', url: request.params?.url, title: 'New', active: true, windowId: 1, grouped: true,
          })))
        } else if (request.method === 'debugger.attach' || request.method === 'debugger.detach' || request.method === 'tabs.close') {
          socket.write(encodeFrame(rpcSuccess(request.id, null)))
        } else if (request.method === 'debugger.sendCommand') {
          socket.write(encodeFrame(rpcSuccess(request.id, { ok: true })))
        } else if (request.method === 'history.search') {
          socket.write(encodeFrame(rpcSuccess(request.id, [{ url: 'https://h', title: 'H', lastVisitTime: 1 }])))
        } else if (request.method === 'bookmarks.list') {
          socket.write(encodeFrame(rpcSuccess(request.id, [{ id: 'b', title: 'B' }])))
        } else if (request.method === 'bookmarks.create') {
          socket.write(encodeFrame(rpcSuccess(request.id, { id: 'b2', title: 'N', url: 'https://n' })))
        } else if (request.method === 'readingList.list') {
          socket.write(encodeFrame(rpcSuccess(request.id, [{ url: 'https://r', title: 'R', hasBeenRead: false }])))
        } else if (request.method === 'readingList.add') {
          socket.write(encodeFrame(rpcSuccess(request.id, { url: 'https://r2', title: 'R2', hasBeenRead: false })))
        } else if (request.method === 'downloads.list') {
          socket.write(encodeFrame(rpcSuccess(request.id, [{ id: 1, url: 'https://d', filename: 'f', state: 'complete' }])))
        }
      }
    })
    await listing
    const tab = BrowserTabId('1')
    await expect(provider.openTab({ url: 'https://opened', group: true })).resolves.toMatchObject({ url: 'https://opened' })
    await provider.attach(tab)
    await provider.cdp({ tabId: tab, method: 'Page.enable' })
    await provider.detach(tab)
    await provider.closeTab(tab)
    await expect(provider.historySearch('q')).resolves.toHaveLength(1)
    await expect(provider.listBookmarks()).resolves.toHaveLength(1)
    await expect(provider.createBookmark({ title: 'N', url: 'https://n' })).resolves.toMatchObject({ title: 'N' })
    await expect(provider.listReadingList()).resolves.toHaveLength(1)
    await expect(provider.addReadingList({ title: 'R2', url: 'https://r2' })).resolves.toMatchObject({ title: 'R2' })
    await expect(provider.listDownloads()).resolves.toHaveLength(1)
    await provider.listTabs()
  })

  it('maps TAB_GONE and protocol errors after a live connection', async () => {
    const { path, onClient } = await listen()
    const provider = new ChromeExtensionProvider({
      socketPath: path,
      connectTimeoutMs: 1000,
      requestTimeoutMs: 1000,
      tabGroupTitle: 'DeepSeek',
      clientId: 'test',
    })
    const first = provider.listTabs()
    const socket = await onClient
    let n = 0
    socket.on('data', (chunk) => {
      for (const message of decodeFrames(chunk).messages) {
        const request = message as { id: number }
        n += 1
        if (n === 1) socket.write(encodeFrame(rpcSuccess(request.id, [])))
        else if (n === 2) socket.write(encodeFrame(rpcFailure(request.id, -32000, 'No tab with id 9')))
        else socket.write(encodeFrame(rpcFailure(request.id, -32000, 'bad cdp')))
      }
    })
    await first
    await expect(provider.attach(BrowserTabId('9'))).rejects.toThrow(expect.objectContaining({ code: 'BROWSER_TAB_GONE' }))
    await expect(provider.cdp({ tabId: BrowserTabId('1'), method: 'X' }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_PROTOCOL' }))
  })

  it('maps a closed socket after a live connection to BROWSER_NOT_CONNECTED', async () => {
    const { path, onClient } = await listen()
    const provider = new ChromeExtensionProvider({
      socketPath: path,
      connectTimeoutMs: 1000,
      requestTimeoutMs: 1000,
      tabGroupTitle: 'DeepSeek',
      clientId: 'test',
    })
    const first = provider.listTabs()
    const socket = await onClient
    socket.on('data', (chunk) => {
      for (const message of decodeFrames(chunk).messages) {
        const request = message as { id: number }
        socket.write(encodeFrame(rpcSuccess(request.id, [])))
      }
    })
    await first
    socket.destroy()
    await new Promise(resolve => setTimeout(resolve, 20))
    await expect(provider.listTabs()).rejects.toThrow(expect.objectContaining({ code: 'BROWSER_NOT_CONNECTED' }))
  })
})

describe('BrowserHostClient extra paths', () => {
  it('is idempotent on connect, ignores orphan responses, and aborts in-flight requests', async () => {
    const { path, onClient } = await listen()
    const client = new BrowserHostClient()
    const connecting = client.connect(path, 1000)
    const socket = await onClient
    await connecting
    await client.connect(path, 1000)
    socket.write(encodeFrame(rpcSuccess(99, 'orphan')))
    const abort = new AbortController()
    const pending = client.request('slow', undefined, { signal: abort.signal, timeoutMs: 5_000 })
    abort.abort(new Error('stop'))
    await expect(pending).rejects.toThrow('stop')
    socket.write(Buffer.from([1, 0, 0, 0]))
    socket.write(encodeFrame({ chunked: true, id: 'z', index: 0, total: 2, data: '{' }))
    socket.write(encodeFrame(rpcRequest(1, 'ping')))
    const reasonless = new AbortController()
    const pending2 = client.request('slow2', undefined, { signal: reasonless.signal })
    reasonless.abort()
    await expect(pending2).rejects.toThrow('aborted')
    const hanging = client.request('hang')
    socket.destroy()
    await expect(hanging).rejects.toThrow('closed')
    client.close()
    client.close()
  })
})
