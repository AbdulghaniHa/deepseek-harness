/**
 * Bounded actionability checks for ref-based browser input. Readiness is
 * retried until the deadline; a completed action is never repeated.
 * @module @deepseek-ai/dsh-tool-browser/actionability
 */

import { nodeCenter, type CdpClient } from './cdp.ts'

/** Kind of interaction the check must satisfy. */
export type ActionKind = 'click' | 'type' | 'fill' | 'hover' | 'select' | 'drag'

/** Successful geometry after the target was ready. */
export interface ReadyTarget {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

const CHECK_SCRIPT = `function(kind) {
  const el = this;
  if (!(el instanceof Element) || !el.isConnected) return { ok: false, reason: 'detached' };
  const style = getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
    return { ok: false, reason: 'hidden' };
  }
  const rects = el.getClientRects();
  if (rects.length === 0) return { ok: false, reason: 'not visible' };
  const rect = rects[0];
  if (rect.width === 0 || rect.height === 0) return { ok: false, reason: 'not visible' };
  const disabled = el instanceof HTMLElement && (el.disabled || el.getAttribute('aria-disabled') === 'true');
  if ((kind === 'click' || kind === 'type' || kind === 'fill' || kind === 'select' || kind === 'drag') && disabled) {
    return { ok: false, reason: 'disabled' };
  }
  const readonly = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
    ? el.readOnly
    : el.getAttribute('aria-readonly') === 'true';
  if ((kind === 'type' || kind === 'fill') && readonly) return { ok: false, reason: 'readonly' };
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const top = document.elementFromPoint(x, y);
  if (top === null || (top !== el && !el.contains(top))) return { ok: false, reason: 'obstructed' };
  return { ok: true, x, y, width: rect.width, height: rect.height };
}`

/**
 * Scroll the node into view, then retry visibility, enabled/editable, stable
 * geometry, and hit-testing until `deadline` or the node is ready.
 * @param cdp - bound client for the node's frame.
 * @param backendNodeId - DOM backend node id.
 * @param kind - interaction the checks must satisfy.
 * @param deadline - epoch milliseconds at which retries stop.
 * @param signal - cooperative cancellation.
 * @returns viewport center and size once the node is ready.
 */
export async function waitForActionable(
  cdp: CdpClient,
  backendNodeId: number,
  kind: ActionKind,
  deadline: number,
  signal?: AbortSignal,
): Promise<ReadyTarget> {
  let last = 'not ready'
  while (Date.now() < deadline) {
    signal?.throwIfAborted()
    try {
      await cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId })
    } catch {
      last = 'detached'
      await pause(signal)
      continue
    }
    const first = await inspect(cdp, backendNodeId, kind)
    if (!first.ok) {
      last = first.reason
      await pause(signal)
      continue
    }
    await pause(signal)
    const second = await inspect(cdp, backendNodeId, kind)
    if (!second.ok) {
      last = second.reason
      continue
    }
    if (Math.abs(first.x - second.x) > 1 || Math.abs(first.y - second.y) > 1) {
      last = 'unstable geometry'
      continue
    }
    return { x: second.x, y: second.y, width: second.width, height: second.height }
  }
  throw new Error(`target is not actionable (${last})`)
}

async function inspect(
  cdp: CdpClient,
  backendNodeId: number,
  kind: ActionKind,
): Promise<{ ok: true; x: number; y: number; width: number; height: number } | { ok: false; reason: string }> {
  const resolved = await cdp.send('DOM.resolveNode', { backendNodeId }) as {
    object?: { objectId?: string }
  }
  const objectId = resolved.object?.objectId
  if (objectId === undefined) return { ok: false, reason: 'detached' }
  let hitObjectId: string | undefined
  try {
    const result = await cdp.send('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: CHECK_SCRIPT,
      arguments: [{ value: kind }],
      returnByValue: true,
    }) as {
      result?: { value?: { ok?: boolean; reason?: string; width?: number; height?: number } }
      exceptionDetails?: { text?: string }
    }
    if (result.exceptionDetails !== undefined) {
      return { ok: false, reason: result.exceptionDetails.text ?? 'evaluate threw' }
    }
    const value = result.result?.value
    if (value?.ok !== true) {
      return { ok: false, reason: value?.reason ?? 'not ready' }
    }
    // CDP box coordinates include same-process ancestor frame offsets and transforms.
    const center = await nodeCenter(cdp, backendNodeId)
    if (center === undefined) return { ok: false, reason: 'not visible' }
    const hit = await cdp.send('DOM.getNodeForLocation', {
      x: Math.round(center.x), y: Math.round(center.y), includeUserAgentShadowDOM: true,
    }) as { backendNodeId?: number }
    if (hit.backendNodeId !== backendNodeId) {
      if (hit.backendNodeId === undefined) return { ok: false, reason: 'obstructed' }
      const resolvedHit = await cdp.send('DOM.resolveNode', { backendNodeId: hit.backendNodeId }) as {
        object?: { objectId?: string }
      }
      hitObjectId = resolvedHit.object?.objectId
      if (hitObjectId === undefined) return { ok: false, reason: 'obstructed' }
      let contains: { result?: { value?: boolean } }
      try {
        contains = await cdp.send('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: 'function(hit) { return this.contains(hit); }',
          arguments: [{ objectId: hitObjectId }],
          returnByValue: true,
        }) as typeof contains
      } catch {
        // A hit in an ancestor document belongs to another JavaScript world.
        return { ok: false, reason: 'obstructed' }
      }
      if (contains.result?.value !== true) return { ok: false, reason: 'obstructed' }
    }
    return { ok: true, ...center, width: value.width ?? 0, height: value.height ?? 0 }
  } finally {
    for (const id of [objectId, hitObjectId]) {
      if (id === undefined) continue
      try {
        await cdp.send('Runtime.releaseObject', { objectId: id })
      } catch {
        // Navigation or target detach already destroys the remote object.
      }
    }
  }
}

async function pause(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, 50)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
