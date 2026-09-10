/** Real Chrome network capture: the shipped extension's CDP events reduced by the shipped tool store. Opt in with DSH_BROWSER_E2E=1. */
import { createServer } from 'node:http'
import { appendFile, cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type BrowserContext, type Worker } from 'playwright'
import { describe, expect, it } from 'vitest'
import { BrowserTabId } from '@deepseek-ai/dsh-browser'
import { boundResponseBody, createNetworkCapture } from '@deepseek-ai/dsh-tool-browser'

/** One event the extension's debugger listener saw, as Chrome reported it. */
interface ForwardedEvent {
  readonly tabId: string
  readonly method: string
  readonly params: Record<string, unknown>
}

/** Test-only access to the copied service worker's shipped dispatcher. */
type WorkerDispatch = { dispatchForTest: (method: string, params: Record<string, unknown>) => Promise<unknown> }

/**
 * URL Chrome reported for each request id, from its `requestWillBeSent` events.
 * A redirect reuses the request id, so the last event wins.
 */
function urlsById(events: readonly ForwardedEvent[]): Map<string, string> {
  const urls = new Map<string, string>()
  for (const event of events) {
    if (event.method !== 'Network.requestWillBeSent') continue
    const request = event.params.request
    const url = typeof request === 'object' && request !== null ? (request as { url?: unknown }).url : undefined
    if (typeof url === 'string') urls.set(String(event.params.requestId), url)
  }
  return urls
}

/** Whether a finished request whose URL ends with `suffix` appears in the log. */
function finished(events: readonly ForwardedEvent[], suffix: string): boolean {
  const urls = urlsById(events)
  return events.some(event => event.method === 'Network.loadingFinished'
    && (urls.get(String(event.params.requestId)) ?? '').endsWith(suffix))
}

/** Poll a worker-side reader until its value satisfies `done`. */
async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (done(value)) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting; last value ${JSON.stringify(value).slice(0, 400)}`)
    await new Promise((resolve) => { setTimeout(resolve, 100) })
  }
}

/** Serve the fixtures the capture test loads. */
async function serveFixtures(): Promise<{ base: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    if (request.url === '/api/data') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, items: [1, 2, 3] }))
      return
    }
    if (request.url === '/large') {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('x'.repeat(4096))
      return
    }
    if (request.url === '/redirect') {
      response.writeHead(302, { location: '/api/data' })
      response.end()
      return
    }
    if (request.url === '/missing') {
      response.writeHead(404, { 'content-type': 'text/plain' })
      response.end('nope')
      return
    }
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end(`<!doctype html><html><body><div id="mark">start</div><script>
      fetch('/api/data')
      fetch('/missing')
      fetch('/redirect')
      fetch('/large')
    </script></body></html>`)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture server has no port')
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => { if (error === undefined) resolve(); else reject(error) })
    }),
  }
}

describe.skipIf(process.env.DSH_BROWSER_E2E !== '1')('browser network capture in real Chrome', () => {
  it('reduces real forwarded CDP events and bounds a real response body', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-browser-network-e2e-'))
    const fixtures = await serveFixtures()
    let context: BrowserContext | undefined
    try {
      const extension = join(root, 'extension')
      await cp(new URL('../../browser-chrome-extension/extension', import.meta.url), extension, { recursive: true })
      await appendFile(join(extension, 'background.js'), `
globalThis.dispatchForTest = dispatch
globalThis.__dshNetworkEvents = []
chrome.debugger.onEvent.addListener((source, method, params) => {
  globalThis.__dshNetworkEvents.push({ tabId: String(source.tabId ?? ''), method, params })
})
`)
      context = await chromium.launchPersistentContext(join(root, 'profile'), {
        channel: 'chromium',
        headless: process.env.DSH_BROWSER_HEADED !== '1',
        args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
      })
      const worker: Worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker')
      const dispatch = (method: string, params: Record<string, unknown> = {}): Promise<unknown> => worker.evaluate(
        ({ method, params }) => (globalThis as unknown as WorkerDispatch).dispatchForTest(method, params),
        { method, params },
      )
      const read = (): Promise<ForwardedEvent[]> =>
        worker.evaluate(() => (globalThis as unknown as { __dshNetworkEvents: ForwardedEvent[] }).__dshNetworkEvents)

      const opened = await dispatch('tabs.create', { url: 'about:blank', group: true }) as { id: string }
      await dispatch('debugger.attach', { tabId: opened.id })
      const cdp = (method: string, params: Record<string, unknown> = {}): Promise<unknown> =>
        dispatch('debugger.sendCommand', { tabId: opened.id, method, params })
      await cdp('Network.enable')
      await cdp('Page.navigate', { url: `${fixtures.base}/` })

      const events = await waitFor(read, list => finished(list, '/api/data') && finished(list, '/missing'))
      // Chrome reports every loaded resource, not only the four the page fetched.
      expect(events.length).toBeGreaterThan(4)
      expect(events.every(event => event.tabId === opened.id)).toBe(true)

      const capture = createNetworkCapture({ maxRequests: 200 })
      capture.arm(opened.id)
      for (const event of events) {
        capture.record({ tabId: BrowserTabId(event.tabId), method: event.method, params: event.params })
      }
      const entries = capture.list(opened.id)
      const api = entries.find(entry => entry.url.endsWith('/api/data'))
      expect(api).toMatchObject({ method: 'GET', resourceType: 'Fetch', status: 200, mimeType: 'application/json' })
      expect(api?.encodedDataLength).toBeGreaterThan(0)
      expect(entries.find(entry => entry.url.endsWith('/missing'))).toMatchObject({ status: 404 })
      expect(entries.filter(entry => entry.url.endsWith('/large'))).toHaveLength(1)

      // A redirect reuses its request id: the surviving entry names the final hop.
      const redirected = events.find(event =>
        event.method === 'Network.requestWillBeSent' && urlsById([event]).get(String(event.params.requestId))?.endsWith('/redirect') === true)
      expect(redirected).toBeDefined()
      const redirectedId = String(redirected?.params.requestId)
      expect(entries.find(entry => entry.requestId === redirectedId)?.url.endsWith('/api/data')).toBe(true)
      expect(new Set(entries.map(entry => entry.requestId)).size).toBe(entries.length)

      const body = boundResponseBody(await cdp('Network.getResponseBody', { requestId: api?.requestId }), 1024)
      expect(body.encoding).toBe('utf8')
      expect(body.truncated).toBe(false)
      expect(JSON.parse(body.body ?? '')).toEqual({ ok: true, items: [1, 2, 3] })

      const large = entries.find(entry => entry.url.endsWith('/large'))
      const largeBody = boundResponseBody(await cdp('Network.getResponseBody', { requestId: large?.requestId }), 100)
      expect(largeBody).toMatchObject({ encoding: 'utf8', bytes: 4096, truncated: true })
      expect(largeBody.body).toHaveLength(100)

      // A tab nobody armed contributes nothing, even while its traffic is forwarded.
      const other = await dispatch('tabs.create', { url: `${fixtures.base}/` }) as { id: string }
      await dispatch('debugger.attach', { tabId: other.id })
      await dispatch('debugger.sendCommand', { tabId: other.id, method: 'Network.enable', params: {} })
      await waitFor(read, list => list.some(event => event.tabId === other.id))
      const armedBefore = capture.list(opened.id)
      for (const event of await read()) {
        capture.record({ tabId: BrowserTabId(event.tabId), method: event.method, params: event.params })
      }
      expect(capture.list(other.id)).toEqual([])
      expect(capture.list(opened.id)).toEqual(armedBefore)

      await dispatch('tabs.close', { tabId: other.id })
      await dispatch('tabs.close', { tabId: opened.id })
    } finally {
      await context?.close()
      await fixtures.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 120_000)
})
