/**
 * Optional `@simular-ai/simulang-js` adapter over its v13 class API
 * (`Machine`, `Window`, `AccessibilityTree`). Loaded only via dynamic import.
 * Window ids are `<pid>:<title>` (deduplicated with `#n`); app ids are
 * `pid:<pid>`; node handles are `<refId>@<windowId>` and resolve against the
 * tree captured by the last `snapshot` of that window.
 * @module @deepseek-ai/dsh-computer-use-local/simulang
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
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
  type ComputerPermissionState,
  type ComputerPermissions,
  type ComputerRect,
  type ComputerScreenshot,
  type ComputerScreenshotRequest,
  type ComputerScrollRequest,
  type ComputerSnapshot,
  type ComputerSnapshotNode,
  type ComputerSnapshotRequest,
  type ComputerWindow,
} from '@deepseek-ai/dsh-computer-use'
import type { DesktopBackend } from './backend.ts'

const execFileAsync = promisify(execFile)

/** Exclusive-edge box as simulang reports it. */
export interface SimulangBox {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

/** Screenshot handle: PNG base64 plus pixel dimensions. */
export interface SimulangScreenshot {
  readonly dimensions: readonly [number, number]
  base64(): string
}

/** One top-level window handle. */
export interface SimulangWindow {
  readonly title: string
  readonly pid: number
  boundingBox(): SimulangBox
  focus(): boolean
  screenshot(hideCursor: boolean): SimulangScreenshot
}

/** One captured accessibility node with a frozen `refId`. */
export interface SimulangNode {
  readonly role: number
  readonly name: string
  readonly value: string
  readonly isEnabled: boolean
  readonly boundingBox: SimulangBox | null
  readonly children: readonly SimulangNode[]
  readonly refId: number | null
}

/** Window-scoped accessibility tree with ref-based actions. */
export interface SimulangTree {
  snapshot(visibleOnly?: boolean): SimulangNode
  activate(refId: number): void
  setValue(refId: number, value: string): void
  toggle(refId: number): void
  select(refId: number): void
  expandCollapse(refId: number): void
}

/** Running application instance returned by `App.open`. */
export interface SimulangInstance {
  readonly pid: number | null
}

/** Installed application handle. */
export interface SimulangApp {
  open(url: string | null, focusPolicy: number, visibility: number, waitForLoadComplete: boolean): SimulangInstance
}

/** Display handle. */
export interface SimulangScreen {
  screenshot(hideCursor: boolean): SimulangScreenshot
  boundingBox(): SimulangBox
}

/** The local desktop. */
export interface SimulangMachine {
  app(name: string): SimulangApp
  windows(): readonly SimulangWindow[]
  focusedWindow(): SimulangWindow | null
  windowAtPoint(x: number, y: number): SimulangWindow | null
  mainScreen(): SimulangScreen
  screenshotCropped(x: number, y: number, width: number, height: number, hideCursor: boolean): SimulangScreenshot
  mouseButton(button: number, direction: number): void
  moveMouse(x: number, y: number, coordinate: number): void
  scroll(deltaX: number, deltaY: number): void
  typeText(text: string): void
  key(key: number, direction: number): void
  getClipboardString(): string | null
  setClipboardString(value: string): unknown
}

/** Log record simulang forwards when `initLogger` is installed. */
export interface SimulangLogRecord {
  readonly level: string
  readonly target: string
  readonly message: string
}

/** Structural subset of the simulang-js v13 module the helper uses. */
export interface SimulangModule {
  readonly default?: SimulangModule
  readonly Machine: { local(): SimulangMachine }
  readonly AccessibilityTree: { fromWindow(window: SimulangWindow): SimulangTree }
  readonly Button: { readonly Left: number; readonly Middle: number; readonly Right: number }
  readonly Direction: { readonly Press: number; readonly Release: number; readonly Click: number }
  readonly Coordinate: { readonly Abs: number }
  readonly FocusPolicy: { readonly Steal: number }
  readonly Visibility: { readonly Show: number }
  ariaRoleToString(role: number): string
  keyFromString(value: string): number
  hasScreenCapturePermission?(): boolean
  initLogger?(callback: (record: SimulangLogRecord) => void, spec?: string | null): void
}

const REQUIRED_EXPORTS: readonly (keyof SimulangModule)[] = [
  'Machine',
  'AccessibilityTree',
  'Button',
  'Direction',
  'Coordinate',
  'FocusPolicy',
  'Visibility',
  'ariaRoleToString',
  'keyFromString',
]

function isSimulangModule(value: unknown): value is SimulangModule {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return REQUIRED_EXPORTS.every(key => record[key] !== undefined)
}

/**
 * Dynamically import simulang-js when it is installed and exposes the v13 API.
 * @param importer - optional override for tests.
 * @returns the module, or undefined when the optional dependency is absent or has another API.
 */
export async function loadSimulang(
  importer: () => Promise<unknown> = async () => {
    const specifier = '@simular-ai/simulang-js'
    return await (import(specifier) as Promise<unknown>)
  },
): Promise<SimulangModule | undefined> {
  let loaded: unknown
  try {
    loaded = await importer()
  } catch {
    // The optional native addon is not installed for this platform.
    return undefined
  }
  const candidate = typeof loaded === 'object' && loaded !== null && 'default' in loaded && isSimulangModule(loaded.default)
    ? loaded.default
    : loaded
  return isSimulangModule(candidate) ? candidate : undefined
}

/** Tree action a press dispatches to, chosen by role at snapshot time. */
type PressAction = keyof Pick<SimulangTree, 'activate' | 'toggle' | 'select' | 'expandCollapse'>

/** Roles whose primary action is a press; each maps to the tree action simulang expects. */
const PRESS_ACTIONS: Readonly<Record<string, PressAction>> = {
  button: 'activate',
  link: 'activate',
  menuitem: 'activate',
  img: 'activate',
  checkbox: 'toggle',
  switch: 'toggle',
  menuitemcheckbox: 'toggle',
  tab: 'select',
  radio: 'select',
  option: 'select',
  menuitemradio: 'select',
  treeitem: 'expandCollapse',
  combobox: 'expandCollapse',
}

/** Remaining node budget and the per-ref press action collected during one snapshot walk. */
interface Walk {
  left: number
  readonly actions: Map<number, PressAction>
}

/** Roles whose value the tree can set directly. */
const SET_VALUE_ROLES: ReadonlySet<string> = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider', 'password'])

/** Tool-facing key names that differ from simulang's `keyFromString` vocabulary. */
const KEY_ALIASES: Readonly<Record<string, string>> = {
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  ' ': 'Space',
  esc: 'Escape',
  cmd: 'Meta',
  command: 'Meta',
  ctrl: 'Control',
  win: 'Meta',
  super: 'Meta',
}

const MODIFIER_KEYS: Readonly<Record<string, string>> = {
  alt: 'Alt',
  ctrl: 'Control',
  meta: 'Meta',
  shift: 'Shift',
}

/**
 * Run one synchronous simulang call as a promise so a thrown native error
 * becomes a rejection the RPC dispatcher and provider can route.
 */
function settle<T>(call: () => T): Promise<T> {
  return new Promise<T>((resolve) => { resolve(call()) })
}

function rect(box: SimulangBox | null): ComputerRect {
  if (box === null) return { x: 0, y: 0, width: 0, height: 0 }
  return { x: box.left, y: box.top, width: box.width, height: box.height }
}

function appIdOf(pid: number): ComputerAppId {
  return ComputerAppId(`pid:${pid}`)
}

function handleOf(windowId: ComputerWindowId, refId: number): string {
  return `${refId}@${windowId}`
}

function parseHandle(handle: string): { readonly refId: number; readonly windowId: ComputerWindowId } {
  const at = handle.indexOf('@')
  const refId = Number(handle.slice(0, at))
  if (at <= 0 || !Number.isInteger(refId)) {
    throw new ComputerError(`invalid accessibility handle "${handle}"`, 'COMPUTER_STALE_REF')
  }
  return { refId, windowId: ComputerWindowId(handle.slice(at + 1)) }
}

/** Resolve executable names for process ids; pids the OS no longer knows are absent from the result. */
export type ProcessNameResolver = (pids: readonly number[]) => Promise<ReadonlyMap<number, string>>

/** Run one process-listing command and return its stdout. */
export type ProcessListRunner = (bin: string, args: readonly string[]) => Promise<string>

/** `execFile` promise API subset {@link execProcessList} needs; tests inject a fake. */
export type ProcessExec = (bin: string, args: readonly string[], options: { encoding: 'utf8'; timeout: number }) => Promise<{ stdout: string }>

/**
 * Process-list runner over `child_process.execFile`. A non-zero exit still
 * yields the collected stdout: `ps -p` exits 1 when any listed pid has exited
 * but prints the live ones.
 * @param exec - promisified `execFile`; tests inject a fake.
 * @returns a runner returning the command's stdout.
 */
export function execProcessList(exec: ProcessExec = execFileAsync): ProcessListRunner {
  return async (bin, args) => {
    try {
      return (await exec(bin, args, { encoding: 'utf8', timeout: 10_000 })).stdout
    } catch (error) {
      // execFile rejects with the collected stdout attached to the error.
      return (error as { stdout: string }).stdout
    }
  }
}

/**
 * Build a process-name resolver: `tasklist` CSV on Windows, `ps` elsewhere.
 * @param platform - host OS.
 * @param run - command runner; tests inject canned output.
 * @returns a resolver mapping each live pid to its image name (Windows) or executable path (POSIX).
 */
export function processNamesFor(platform: NodeJS.Platform, run: ProcessListRunner = execProcessList()): ProcessNameResolver {
  return async (pids) => {
    const names = new Map<number, string>()
    if (pids.length === 0) return names
    const stdout = platform === 'win32'
      ? await run('tasklist', ['/fo', 'csv', '/nh', ...pids.flatMap(pid => ['/fi', `PID eq ${pid}`])])
      : await run('ps', ['-p', pids.join(','), '-o', 'pid=,comm='])
    for (const line of stdout.split(/\r?\n/u)) {
      if (platform === 'win32') {
        const cols = line.split('","')
        /* v8 ignore next -- String#split always has index 0. */
        const name = (cols[0] ?? '').replace(/^"/u, '')
        const pid = Number(cols[1]?.replace(/"$/u, ''))
        if (name.length > 0 && Number.isInteger(pid)) names.set(pid, name)
        continue
      }
      const trimmed = line.trim()
      const space = trimmed.indexOf(' ')
      if (space > 0) names.set(Number(trimmed.slice(0, space)), trimmed.slice(space + 1).trim())
    }
    return names
  }
}

/** Process-name resolver for the current OS. */
export const defaultProcessNames: ProcessNameResolver = processNamesFor(process.platform)

/** Options for {@link createSimulangBackend}. */
export interface SimulangBackendOptions {
  /**
   * How long one `Machine.windows()` enumeration serves later window and app
   * reads, in milliseconds. `0` re-enumerates on every call. The seam lists
   * windows and apps before each action, and simulang's enumeration walks
   * every process, so a short cache keeps one action at one walk.
   */
  readonly windowCacheMs?: number
  /** Process-name lookup; defaults to `ps`/`tasklist`. */
  readonly processNames?: ProcessNameResolver
  /** Where forwarded native log lines go; defaults to `process.stderr`. */
  readonly log?: (line: string) => void
  /** Clock for the window cache; tests inject a fake. */
  readonly now?: () => number
}

/**
 * Wrap a loaded simulang module as a DesktopBackend. Installs the simulang
 * logger so native log lines never reach stdout, which carries JSON-RPC.
 * @param module - simulang-js v13 module.
 * @param options - process naming and log sinks for tests.
 * @returns a DesktopBackend.
 */
export function createSimulangBackend(module: SimulangModule, options: SimulangBackendOptions = {}): DesktopBackend {
  const processNames = options.processNames ?? defaultProcessNames
  const log = options.log ?? ((line: string) => { process.stderr.write(`${line}\n`) })
  const now = options.now ?? Date.now
  const windowCacheMs = options.windowCacheMs ?? 0
  module.initLogger?.((record) => { log(`simulang ${record.level} ${record.target}: ${record.message}`) })

  const machine = module.Machine.local()
  const windowsById = new Map<ComputerWindowId, SimulangWindow>()
  const treesByWindow = new Map<ComputerWindowId, { readonly tree: SimulangTree; readonly actions: ReadonlyMap<number, PressAction> }>()
  let enumerated: { readonly at: number; readonly windows: readonly SimulangWindow[] } | undefined

  const enumerateWindows = (fresh: boolean): readonly SimulangWindow[] => {
    if (!fresh && enumerated !== undefined && now() - enumerated.at < windowCacheMs) return enumerated.windows
    const windows = machine.windows()
    enumerated = { at: now(), windows }
    const seen = new Map<string, number>()
    windowsById.clear()
    for (const window of windows) {
      const base = `${window.pid}:${window.title}`
      const count = (seen.get(base) ?? 0) + 1
      seen.set(base, count)
      windowsById.set(ComputerWindowId(count === 1 ? base : `${base}#${count}`), window)
    }
    return windows
  }

  const listWindows = (): ComputerWindow[] => {
    enumerateWindows(false)
    const focused = machine.focusedWindow()
    return [...windowsById.entries()].map(([id, window]) => ({
      id,
      appId: appIdOf(window.pid),
      title: window.title,
      bounds: rect(window.boundingBox()),
      focused: focused !== null && focused.pid === window.pid && focused.title === window.title && !String(id).includes('#'),
    }))
  }

  const requireWindow = (windowId: ComputerWindowId): SimulangWindow => {
    const cached = windowsById.get(windowId)
    if (cached !== undefined) return cached
    enumerateWindows(true)
    const refreshed = windowsById.get(windowId)
    if (refreshed === undefined) throw new ComputerError(`window "${windowId}" is gone`, 'COMPUTER_WINDOW_GONE')
    return refreshed
  }

  const toWindow = (window: SimulangWindow, focused: boolean): ComputerWindow => {
    const id = ComputerWindowId(`${window.pid}:${window.title}`)
    windowsById.set(id, window)
    return { id, appId: appIdOf(window.pid), title: window.title, bounds: rect(window.boundingBox()), focused }
  }

  const toScreenshot = (shot: SimulangScreenshot, bounds: ComputerRect): ComputerScreenshot => {
    const [width, height] = shot.dimensions
    return {
      png: new Uint8Array(Buffer.from(shot.base64(), 'base64')),
      width,
      height,
      scale: bounds.width > 0 ? width / bounds.width : 1,
      bounds,
    }
  }

  const keyCode = (name: string): number => {
    const alias = KEY_ALIASES[name.toLowerCase()] ?? name
    try {
      return module.keyFromString(alias)
    } catch (error) {
      throw new ComputerError(`unknown key "${name}"`, 'COMPUTER_UNSUPPORTED', { cause: error })
    }
  }

  const withModifiers = (modifiers: readonly string[] | undefined, action: () => void): void => {
    const codes = (modifiers ?? []).map((modifier) => {
      const mapped = MODIFIER_KEYS[modifier.toLowerCase()]
      if (mapped === undefined) throw new ComputerError(`unknown modifier "${modifier}"`, 'COMPUTER_UNSUPPORTED')
      return module.keyFromString(mapped)
    })
    for (const code of codes) machine.key(code, module.Direction.Press)
    try {
      action()
    } finally {
      for (const code of [...codes].reverse()) machine.key(code, module.Direction.Release)
    }
  }

  const buttonOf = (button: ComputerClickRequest['button']): number => {
    if (button === 'right') return module.Button.Right
    if (button === 'middle') return module.Button.Middle
    return module.Button.Left
  }

  const mapNode = (node: SimulangNode, windowId: ComputerWindowId, walk: Walk): ComputerSnapshotNode | undefined => {
    if (walk.left <= 0) return undefined
    walk.left -= 1
    const role = module.ariaRoleToString(node.role)
    const secure = role === 'password'
    const pressAction = PRESS_ACTIONS[role]
    if (pressAction !== undefined && node.refId !== null) walk.actions.set(node.refId, pressAction)
    const children: ComputerSnapshotNode[] = []
    for (const child of node.children) {
      const mapped = mapNode(child, windowId, walk)
      if (mapped === undefined) break
      children.push(mapped)
    }
    return {
      handle: node.refId === null ? '' : handleOf(windowId, node.refId),
      role,
      name: node.name,
      ...secure || node.value.length === 0 ? {} : { value: node.value },
      bounds: rect(node.boundingBox),
      states: node.isEnabled ? [] : ['disabled'],
      supportsPress: node.refId !== null && pressAction !== undefined,
      supportsSetValue: node.refId !== null && SET_VALUE_ROLES.has(role),
      secure,
      ...children.length === 0 ? {} : { children },
    }
  }

  const requireTree = (handle: string) => {
    const parsed = parseHandle(handle)
    const entry = treesByWindow.get(parsed.windowId)
    if (entry === undefined) {
      throw new ComputerError(`no snapshot is loaded for window "${parsed.windowId}"`, 'COMPUTER_STALE_REF')
    }
    return { ...entry, refId: parsed.refId }
  }

  return {
    capabilities(): readonly ComputerCapability[] {
      return ['a11y', 'screenshot', 'input', 'clipboard', 'background-actions']
    },

    permissions(): Promise<ComputerPermissions> {
      return settle(() => {
        let accessibility: ComputerPermissionState = 'unknown'
        try {
          enumerateWindows(false)
          accessibility = 'granted'
        } catch {
          // simulang throws when the Accessibility (TCC/AT-SPI) grant is missing.
          accessibility = 'denied'
        }
        const screenRecording: ComputerPermissionState = module.hasScreenCapturePermission === undefined
          ? 'unknown'
          : module.hasScreenCapturePermission() ? 'granted' : 'denied'
        return { accessibility, screenRecording, inputInjection: accessibility }
      })
    },

    async listApps(): Promise<readonly ComputerApp[]> {
      const pids = [...new Set(enumerateWindows(false).map(window => window.pid))]
      const names = await processNames(pids)
      return pids.map((pid) => {
        const path = names.get(pid)
        /* v8 ignore next -- String#split always has a last element. */
        const name = path === undefined ? `pid:${pid}` : path.split(/[/\\]/u).at(-1) ?? path
        return { id: appIdOf(pid), name, pid, ...path === undefined ? {} : { path } }
      })
    },

    listWindows(appId?: ComputerAppId): Promise<readonly ComputerWindow[]> {
      return settle(() => {
        const windows = listWindows()
        return appId === undefined ? windows : windows.filter(window => window.appId === appId)
      })
    },

    launchApp(request: ComputerLaunchRequest): Promise<ComputerApp> {
      return settle(() => {
        const instance = machine.app(request.name).open(null, module.FocusPolicy.Steal, module.Visibility.Show, true)
        const pid = instance.pid ?? 0
        return { id: appIdOf(pid), name: request.name, pid }
      })
    },

    focusWindow(windowId: ComputerWindowId): Promise<void> {
      return settle(() => {
        requireWindow(windowId).focus()
      })
    },

    windowAtPoint(x: number, y: number): Promise<ComputerWindow | undefined> {
      return settle(() => {
        const hit = machine.windowAtPoint(x, y)
        return hit === null ? undefined : toWindow(hit, false)
      })
    },

    snapshot(request: ComputerSnapshotRequest): Promise<ComputerSnapshot> {
      return settle(() => {
        const window = requireWindow(request.windowId)
        const tree = module.AccessibilityTree.fromWindow(window)
        const root = tree.snapshot(false)
        const walk: Walk = { left: request.maxNodes, actions: new Map() }
        const mapped = mapNode(root, request.windowId, walk)
        treesByWindow.set(request.windowId, { tree, actions: walk.actions })
        return {
          windowId: request.windowId,
          appId: appIdOf(window.pid),
          title: window.title,
          nodes: mapped === undefined ? [] : [mapped],
          truncated: walk.left <= 0,
        }
      })
    },

    screenshot(request: ComputerScreenshotRequest): Promise<ComputerScreenshot> {
      return settle(() => {
        if (request.region !== undefined) {
          const { x, y, width, height } = request.region
          return toScreenshot(machine.screenshotCropped(x, y, width, height, true), request.region)
        }
        if (request.windowId !== undefined) {
          const window = requireWindow(request.windowId)
          return toScreenshot(window.screenshot(true), rect(window.boundingBox()))
        }
        const screen = machine.mainScreen()
        return toScreenshot(screen.screenshot(true), rect(screen.boundingBox()))
      })
    },

    press(handle: string): Promise<void> {
      return settle(() => {
        const { tree, actions, refId } = requireTree(handle)
        tree[actions.get(refId) ?? 'activate'](refId)
      })
    },

    setValue(handle: string, text: string): Promise<void> {
      return settle(() => {
        const { tree, refId } = requireTree(handle)
        tree.setValue(refId, text)
      })
    },

    click(request: ComputerClickRequest): Promise<void> {
      return settle(() => {
        machine.moveMouse(request.x, request.y, module.Coordinate.Abs)
        withModifiers(request.modifiers, () => {
          for (let index = 0; index < (request.count ?? 1); index += 1) {
            machine.mouseButton(buttonOf(request.button), module.Direction.Click)
          }
        })
      })
    },

    type(text: string): Promise<void> {
      return settle(() => {
        machine.typeText(text)
      })
    },

    key(request: ComputerKeyRequest): Promise<void> {
      return settle(() => {
        const code = keyCode(request.key)
        withModifiers(request.modifiers, () => {
          for (let index = 0; index < (request.repeat ?? 1); index += 1) {
            machine.key(code, module.Direction.Click)
          }
        })
      })
    },

    scroll(request: ComputerScrollRequest): Promise<void> {
      return settle(() => {
        machine.moveMouse(request.x, request.y, module.Coordinate.Abs)
        const dx = request.direction === 'left' ? -request.amount : request.direction === 'right' ? request.amount : 0
        const dy = request.direction === 'up' ? -request.amount : request.direction === 'down' ? request.amount : 0
        withModifiers(request.modifiers, () => { machine.scroll(dx, dy) })
      })
    },

    move(request: { readonly x: number; readonly y: number }): Promise<void> {
      return settle(() => {
        machine.moveMouse(request.x, request.y, module.Coordinate.Abs)
      })
    },

    drag(request: ComputerDragRequest): Promise<void> {
      return settle(() => {
        machine.moveMouse(request.fromX, request.fromY, module.Coordinate.Abs)
        withModifiers(request.modifiers, () => {
          machine.mouseButton(module.Button.Left, module.Direction.Press)
          try {
            machine.moveMouse(request.toX, request.toY, module.Coordinate.Abs)
          } finally {
            machine.mouseButton(module.Button.Left, module.Direction.Release)
          }
        })
      })
    },

    clipboardRead(): Promise<string> {
      return settle(() => {
        return machine.getClipboardString() ?? ''
      })
    },

    clipboardWrite(text: string): Promise<void> {
      return settle(() => {
        machine.setClipboardString(text)
      })
    },
  }
}
