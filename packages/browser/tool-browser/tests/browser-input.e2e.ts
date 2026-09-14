/** Real Chromium input geometry and ancestor-frame obstruction. Opt in with DSH_BROWSER_E2E=1. */
import { chromium } from 'playwright'
import { describe, expect, it } from 'vitest'
import { clickAt, waitForActionable, type CdpClient } from '@deepseek-ai/dsh-tool-browser'

describe.skipIf(process.env.DSH_BROWSER_E2E !== '1')('browser input in real Chromium', () => {
  it('clicks a transformed iframe target and rejects an overlay in its parent', async () => {
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      await page.setContent(`<button style="position:absolute;left:10px;top:10px" onclick="this.textContent='WRONG'">Parent</button>
        <iframe style="position:absolute;left:300px;top:200px;transform:scale(1.2);transform-origin:0 0" srcdoc="<button id='target' onclick=&quot;this.textContent='Clicked'&quot;>Target</button>"></iframe>`)
      const frame = page.frames().find(item => item !== page.mainFrame())!
      await frame.waitForSelector('#target')
      const session = await page.context().newCDPSession(page)
      const cdp: CdpClient = { send: (method, params) => session.send(method as never, params as never) }
      const resolved = await session.send('Runtime.evaluate', {
        expression: "document.querySelector('iframe').contentDocument.querySelector('#target')",
      })
      const described = await session.send('DOM.describeNode', { objectId: resolved.result.objectId! })
      const target = described.node.backendNodeId
      const point = await waitForActionable(cdp, target, 'click', Date.now() + 2_000)
      expect(point.x).toBeGreaterThan(300)
      expect(point.y).toBeGreaterThan(200)
      await clickAt(cdp, point.x, point.y)
      expect(await frame.locator('#target').textContent()).toBe('Clicked')
      expect(await page.locator('body > button').textContent()).toBe('Parent')
      await page.evaluate(() => {
        const overlay = document.createElement('div')
        overlay.style.cssText = 'position:fixed;inset:0;z-index:999;background:transparent'
        document.body.append(overlay)
      })
      await expect(waitForActionable(cdp, target, 'click', Date.now() + 200)).rejects.toThrow(/obstructed/)
    } finally {
      await browser.close()
    }
  })
})
