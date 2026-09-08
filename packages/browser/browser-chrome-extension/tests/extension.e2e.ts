/** Real extension commands in an isolated Chromium profile; opt in with DSH_BROWSER_E2E=1. */
import { cp, mkdtemp, appendFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { describe, expect, it } from 'vitest'

/** Test-only access to the copied service worker's shipped dispatcher. */
type WorkerDispatch = { dispatchForTest: (method: string, params: Record<string, unknown>) => Promise<unknown> }

describe.skipIf(process.env.DSH_BROWSER_E2E !== '1')('background Chrome extension', () => {
  it('clicks, types, scrolls, and captures an inactive grouped tab while user input stays in another tab', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-browser-e2e-'))
    try {
      const extension = join(root, 'extension')
      await cp(new URL('../extension', import.meta.url), extension, { recursive: true })
      await appendFile(join(extension, 'background.js'), '\nglobalThis.dispatchForTest = dispatch\n')
      const context = await chromium.launchPersistentContext(join(root, 'profile'), {
        channel: 'chromium', headless: process.env.DSH_BROWSER_HEADED !== '1',
        ...(process.env.DSH_BROWSER_CHROMIUM === undefined ? {} : { executablePath: process.env.DSH_BROWSER_CHROMIUM }),
        args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
      })
      try {
        const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker')
        const dispatch = (method: string, params: Record<string, unknown> = {}) => worker.evaluate(
          ({ method, params }) => (globalThis as unknown as WorkerDispatch).dispatchForTest(method, params), { method, params },
        )
        const user = context.pages()[0] ?? await context.newPage()
        await user.setContent('<input id="user" autofocus>')
        await user.locator('input').focus()
        await user.bringToFront()
        const before = await worker.evaluate(async () => {
          const chrome = (globalThis as unknown as { chrome: { tabs: { query: (q: object) => Promise<{ id: number }[]> } } }).chrome
          return (await chrome.tabs.query({ active: true }))[0]?.id
        })
        const opened = await dispatch('tabs.create', { url: 'about:blank', group: true }) as { id: string; active: boolean }
        expect(opened.active).toBe(false)
        await dispatch('debugger.attach', { tabId: opened.id })
        const cdp = (method: string, params: Record<string, unknown> = {}) => dispatch('debugger.sendCommand', { tabId: opened.id, method, params })
        const html = '<input id="agent"><button>Click</button><div style="height:3000px"></div>'
        await cdp('Runtime.evaluate', { expression: `document.body.innerHTML = ${JSON.stringify(html)}; document.querySelector('button').onclick = () => { document.querySelector('button').textContent = 'Clicked' }` })
        const point = await cdp('Runtime.evaluate', { expression: '({x:document.querySelector("button").getBoundingClientRect().x+10,y:20})', returnByValue: true }) as { result: { value: { x: number; y: number } } }
        for (const type of ['mousePressed', 'mouseReleased']) await cdp('Input.dispatchMouseEvent', { type, ...point.result.value, button: 'left', clickCount: 1 })
        await cdp('Runtime.evaluate', { expression: 'document.querySelector("input").focus()' })
        await cdp('Input.insertText', { text: 'agent text' })
        await user.keyboard.type('user text')
        await cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 100, y: 100, deltaX: 0, deltaY: 500 })
        const shot = await cdp('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }) as { data: string }
        expect(Buffer.from(shot.data, 'base64').subarray(1, 4).toString()).toBe('PNG')
        const value = await cdp('Runtime.evaluate', { expression: '({value:document.querySelector("input").value,button:document.querySelector("button").textContent})', returnByValue: true }) as { result: { value: unknown } }
        expect(value.result.value).toEqual({ value: 'agent text', button: 'Clicked' })
        expect(await user.locator('input').inputValue()).toBe('user text')
        const tabs = await dispatch('tabs.list') as { id: string; active: boolean }[]
        expect(tabs.find(tab => tab.active)?.id).toBe(String(before))
        await dispatch('tabs.close', { tabId: opened.id })
      } finally {
        await context.close()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
