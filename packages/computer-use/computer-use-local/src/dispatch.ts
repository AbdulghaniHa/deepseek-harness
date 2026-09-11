/**
 * JSON-RPC method dispatcher for the computer-use helper.
 * @module @deepseek-ai/dsh-computer-use-local/dispatch
 */

import { ComputerAppId, ComputerError, ComputerWindowId } from '@deepseek-ai/dsh-computer-use'
import type { DesktopBackend } from './backend.ts'

interface ScreenshotWire {
  readonly pngBase64: string
  readonly width: number
  readonly height: number
  readonly scale: number
  readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return {}
  return value as Record<string, unknown>
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * Dispatch one helper method onto a DesktopBackend.
 * @param backend - OS or native implementation.
 * @param method - RPC method name.
 * @param params - JSON params.
 * @returns a JSON-serializable result.
 */
export async function handleComputerMethod(
  backend: DesktopBackend,
  method: string,
  params: unknown,
): Promise<unknown> {
  const record = asRecord(params)
  switch (method) {
    case 'capabilities':
      return backend.capabilities()
    case 'permissions':
      return backend.permissions()
    case 'listApps':
      return backend.listApps()
    case 'listWindows':
      return backend.listWindows(typeof record.appId === 'string' ? ComputerAppId(record.appId) : undefined)
    case 'launchApp':
      return backend.launchApp({ name: asString(record.name) })
    case 'focusWindow':
      await backend.focusWindow(ComputerWindowId(asString(record.windowId)))
      return null
    case 'windowAtPoint':
      return await backend.windowAtPoint(asNumber(record.x), asNumber(record.y)) ?? null
    case 'snapshot':
      return backend.snapshot({
        windowId: ComputerWindowId(asString(record.windowId)),
        maxNodes: typeof record.maxNodes === 'number' ? record.maxNodes : 200,
        ...typeof record.query === 'string' ? { query: record.query } : {},
        ...typeof record.maxDepth === 'number' ? { maxDepth: record.maxDepth } : {},
        ...typeof record.rootHandle === 'string' ? { rootHandle: record.rootHandle } : {},
      })
    case 'screenshot': {
      const shot = await backend.screenshot({
        ...typeof record.windowId === 'string' ? { windowId: ComputerWindowId(record.windowId) } : {},
        ...typeof record.displayId === 'number' ? { displayId: record.displayId } : {},
        ...typeof record.region === 'object' && record.region !== null
          ? { region: record.region as { x: number; y: number; width: number; height: number } }
          : {},
      })
      const wire: ScreenshotWire = {
        pngBase64: Buffer.from(shot.png).toString('base64'),
        width: shot.width,
        height: shot.height,
        scale: shot.scale,
        bounds: shot.bounds,
      }
      return wire
    }
    case 'press':
      await backend.press(asString(record.handle))
      return null
    case 'setValue':
      await backend.setValue(asString(record.handle), asString(record.text))
      return null
    case 'action': {
      const action = record.action
      if (action !== 'activate' && action !== 'toggle' && action !== 'select' && action !== 'expandCollapse' && action !== 'setValue') {
        throw new ComputerError(`unknown accessibility action "${String(action)}"`, 'COMPUTER_UNSUPPORTED')
      }
      await backend.action({
        handle: asString(record.handle),
        action,
        ...typeof record.value === 'string' ? { value: record.value } : {},
      })
      return null
    }
    case 'click':
      await backend.click({
        x: asNumber(record.x),
        y: asNumber(record.y),
        button: record.button === 'right' || record.button === 'middle' ? record.button : 'left',
        count: typeof record.count === 'number' ? record.count : 1,
        ...Array.isArray(record.modifiers) ? { modifiers: record.modifiers as string[] } : {},
      })
      return null
    case 'type':
      await backend.type(asString(record.text))
      return null
    case 'key':
      await backend.key({
        key: asString(record.key),
        modifiers: Array.isArray(record.modifiers) ? record.modifiers as ('alt' | 'ctrl' | 'meta' | 'shift')[] : [],
        repeat: typeof record.repeat === 'number' ? record.repeat : 1,
      })
      return null
    case 'scroll':
      await backend.scroll({
        x: asNumber(record.x),
        y: asNumber(record.y),
        direction: record.direction === 'up' || record.direction === 'down' || record.direction === 'left' || record.direction === 'right'
          ? record.direction
          : 'down',
        amount: typeof record.amount === 'number' ? record.amount : 1,
        ...Array.isArray(record.modifiers) ? { modifiers: record.modifiers as string[] } : {},
      })
      return null
    case 'move':
      await backend.move({ x: asNumber(record.x), y: asNumber(record.y) })
      return null
    case 'drag':
      await backend.drag({
        fromX: asNumber(record.fromX),
        fromY: asNumber(record.fromY),
        toX: asNumber(record.toX),
        toY: asNumber(record.toY),
        ...Array.isArray(record.modifiers) ? { modifiers: record.modifiers as string[] } : {},
      })
      return null
    case 'clipboardRead':
      return backend.clipboardRead()
    case 'clipboardWrite':
      await backend.clipboardWrite(asString(record.text))
      return null
    default:
      throw new ComputerError(`unknown computer method ${method}`, 'COMPUTER_UNSUPPORTED')
  }
}

/**
 * Map an thrown value to a JSON-RPC error pair.
 * @param error - thrown value.
 * @returns code and message.
 */
export function errorPair(error: unknown): { readonly code: string; readonly message: string } {
  if (error instanceof ComputerError) return { code: error.code, message: error.message }
  if (error instanceof Error) return { code: 'COMPUTER_UNSUPPORTED', message: error.message }
  return { code: 'COMPUTER_UNSUPPORTED', message: String(error) }
}
