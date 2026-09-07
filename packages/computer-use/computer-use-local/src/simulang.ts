/**
 * Optional `@simular-ai/simulang-js` adapter. Loaded only via dynamic import.
 * @module @deepseek-ai/dsh-computer-use-local/simulang
 */

import {
  ComputerAppId,
  ComputerError,
  ComputerWindowId,
  type ComputerApp,
  type ComputerCapability,
  type ComputerClickRequest,
  type ComputerDragRequest,
  type ComputerKeyRequest,
  type ComputerLaunchRequest,
  type ComputerPermissions,
  type ComputerScreenshot,
  type ComputerScreenshotRequest,
  type ComputerScrollRequest,
  type ComputerSnapshot,
  type ComputerSnapshotNode,
  type ComputerSnapshotRequest,
  type ComputerWindow,
} from '@deepseek-ai/dsh-computer-use'
import type { DesktopBackend } from './backend.ts'

/** Duck-typed subset of simulang-js used by the helper. */
interface SimulangModule {
  readonly default?: SimulangModule
  listWindows?: () => Promise<readonly SimulangWindow[]>
  listApps?: () => Promise<readonly SimulangApp[]>
  launch?: (name: string) => Promise<SimulangApp>
  screenshot?: (options?: { windowId?: string }) => Promise<Uint8Array | { png: Uint8Array; width: number; height: number; scale?: number }>
  snapshot?: (windowId: string) => Promise<{ nodes: readonly SimulangNode[] }>
  press?: (refId: string) => Promise<void>
  setValue?: (refId: string, text: string) => Promise<void>
  click?: (x: number, y: number, options?: { button?: string; count?: number }) => Promise<void>
  type?: (text: string) => Promise<void>
  key?: (key: string) => Promise<void>
  scroll?: (x: number, y: number, dx: number, dy: number) => Promise<void>
  move?: (x: number, y: number) => Promise<void>
  drag?: (from: { x: number; y: number }, to: { x: number; y: number }) => Promise<void>
  clipboard?: { read: () => Promise<string>; write: (text: string) => Promise<void> }
  permissions?: () => Promise<ComputerPermissions>
}

interface SimulangApp {
  readonly id?: string
  readonly name?: string
  readonly pid?: number
  readonly bundleId?: string
}

interface SimulangWindow {
  readonly id?: string
  readonly appId?: string
  readonly title?: string
  readonly x?: number
  readonly y?: number
  readonly width?: number
  readonly height?: number
  readonly focused?: boolean
}

interface SimulangNode {
  readonly refId?: string
  readonly role?: string
  readonly name?: string
  readonly value?: string
  readonly x?: number
  readonly y?: number
  readonly width?: number
  readonly height?: number
  readonly states?: readonly string[]
  readonly supportsPress?: boolean
  readonly supportsSetValue?: boolean
  readonly secure?: boolean
}

/**
 * Dynamically import simulang-js when it is installed.
 * @param importer - optional override for tests.
 * @returns the module, or undefined when the optional dependency is absent.
 */
export async function loadSimulang(
  importer: () => Promise<SimulangModule> = async () => {
    const specifier = '@simular-ai/simulang-js'
    return await import(specifier) as SimulangModule
  },
): Promise<SimulangModule | undefined> {
  try {
    const loaded = await importer()
    return loaded.default ?? loaded
  } catch {
    return undefined
  }
}

function mapApp(app: SimulangApp, index: number): ComputerApp {
  const name = app.name ?? app.bundleId ?? `app-${index}`
  return {
    id: ComputerAppId(app.bundleId ?? app.id ?? name),
    name,
    pid: app.pid ?? 0,
    ...app.bundleId === undefined ? {} : { bundleId: app.bundleId },
  }
}

function mapWindow(window: SimulangWindow, index: number): ComputerWindow {
  return {
    id: ComputerWindowId(window.id ?? `window-${index}`),
    appId: ComputerAppId(window.appId ?? 'unknown'),
    title: window.title ?? '',
    bounds: {
      x: window.x ?? 0,
      y: window.y ?? 0,
      width: window.width ?? 0,
      height: window.height ?? 0,
    },
    focused: window.focused === true,
  }
}

function mapNode(node: SimulangNode, index: number): ComputerSnapshotNode {
  const value = node.secure === true ? undefined : node.value
  return {
    handle: node.refId ?? `n${index}`,
    role: node.role ?? 'unknown',
    name: node.name ?? '',
    ...value === undefined ? {} : { value },
    bounds: {
      x: node.x ?? 0,
      y: node.y ?? 0,
      width: node.width ?? 0,
      height: node.height ?? 0,
    },
    states: node.states ?? [],
    supportsPress: node.supportsPress === true,
    supportsSetValue: node.supportsSetValue === true,
    secure: node.secure === true,
  }
}

/**
 * Wrap a loaded simulang module as a DesktopBackend.
 * @param module - duck-typed simulang export.
 * @returns a DesktopBackend.
 */
export function createSimulangBackend(module: SimulangModule): DesktopBackend {
  return {
    capabilities(): readonly ComputerCapability[] {
      return ['a11y', 'screenshot', 'input', 'clipboard', 'background-actions']
    },

    async permissions(): Promise<ComputerPermissions> {
      if (module.permissions) return module.permissions()
      return { accessibility: 'unknown', screenRecording: 'unknown', inputInjection: 'unknown' }
    },

    async listApps(): Promise<readonly ComputerApp[]> {
      if (module.listApps) return (await module.listApps()).map(mapApp)
      const windows = module.listWindows ? await module.listWindows() : []
      const seen = new Map<string, ComputerApp>()
      for (const [index, window] of windows.entries()) {
        const mapped = mapWindow(window, index)
        if (!seen.has(mapped.appId)) {
          seen.set(mapped.appId, { id: mapped.appId, name: mapped.appId, pid: 0 })
        }
      }
      return [...seen.values()]
    },

    async listWindows(): Promise<readonly ComputerWindow[]> {
      if (!module.listWindows) return []
      return (await module.listWindows()).map(mapWindow)
    },

    async launchApp(request: ComputerLaunchRequest): Promise<ComputerApp> {
      if (!module.launch) throw new ComputerError('simulang launch is unavailable', 'COMPUTER_UNSUPPORTED')
      return mapApp(await module.launch(request.name), 0)
    },

    async focusWindow(): Promise<void> {
      throw new ComputerError('simulang focusWindow is unavailable', 'COMPUTER_UNSUPPORTED')
    },

    async windowAtPoint(): Promise<ComputerWindow | undefined> {
      return undefined
    },

    async snapshot(request: ComputerSnapshotRequest): Promise<ComputerSnapshot> {
      if (!module.snapshot) throw new ComputerError('simulang snapshot is unavailable', 'COMPUTER_UNSUPPORTED')
      const raw = await module.snapshot(request.windowId)
      const capped = raw.nodes.slice(0, request.maxNodes).map(mapNode)
      return {
        windowId: request.windowId,
        appId: ComputerAppId('unknown'),
        title: '',
        nodes: capped,
        truncated: raw.nodes.length > request.maxNodes,
      }
    },

    async screenshot(request: ComputerScreenshotRequest): Promise<ComputerScreenshot> {
      if (!module.screenshot) throw new ComputerError('simulang screenshot is unavailable', 'COMPUTER_UNSUPPORTED')
      const raw = await module.screenshot(request.windowId === undefined ? undefined : { windowId: request.windowId })
      if (raw instanceof Uint8Array) {
        return { png: raw, width: 0, height: 0, scale: 1, bounds: { x: 0, y: 0, width: 0, height: 0 } }
      }
      return {
        png: raw.png,
        width: raw.width,
        height: raw.height,
        scale: raw.scale ?? 1,
        bounds: { x: 0, y: 0, width: raw.width, height: raw.height },
      }
    },

    async press(handle: string): Promise<void> {
      if (!module.press) throw new ComputerError('simulang press is unavailable', 'COMPUTER_UNSUPPORTED')
      await module.press(handle)
    },

    async setValue(handle: string, text: string): Promise<void> {
      if (!module.setValue) throw new ComputerError('simulang setValue is unavailable', 'COMPUTER_UNSUPPORTED')
      await module.setValue(handle, text)
    },

    async click(request: ComputerClickRequest): Promise<void> {
      if (!module.click) throw new ComputerError('simulang click is unavailable', 'COMPUTER_UNSUPPORTED')
      await module.click(request.x, request.y, {
        ...request.button === undefined ? {} : { button: request.button },
        ...request.count === undefined ? {} : { count: request.count },
      })
    },

    async type(text: string): Promise<void> {
      if (!module.type) throw new ComputerError('simulang type is unavailable', 'COMPUTER_UNSUPPORTED')
      await module.type(text)
    },

    async key(request: ComputerKeyRequest): Promise<void> {
      if (!module.key) throw new ComputerError('simulang key is unavailable', 'COMPUTER_UNSUPPORTED')
      await module.key(request.key)
    },

    async scroll(request: ComputerScrollRequest): Promise<void> {
      if (!module.scroll) throw new ComputerError('simulang scroll is unavailable', 'COMPUTER_UNSUPPORTED')
      const dx = request.direction === 'left' ? -request.amount : request.direction === 'right' ? request.amount : 0
      const dy = request.direction === 'up' ? -request.amount : request.direction === 'down' ? request.amount : 0
      await module.scroll(request.x, request.y, dx, dy)
    },

    async move(request: { readonly x: number; readonly y: number }): Promise<void> {
      if (!module.move) throw new ComputerError('simulang move is unavailable', 'COMPUTER_UNSUPPORTED')
      await module.move(request.x, request.y)
    },

    async drag(request: ComputerDragRequest): Promise<void> {
      if (!module.drag) throw new ComputerError('simulang drag is unavailable', 'COMPUTER_UNSUPPORTED')
      await module.drag({ x: request.fromX, y: request.fromY }, { x: request.toX, y: request.toY })
    },

    async clipboardRead(): Promise<string> {
      if (!module.clipboard) throw new ComputerError('simulang clipboard is unavailable', 'COMPUTER_UNSUPPORTED')
      return module.clipboard.read()
    },

    async clipboardWrite(text: string): Promise<void> {
      if (!module.clipboard) throw new ComputerError('simulang clipboard is unavailable', 'COMPUTER_UNSUPPORTED')
      await module.clipboard.write(text)
    },
  }
}
