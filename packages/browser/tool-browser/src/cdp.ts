/**
 * CDP helpers used by browser tools. All page logic stays here so the
 * extension only relays raw commands.
 * @module @deepseek-ai/dsh-tool-browser/cdp
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { BrowserRuntime, BrowserTabId } from '@deepseek-ai/dsh-browser'
import { modifierMask, shortcutModifier } from './input.ts'

/** Object the tools use to send CDP to an attached tab. */
export interface CdpClient {
  send(method: string, params?: Readonly<Record<string, unknown>>): Promise<unknown>
}

/** Optional child debugger session for an OOPIF or flattened target. */
export interface CdpSession {
  readonly sessionId?: string
  readonly targetId?: string
}

/** Trusted mouse click options. */
export interface ClickOptions {
  readonly button?: 'left' | 'right' | 'middle'
  readonly count?: number
  readonly modifiers?: readonly string[]
}

/**
 * Bind a CDP client to one owner + tab, optionally a child debugger session.
 * @param browser - the seam.
 * @param owner - attached agent.
 * @param tabId - attached tab.
 * @param signal - optional cancellation.
 * @param session - flattened CDP session or target for a child frame.
 * @returns a send helper.
 */
export function cdpClient(
  browser: BrowserRuntime,
  owner: Agent,
  tabId: BrowserTabId,
  signal?: AbortSignal,
  session?: CdpSession,
): CdpClient {
  return {
    send: (method, params) => browser.cdp(owner, {
      tabId,
      method,
      ...params !== undefined ? { params } : {},
      ...session?.sessionId !== undefined && session.sessionId.length > 0 ? { sessionId: session.sessionId } : {},
      ...session?.targetId !== undefined && session.targetId.length > 0 ? { targetId: session.targetId } : {},
    }, signal),
  }
}

/**
 * Read the current tab URL and title via CDP.
 * @param cdp - bound client.
 * @param contextId - optional execution context for a same-process iframe.
 * @returns url and title.
 */
export async function pageIdentity(
  cdp: CdpClient,
  contextId?: number,
): Promise<{ url: string; title: string }> {
  const result = await cdp.send('Target.getTargetInfo') as { targetInfo?: { url?: string; title?: string } }
  const nav = await evaluateJson<{ url?: string; title?: string }>(
    cdp,
    '({ url: location.href, title: document.title })',
    contextId,
  )
  return {
    url: nav?.url ?? result.targetInfo?.url ?? '',
    title: nav?.title ?? result.targetInfo?.title ?? '',
  }
}

/**
 * Evaluate an expression that returns JSON in an optional execution context.
 * @param cdp - bound client.
 * @param expression - JavaScript source.
 * @param contextId - frame execution context; omitted uses the default world.
 * @returns the JSON value, or undefined when the result is empty.
 */
export async function evaluateJson<T>(
  cdp: CdpClient,
  expression: string,
  contextId?: number,
): Promise<T | undefined> {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    ...contextId !== undefined ? { contextId } : {},
  }) as {
    result?: { value?: T }
    exceptionDetails?: { text?: string; exception?: { description?: string } }
  }
  if (result.exceptionDetails !== undefined) {
    throw new Error(
      result.exceptionDetails.exception?.description
      ?? result.exceptionDetails.text
      ?? 'evaluate threw',
    )
  }
  return result.result?.value
}

/**
 * Click at viewport coordinates with trusted CDP input.
 * @param cdp - bound client.
 * @param x - viewport x.
 * @param y - viewport y.
 * @param options - button, count, and named modifiers.
 */
export async function clickAt(
  cdp: CdpClient,
  x: number,
  y: number,
  options: ClickOptions = {},
): Promise<void> {
  const button = options.button === 'right' || options.button === 'middle' ? options.button : 'left'
  const count = options.count ?? 1
  const modifiers = modifierMask(options.modifiers)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers })
  for (let clickCount = 1; clickCount <= count; clickCount += 1) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount, modifiers })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount, modifiers })
  }
}

/**
 * Insert text through CDP `Input.insertText` (Unicode-safe).
 * @param cdp - bound client.
 * @param text - characters to insert at the caret.
 */
export async function insertText(cdp: CdpClient, text: string): Promise<void> {
  await cdp.send('Input.insertText', { text })
}

/**
 * Type text as insertion at the caret. Uses insertText so non-BMP characters
 * are not split across key events.
 * @param cdp - bound client.
 * @param text - characters to type.
 */
export async function typeText(cdp: CdpClient, text: string): Promise<void> {
  await insertText(cdp, text)
}

/**
 * Select all in the focused field using the host shortcut modifier.
 * @param cdp - bound client.
 * @param platform - host OS for the shortcut key.
 */
export async function selectAll(cdp: CdpClient, platform: NodeJS.Platform = process.platform): Promise<void> {
  const modifiers = shortcutModifier(platform)
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', modifiers })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', modifiers })
}

/**
 * Replace the focused field's contents.
 * @param cdp - bound client.
 * @param text - replacement text.
 * @param platform - host OS for select-all.
 */
export async function fillText(
  cdp: CdpClient,
  text: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  await selectAll(cdp, platform)
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace' })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace' })
  await insertText(cdp, text)
}

/**
 * Press a named key with named modifiers.
 * @param cdp - bound client.
 * @param key - CDP key name, for example Enter or a.
 * @param modifiers - named modifiers.
 */
export async function pressKey(cdp: CdpClient, key: string, modifiers?: readonly string[]): Promise<void> {
  const mask = modifierMask(modifiers)
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, ...mask !== 0 ? { modifiers: mask } : {} })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, ...mask !== 0 ? { modifiers: mask } : {} })
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
  /* v8 ignore next -- a box model carries four corners, so the length guard above makes every accessed index present. */
  const n = (i: number): number => content[i] ?? 0
  return {
    x: (n(0) + n(2) + n(4) + n(6)) / 4,
    y: (n(1) + n(3) + n(5) + n(7)) / 4,
  }
}

/**
 * Drag with trusted pointer events from one viewport point to another.
 * @param cdp - bound client for the owning frame.
 * @param from - press point.
 * @param to - release point.
 * @param modifiers - named modifiers held during the drag.
 */
export async function dragAt(
  cdp: CdpClient,
  from: { readonly x: number; readonly y: number },
  to: { readonly x: number; readonly y: number },
  modifiers?: readonly string[],
): Promise<void> {
  const mask = modifierMask(modifiers)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, modifiers: mask })
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1, modifiers: mask,
  })
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: to.x, y: to.y, button: 'left', modifiers: mask,
  })
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1, modifiers: mask,
  })
}

/**
 * Scroll at a viewport point. Nested containers receive the wheel event at that point.
 * @param cdp - bound client.
 * @param x - viewport x.
 * @param y - viewport y.
 * @param deltaX - horizontal wheel delta.
 * @param deltaY - vertical wheel delta.
 */
export async function scrollAt(
  cdp: CdpClient,
  x: number,
  y: number,
  deltaX: number,
  deltaY: number,
): Promise<void> {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY })
}
