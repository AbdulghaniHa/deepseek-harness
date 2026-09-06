/**
 * CDP helpers used by browser tools. All page logic stays here so the
 * extension only relays raw commands.
 * @module @deepseek-ai/dsh-tool-browser/cdp
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { BrowserRuntime, BrowserTabId } from '@deepseek-ai/dsh-browser'

/** Object the tools use to send CDP to an attached tab. */
export interface CdpClient {
  send(method: string, params?: Readonly<Record<string, unknown>>): Promise<unknown>
}

/**
 * Bind a CDP client to one owner + tab.
 * @param browser - the seam.
 * @param owner - attached agent.
 * @param tabId - attached tab.
 * @param signal - optional cancellation.
 * @returns a send helper.
 */
export function cdpClient(
  browser: BrowserRuntime,
  owner: Agent,
  tabId: BrowserTabId,
  signal?: AbortSignal,
): CdpClient {
  return {
    send: (method, params) => browser.cdp(owner, { tabId, method, ...params !== undefined ? { params } : {} }, signal),
  }
}

/**
 * Read the current tab URL and title via CDP.
 * @param cdp - bound client.
 * @returns url and title.
 */
export async function pageIdentity(cdp: CdpClient): Promise<{ url: string; title: string }> {
  const result = await cdp.send('Target.getTargetInfo') as { targetInfo?: { url?: string; title?: string } }
  const nav = await cdp.send('Runtime.evaluate', {
    expression: '({ url: location.href, title: document.title })',
    returnByValue: true,
  }) as { result?: { value?: { url?: string; title?: string } } }
  return {
    url: nav.result?.value?.url ?? result.targetInfo?.url ?? '',
    title: nav.result?.value?.title ?? result.targetInfo?.title ?? '',
  }
}

/**
 * Click at viewport coordinates with trusted CDP input.
 * @param cdp - bound client.
 * @param x - viewport x.
 * @param y - viewport y.
 */
export async function clickAt(cdp: CdpClient, x: number, y: number): Promise<void> {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}

/**
 * Type text as individual trusted key events.
 * @param cdp - bound client.
 * @param text - characters to type.
 */
export async function typeText(cdp: CdpClient, text: string): Promise<void> {
  for (const char of text) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: char, unmodifiedText: char })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', text: char, unmodifiedText: char })
  }
}

/**
 * Box-model center of a backend node, or undefined when the node has no box.
 * @param cdp - bound client.
 * @param backendNodeId - DOM backend node id.
 * @returns viewport center or undefined.
 */
export async function nodeCenter(cdp: CdpClient, backendNodeId: number): Promise<{ x: number; y: number } | undefined> {
  const box = await cdp.send('DOM.getBoxModel', { backendNodeId }) as {
    model?: { content?: number[] }
  }
  const content = box.model?.content
  if (content === undefined || content.length < 8) return undefined
  const n = (i: number): number => content[i] ?? 0
  return {
    x: (n(0) + n(2) + n(4) + n(6)) / 4,
    y: (n(1) + n(3) + n(5) + n(7)) / 4,
  }
}
