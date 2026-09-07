import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ComputerRuntime, { ComputerAppId, ComputerError, ComputerWindowId } from '@deepseek-ai/dsh-computer-use'
import {
  ComputerHostClient,
  Config,
  LOCAL_COMPUTER_PROVIDER_ID,
  LocalComputerProvider,
  apply,
  createPlatformBackend,
  createSimulangBackend,
  defaultPlatformIo,
  defaultProcessNames,
  execProcessList,
  doctor,
  formatDoctorReport,
  computerDoctorRemediation,
  handleComputerMethod,
  hostBackendFlags,
  isHostProcessEntry,
  loadSimulang,
  name,
  parseHostBackendFlags,
  processNamesFor,
  resolveHostArgv,
  type ComputerHostProcess,
  type SimulangLogRecord,
  type SimulangMachine,
  type SimulangModule,
  type SimulangNode,
  type SimulangScreenshot,
  type SimulangTree,
  type SimulangWindow,
} from '@deepseek-ai/dsh-computer-use-local'
import { handleHostLine, main, resolveBackend, serveHost, shouldRunHostMain } from '../src/host.ts'
import type { DesktopBackend } from '../src/backend.ts'
import { encodeLine, rpcRequest } from '../src/protocol.ts'

function io(stdout = 'TextEdit') {
  return {
    run: vi.fn(async () => stdout),
    write: vi.fn(async () => undefined),
    capturePng: vi.fn(async () => new Uint8Array([1, 2, 3])),
  }
}

function fakeBackend(overrides: Partial<DesktopBackend> = {}): DesktopBackend {
  const window = {
    id: ComputerWindowId('w1'),
    appId: ComputerAppId('notes'),
    title: 'Notes',
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    focused: true,
  }
  return {
    capabilities: () => ['a11y', 'screenshot'],
    permissions: () => Promise.resolve({ accessibility: 'granted', screenRecording: 'granted', inputInjection: 'granted' }),
    listApps: () => Promise.resolve([{ id: ComputerAppId('notes'), name: 'Notes', pid: 9 }]),
    listWindows: () => Promise.resolve([window]),
    launchApp: request => Promise.resolve({ id: ComputerAppId(request.name), name: request.name, pid: 1 }),
    focusWindow: () => Promise.resolve(),
    windowAtPoint: () => Promise.resolve(window),
    snapshot: request => Promise.resolve({
      windowId: request.windowId,
      appId: ComputerAppId('notes'),
      title: 'Notes',
      truncated: false,
      nodes: [],
    }),
    screenshot: () => Promise.resolve({
      png: new Uint8Array([137, 80]),
      width: 10,
      height: 10,
      scale: 1,
      bounds: { x: 0, y: 0, width: 10, height: 10 },
    }),
    press: () => Promise.resolve(),
    setValue: () => Promise.resolve(),
    click: () => Promise.resolve(),
    type: () => Promise.resolve(),
    key: () => Promise.resolve(),
    scroll: () => Promise.resolve(),
    move: () => Promise.resolve(),
    drag: () => Promise.resolve(),
    clipboardRead: () => Promise.resolve('clip'),
    clipboardWrite: () => Promise.resolve(),
    ...overrides,
  }
}

describe('platform backend', () => {
  it('lists darwin apps and windows and launches, clicks, types, and copies', async () => {
    const runner = io('TextEdit, Finder')
    const backend = createPlatformBackend({ platform: 'darwin', io: runner })
    expect(backend.capabilities()).toEqual(['screenshot', 'clipboard', 'input'])
    expect(await backend.permissions()).toEqual({
      accessibility: 'unknown',
      screenRecording: 'unknown',
      inputInjection: 'unknown',
    })
    const apps = await backend.listApps()
    expect(apps.map(item => item.name)).toEqual(['TextEdit', 'Finder'])
    runner.run.mockResolvedValueOnce('TextEdit')
    runner.run.mockResolvedValueOnce('Untitled')
    const windows = await backend.listWindows()
    expect(windows[0]?.title).toBe('Untitled')
    runner.run.mockRejectedValueOnce(new Error('no windows'))
    expect(await backend.listWindows(ComputerAppId('Ghost'))).toEqual([])
    runner.run.mockResolvedValueOnce('')
    expect((await backend.listWindows(ComputerAppId('Ghost')))[0]?.title).toBe('Ghost')
    await backend.launchApp({ name: 'TextEdit' })
    await backend.focusWindow(ComputerWindowId('TextEdit:0'))
    await backend.click({ x: 10.4, y: 20.6 })
    await backend.type('hi')
    await backend.key({ key: 'Enter' })
    expect(await backend.windowAtPoint(0, 0)).toBeUndefined()
    const shot = await backend.screenshot({})
    expect(shot.png).toEqual(new Uint8Array([1, 2, 3]))
    expect(await backend.clipboardRead()).toBe('TextEdit, Finder')
    await backend.clipboardWrite('x')
    await expect(backend.snapshot({ windowId: ComputerWindowId('x'), maxNodes: 1 })).rejects.toMatchObject({ code: 'COMPUTER_UNSUPPORTED' })
    await expect(backend.press('n')).rejects.toMatchObject({ code: 'COMPUTER_UNSUPPORTED' })
    await expect(backend.setValue('n', 'v')).rejects.toMatchObject({ code: 'COMPUTER_UNSUPPORTED' })
    await expect(backend.scroll({ x: 0, y: 0, direction: 'down', amount: 1 })).rejects.toMatchObject({ code: 'COMPUTER_UNSUPPORTED' })
    await expect(backend.move({ x: 0, y: 0 })).rejects.toMatchObject({ code: 'COMPUTER_UNSUPPORTED' })
    await expect(backend.drag({ fromX: 0, fromY: 0, toX: 1, toY: 1 })).rejects.toMatchObject({ code: 'COMPUTER_UNSUPPORTED' })
  })

  it('covers windows, linux X11, linux Wayland, and empty darwin lists', async () => {
    const win = createPlatformBackend({ platform: 'win32', io: io('"notepad.exe","42"') })
    expect(win.capabilities()).toEqual(['screenshot', 'clipboard'])
    expect(await win.permissions()).toMatchObject({ accessibility: 'not-required' })
    expect((await win.listApps())[0]?.name).toBe('notepad.exe')
    expect(await win.listWindows()).toEqual([])
    await win.launchApp({ name: 'notepad' })
    expect(await win.clipboardRead()).toBe('"notepad.exe","42"')
    await win.clipboardWrite('x')
    await expect(win.focusWindow(ComputerWindowId('x'))).rejects.toMatchObject({ code: 'COMPUTER_UNSUPPORTED' })
    await expect(win.screenshot({})).rejects.toMatchObject({ code: 'COMPUTER_UNSUPPORTED' })
    await expect(win.click({ x: 0, y: 0 })).rejects.toMatchObject({ code: 'COMPUTER_UNSUPPORTED' })
    await expect(win.type('x')).rejects.toMatchObject({ code: 'COMPUTER_UNSUPPORTED' })
    await expect(win.key({ key: 'a' })).rejects.toMatchObject({ code: 'COMPUTER_UNSUPPORTED' })

    const linux = createPlatformBackend({ platform: 'linux', wayland: false, io: io('PID COMMAND\n 1 systemd') })
    expect((await linux.listApps())[0]?.name).toBe('systemd')
    await linux.launchApp({ name: 'gedit' })
    const shot = await linux.screenshot({ region: { x: 1, y: 2, width: 3, height: 4 } })
    expect(shot.bounds).toEqual({ x: 1, y: 2, width: 3, height: 4 })
    expect(await linux.clipboardRead()).toBe('PID COMMAND\n 1 systemd')
    await linux.clipboardWrite('x')
    expect((await linux.permissions()).inputInjection).toBe('unknown')

    const wayland = createPlatformBackend({ platform: 'linux', wayland: true, io: io('') })
    expect((await wayland.permissions()).inputInjection).toBe('denied')
    await wayland.screenshot({})

    const empty = createPlatformBackend({ platform: 'darwin', io: io('') })
    expect(await empty.listApps()).toEqual([])

    const winFallback = createPlatformBackend({ platform: 'win32', io: io('notepad.exe\n"app","abc"\n,') })
    const winApps = await winFallback.listApps()
    expect(winApps.some(item => item.name === 'notepad.exe')).toBe(true)
    expect(winApps.some(item => item.name === 'app')).toBe(true)

    const defaults = createPlatformBackend()
    expect(defaults.capabilities().length).toBeGreaterThan(0)
  })

  it('maps default I/O failures and empty argv', async () => {
    await expect(defaultPlatformIo.run([])).rejects.toMatchObject({ code: 'COMPUTER_UNSUPPORTED' })
    await expect(defaultPlatformIo.write([], 'x')).rejects.toMatchObject({ code: 'COMPUTER_UNSUPPORTED' })
    await expect(defaultPlatformIo.run(['dsh-computer-missing-bin'])).rejects.toMatchObject({ code: 'COMPUTER_UNSUPPORTED' })
    await expect(defaultPlatformIo.write(['dsh-computer-missing-bin'], 'x')).rejects.toMatchObject({ code: 'COMPUTER_UNSUPPORTED' })
    await expect(defaultPlatformIo.capturePng(['dsh-computer-missing-bin'])).rejects.toMatchObject({ code: 'COMPUTER_UNSUPPORTED' })
    expect(await defaultPlatformIo.run(['node', '-e', 'process.stdout.write("ok")'])).toBe('ok')
    await defaultPlatformIo.write(['node', '-e', 'process.exit(0)'], 'x')
    await expect(defaultPlatformIo.write(['node', '-e', 'process.exit(2)'], 'x')).rejects.toMatchObject({ code: 'COMPUTER_UNSUPPORTED' })
    const png = await defaultPlatformIo.capturePng([
      'node',
      '-e',
      'require("node:fs").writeFileSync(process.argv[process.argv.length - 1], "png")',
    ])
    expect(png).toEqual(new Uint8Array(Buffer.from('png')))
  })
})

interface FakeNodeSpec {
  role: number
  name?: string
  value?: string
  enabled?: boolean
  box?: { left: number; top: number; width: number; height: number } | null
  refId?: number | null
  children?: FakeNodeSpec[]
}

/** Role numbers the fake `ariaRoleToString` understands. */
const ROLES = ['window', 'button', 'textbox', 'password', 'checkbox', 'tab', 'combobox', 'text', 'img'] as const

function fakeNode(spec: FakeNodeSpec): SimulangNode {
  return {
    role: spec.role,
    name: spec.name ?? '',
    value: spec.value ?? '',
    isEnabled: spec.enabled ?? true,
    boundingBox: spec.box === undefined ? { left: 0, top: 0, width: 10, height: 10 } : spec.box,
    refId: spec.refId === undefined ? null : spec.refId,
    children: (spec.children ?? []).map(fakeNode),
  }
}

interface FakeWindowSpec {
  pid: number
  title: string
}

function fakeSimulang(options: {
  windows?: FakeWindowSpec[]
  focused?: FakeWindowSpec | null
  tree?: FakeNodeSpec
  screenCapture?: boolean
  windowsThrow?: boolean
  withLogger?: boolean
} = {}) {
  const calls: string[] = []
  const shot = (width: number, height: number): SimulangScreenshot => ({
    dimensions: [width, height],
    base64: () => Buffer.from([137, 80, width, height]).toString('base64'),
  })
  const makeWindow = (spec: FakeWindowSpec): SimulangWindow => ({
    pid: spec.pid,
    title: spec.title,
    boundingBox: () => ({ left: 5, top: 6, width: 300, height: 200 }),
    focus: () => { calls.push(`focus ${spec.pid}:${spec.title}`); return true },
    screenshot: () => shot(300, 200),
  })
  let windows = (options.windows ?? [{ pid: 7, title: 'Notes' }]).map(makeWindow)
  const tree: SimulangTree = {
    snapshot: () => fakeNode(options.tree ?? { role: 0, name: 'Notes', refId: 0 }),
    activate: (refId) => { calls.push(`activate ${refId}`) },
    setValue: (refId, value) => { calls.push(`setValue ${refId} ${value}`) },
    toggle: (refId) => { calls.push(`toggle ${refId}`) },
    select: (refId) => { calls.push(`select ${refId}`) },
    expandCollapse: (refId) => { calls.push(`expandCollapse ${refId}`) },
  }
  let enumerations = 0
  const machine: SimulangMachine = {
    app: name => ({ open: () => { calls.push(`open ${name}`); return { pid: name === 'Ghost' ? null : 42 } } }),
    windows: () => {
      enumerations += 1
      if (options.windowsThrow === true) throw new Error('AX denied')
      return windows
    },
    focusedWindow: () => options.focused === undefined ? windows[0] ?? null : options.focused === null ? null : makeWindow(options.focused),
    windowAtPoint: (x, y) => x < 0 ? null : makeWindow({ pid: 7, title: `at ${x},${y}` }),
    mainScreen: () => ({ screenshot: () => shot(1920, 1080), boundingBox: () => ({ left: 0, top: 0, width: 960, height: 540 }) }),
    screenshotCropped: (x, y, width, height) => { calls.push(`crop ${x},${y} ${width}x${height}`); return shot(width, height) },
    mouseButton: (button, direction) => { calls.push(`button ${button} ${direction}`) },
    moveMouse: (x, y, coordinate) => { calls.push(`move ${x},${y} ${coordinate}`) },
    scroll: (dx, dy) => { calls.push(`scroll ${dx},${dy}`) },
    typeText: (text) => { calls.push(`type ${text}`) },
    key: (key, direction) => { calls.push(`key ${key} ${direction}`) },
    getClipboardString: () => calls.includes('clip set') ? 'pasted' : null,
    setClipboardString: (value) => { calls.push('clip set'); calls.push(`clip ${value}`); return {} },
  }
  const logs: string[] = []
  const module: SimulangModule = {
    Machine: { local: () => machine },
    AccessibilityTree: { fromWindow: (window) => { calls.push(`tree ${window.pid}:${window.title}`); return tree } },
    Button: { Left: 0, Middle: 1, Right: 2 },
    Direction: { Press: 0, Release: 1, Click: 2 },
    Coordinate: { Abs: 0 },
    FocusPolicy: { Steal: 1 },
    Visibility: { Show: 1 },
    ariaRoleToString: role => ROLES[role] ?? 'unknown',
    keyFromString: (value) => {
      const table: Record<string, number> = { Enter: 262, Down: 80, Space: 276, Meta: 186, Control: 60, Alt: 40, Shift: 273, a: 10 }
      const code = table[value]
      if (code === undefined) throw new Error(`Unknown key string: ${value}`)
      return code
    },
    ...options.screenCapture === undefined ? {} : { hasScreenCapturePermission: () => options.screenCapture === true },
    ...options.withLogger === true ? { initLogger: (callback: (record: SimulangLogRecord) => void) => { callback({ level: 'info', target: 'simulang_rs::clip', message: 'copied' }); logs.push('installed') } } : {},
  }
  return {
    module,
    calls,
    logs,
    enumerations: () => enumerations,
    setWindows: (specs: FakeWindowSpec[]) => { windows = specs.map(makeWindow) },
  }
}

describe('simulang adapter', () => {
  it('accepts only modules exposing the v13 class API', async () => {
    const real = await loadSimulang()
    expect(real === undefined || typeof real.Machine.local === 'function').toBe(true)
    const fake = fakeSimulang().module
    expect(await loadSimulang(async () => ({ default: fake }))).toBe(fake)
    expect(await loadSimulang(async () => fake)).toBe(fake)
    expect(await loadSimulang(async () => ({ default: { listWindows: async () => [] } }))).toBeUndefined()
    expect(await loadSimulang(async () => ({ listWindows: async () => [] }))).toBeUndefined()
    expect(await loadSimulang(async () => null)).toBeUndefined()
    await expect(loadSimulang(async () => { throw new Error('missing') })).resolves.toBeUndefined()
  })

  it('reports permissions from the enumeration probe and the capture flag', async () => {
    const granted = createSimulangBackend(fakeSimulang({ screenCapture: true }).module)
    expect(granted.capabilities()).toEqual(['a11y', 'screenshot', 'input', 'clipboard', 'background-actions'])
    expect(await granted.permissions()).toEqual({ accessibility: 'granted', screenRecording: 'granted', inputInjection: 'granted' })
    const denied = createSimulangBackend(fakeSimulang({ screenCapture: false, windowsThrow: true }).module)
    expect(await denied.permissions()).toEqual({ accessibility: 'denied', screenRecording: 'denied', inputInjection: 'denied' })
    const unknown = createSimulangBackend(fakeSimulang().module)
    expect((await unknown.permissions()).screenRecording).toBe('unknown')
  })

  it('mints window and app ids from pids and titles and names apps through the resolver', async () => {
    const fake = fakeSimulang({ windows: [{ pid: 7, title: 'Notes' }, { pid: 7, title: 'Notes' }, { pid: 9, title: 'Editor' }] })
    const processNames = vi.fn(async (pids: readonly number[]) => new Map(pids.filter(pid => pid === 7).map(pid => [pid, '/Applications/Notes.app/Contents/MacOS/Notes'] as const)))
    const backend = createSimulangBackend(fake.module, { processNames })
    const windows = await backend.listWindows()
    expect(windows.map(window => String(window.id))).toEqual(['7:Notes', '7:Notes#2', '9:Editor'])
    expect(windows[0]).toMatchObject({ appId: 'pid:7', focused: true, bounds: { x: 5, y: 6, width: 300, height: 200 } })
    expect(windows[1]?.focused).toBe(false)
    expect(await backend.listWindows(ComputerAppId('pid:9'))).toHaveLength(1)
    const apps = await backend.listApps()
    expect(apps).toEqual([
      { id: 'pid:7', name: 'Notes', pid: 7, path: '/Applications/Notes.app/Contents/MacOS/Notes' },
      { id: 'pid:9', name: 'pid:9', pid: 9 },
    ])
    expect(processNames).toHaveBeenCalledWith([7, 9])
    const launched = await backend.launchApp({ name: 'TextEdit' })
    expect(launched).toEqual({ id: 'pid:42', name: 'TextEdit', pid: 42 })
    expect((await backend.launchApp({ name: 'Ghost' })).pid).toBe(0)
    await backend.focusWindow(ComputerWindowId('9:Editor'))
    expect(fake.calls).toContain('focus 9:Editor')
    expect(await backend.windowAtPoint(-1, 0)).toBeUndefined()
    expect(await backend.windowAtPoint(3, 4)).toMatchObject({ id: '7:at 3,4', appId: 'pid:7', focused: false })
  })

  it('reuses one window enumeration within windowCacheMs and refreshes on a miss', async () => {
    let clock = 0
    const fake = fakeSimulang()
    const backend = createSimulangBackend(fake.module, { windowCacheMs: 1000, now: () => clock, processNames: async () => new Map() })
    await backend.listWindows()
    await backend.listApps()
    expect(fake.enumerations()).toBe(1)
    clock = 1000
    await backend.listWindows()
    expect(fake.enumerations()).toBe(2)
    fake.setWindows([{ pid: 7, title: 'Notes' }, { pid: 8, title: 'Late' }])
    await backend.focusWindow(ComputerWindowId('8:Late'))
    expect(fake.enumerations()).toBe(3)
    await expect(backend.focusWindow(ComputerWindowId('8:Gone'))).rejects.toMatchObject({ code: 'COMPUTER_WINDOW_GONE' })
    const uncached = createSimulangBackend(fakeSimulang().module, { processNames: async () => new Map() })
    await uncached.listWindows()
    await uncached.listWindows()
  })

  it('maps the accessibility tree with role-derived actions, secure values, and a node budget', async () => {
    const fake = fakeSimulang({
      tree: {
        role: 0, name: 'Notes', refId: 0, children: [
          { role: 1, name: 'OK', refId: 1 },
          { role: 2, name: 'Name', value: 'Ada', refId: 2, box: null },
          { role: 3, name: 'Secret', value: 'hunter2', refId: 3 },
          { role: 4, name: 'Bold', refId: 4, enabled: false },
          { role: 5, name: 'Tab', refId: 5 },
          { role: 6, name: 'Pick', refId: 6 },
          { role: 7, name: 'label', refId: null },
          { role: 8, name: 'Logo', refId: 8 },
        ],
      },
    })
    const backend = createSimulangBackend(fake.module)
    const windowId = ComputerWindowId('7:Notes')
    const snap = await backend.snapshot({ windowId, maxNodes: 50 })
    expect(snap).toMatchObject({ windowId, appId: 'pid:7', title: 'Notes', truncated: false })
    const root = snap.nodes[0]!
    expect(root).toMatchObject({ handle: '0@7:Notes', role: 'window', supportsPress: false, supportsSetValue: false })
    const [ok, name, secret, bold, tab, pick, label, logo] = root.children!
    expect(ok).toMatchObject({ role: 'button', supportsPress: true, supportsSetValue: false, states: [] })
    expect(name).toMatchObject({ role: 'textbox', value: 'Ada', supportsSetValue: true, bounds: { x: 0, y: 0, width: 0, height: 0 } })
    expect(secret).toMatchObject({ role: 'password', secure: true, supportsSetValue: true })
    expect(secret?.value).toBeUndefined()
    expect(bold).toMatchObject({ role: 'checkbox', states: ['disabled'], supportsPress: true })
    expect(label).toMatchObject({ handle: '', supportsPress: false, supportsSetValue: false })
    expect(logo?.supportsPress).toBe(true)
    await backend.press(ok!.handle)
    await backend.press(bold!.handle)
    await backend.press(tab!.handle)
    await backend.press(pick!.handle)
    await backend.press(root.handle)
    await backend.setValue(name!.handle, 'Grace')
    expect(fake.calls).toEqual(expect.arrayContaining(['tree 7:Notes', 'activate 1', 'toggle 4', 'select 5', 'expandCollapse 6', 'activate 0', 'setValue 2 Grace']))
    const capped = await backend.snapshot({ windowId, maxNodes: 3 })
    expect(capped.truncated).toBe(true)
    expect(capped.nodes[0]?.children).toHaveLength(2)
    expect((await backend.snapshot({ windowId, maxNodes: 0 })).nodes).toEqual([])
    await expect(backend.press('1@7:Other')).rejects.toMatchObject({ code: 'COMPUTER_STALE_REF' })
    await expect(backend.press('nope')).rejects.toMatchObject({ code: 'COMPUTER_STALE_REF' })
    await expect(backend.press('@7:Notes')).rejects.toMatchObject({ code: 'COMPUTER_STALE_REF' })
    await expect(backend.snapshot({ windowId: ComputerWindowId('1:Gone'), maxNodes: 1 })).rejects.toMatchObject({ code: 'COMPUTER_WINDOW_GONE' })
  })

  it('captures screenshots for regions, windows, and the main screen with a derived scale', async () => {
    const backend = createSimulangBackend(fakeSimulang().module)
    const region = await backend.screenshot({ region: { x: 1, y: 2, width: 30, height: 20 } })
    expect(region).toMatchObject({ width: 30, height: 20, scale: 1, bounds: { x: 1, y: 2, width: 30, height: 20 } })
    expect(region.png).toEqual(new Uint8Array([137, 80, 30, 20]))
    const window = await backend.screenshot({ windowId: ComputerWindowId('7:Notes') })
    expect(window).toMatchObject({ width: 300, height: 200, scale: 1, bounds: { x: 5, y: 6, width: 300, height: 200 } })
    const screen = await backend.screenshot({})
    expect(screen).toMatchObject({ width: 1920, height: 1080, scale: 2, bounds: { x: 0, y: 0, width: 960, height: 540 } })
    const zero = await backend.screenshot({ region: { x: 0, y: 0, width: 0, height: 0 } })
    expect(zero.scale).toBe(1)
  })

  it('synthesizes pointer, keyboard, and clipboard input with modifiers held around the action', async () => {
    const fake = fakeSimulang()
    const backend = createSimulangBackend(fake.module)
    await backend.click({ x: 10, y: 20 })
    await backend.click({ x: 1, y: 2, button: 'right', count: 2, modifiers: ['shift'] })
    await backend.click({ x: 1, y: 2, button: 'middle' })
    await backend.type('hi')
    await backend.key({ key: 'Enter' })
    await backend.key({ key: 'ArrowDown', repeat: 2 })
    await backend.key({ key: ' ' })
    await backend.key({ key: 'a', modifiers: ['meta', 'ctrl', 'alt'] })
    await backend.scroll({ x: 5, y: 6, direction: 'down', amount: 3 })
    await backend.scroll({ x: 5, y: 6, direction: 'up', amount: 1 })
    await backend.scroll({ x: 5, y: 6, direction: 'left', amount: 2 })
    await backend.scroll({ x: 5, y: 6, direction: 'right', amount: 4 })
    await backend.move({ x: 9, y: 9 })
    await backend.drag({ fromX: 0, fromY: 0, toX: 8, toY: 8 })
    expect(await backend.clipboardRead()).toBe('')
    await backend.clipboardWrite('z')
    expect(await backend.clipboardRead()).toBe('pasted')
    expect(fake.calls).toEqual([
      'move 10,20 0', 'button 0 2',
      'move 1,2 0', 'key 273 0', 'button 2 2', 'button 2 2', 'key 273 1',
      'move 1,2 0', 'button 1 2',
      'type hi',
      'key 262 2',
      'key 80 2', 'key 80 2',
      'key 276 2',
      'key 186 0', 'key 60 0', 'key 40 0', 'key 10 2', 'key 40 1', 'key 60 1', 'key 186 1',
      'move 5,6 0', 'scroll 0,3',
      'move 5,6 0', 'scroll 0,-1',
      'move 5,6 0', 'scroll -2,0',
      'move 5,6 0', 'scroll 4,0',
      'move 9,9 0',
      'move 0,0 0', 'button 0 0', 'move 8,8 0', 'button 0 1',
      'clip set', 'clip z',
    ])
    await expect(backend.key({ key: 'Hyper' })).rejects.toMatchObject({ code: 'COMPUTER_UNSUPPORTED' })
    await expect(backend.key({ key: 'a', modifiers: ['fn'] })).rejects.toMatchObject({ code: 'COMPUTER_UNSUPPORTED' })
  })

  it('routes native log lines through the injected sink instead of stdout', () => {
    const lines: string[] = []
    const fake = fakeSimulang({ withLogger: true })
    createSimulangBackend(fake.module, { log: (line) => { lines.push(line) } })
    expect(fake.logs).toEqual(['installed'])
    expect(lines).toEqual(['simulang info simulang_rs::clip: copied'])
    const written: string[] = []
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { written.push(String(chunk)); return true })
    try {
      createSimulangBackend(fake.module)
    } finally {
      spy.mockRestore()
    }
    expect(written).toEqual(['simulang info simulang_rs::clip: copied\n'])
  })

  it('names processes through ps or tasklist and tolerates a missing pid', async () => {
    expect(await defaultProcessNames([])).toEqual(new Map())
    const exited = spawnSync(process.execPath, ['-e', '0']).pid
    const live = await defaultProcessNames([process.pid, exited])
    expect(live.get(process.pid)).toMatch(/node/iu)
    expect(live.has(exited)).toBe(false)
    const posix = processNamesFor('darwin', async (bin, args) => {
      expect(bin).toBe('ps')
      expect(args).toEqual(['-p', '7,9', '-o', 'pid=,comm='])
      return '  7 /Applications/Notes.app/Contents/MacOS/Notes\n\n9\n'
    })
    expect(await posix([7, 9])).toEqual(new Map([[7, '/Applications/Notes.app/Contents/MacOS/Notes']]))
    const windows = processNamesFor('win32', async (bin, args) => {
      expect(bin).toBe('tasklist')
      expect(args).toEqual(['/fo', 'csv', '/nh', '/fi', 'PID eq 7', '/fi', 'PID eq 9'])
      return '"notepad.exe","7","Console","1","10 K"\r\nINFO: No tasks are running.\r\n\r\n'
    })
    expect(await windows([7, 9])).toEqual(new Map([[7, 'notepad.exe']]))
    const partial = execProcessList(async () => {
      throw Object.assign(new Error('ps exited 1'), { stdout: '7 /usr/bin/gedit\n' })
    })
    expect(await processNamesFor('linux', partial)([7, 8])).toEqual(new Map([[7, '/usr/bin/gedit']]))
    const ok = execProcessList(async () => ({ stdout: '' }))
    expect(await processNamesFor('linux', ok)([7])).toEqual(new Map())
  })
})

describe('JSON-RPC dispatch', () => {
  it('routes every helper method and encodes screenshots as base64', async () => {
    const backend = fakeBackend()
    expect(await handleComputerMethod(backend, 'capabilities', undefined)).toEqual(['a11y', 'screenshot'])
    expect(await handleComputerMethod(backend, 'permissions', null)).toMatchObject({ accessibility: 'granted' })
    expect(await handleComputerMethod(backend, 'listApps', {})).toHaveLength(1)
    expect(await handleComputerMethod(backend, 'listWindows', { appId: 'notes' })).toHaveLength(1)
    expect(await handleComputerMethod(backend, 'launchApp', { name: 'Notes' })).toMatchObject({ name: 'Notes' })
    expect(await handleComputerMethod(backend, 'focusWindow', { windowId: 'w1' })).toBeNull()
    expect(await handleComputerMethod(backend, 'windowAtPoint', { x: 1, y: 2 })).toMatchObject({ id: 'w1' })
    expect(await handleComputerMethod(backend, 'snapshot', { windowId: 'w1', query: 'button' })).toMatchObject({ title: 'Notes' })
    const shot = await handleComputerMethod(backend, 'screenshot', {
      windowId: 'w1',
      displayId: 1,
      region: { x: 0, y: 0, width: 1, height: 1 },
    }) as { pngBase64: string }
    expect(Buffer.from(shot.pngBase64, 'base64')[0]).toBe(137)
    expect(await handleComputerMethod(backend, 'press', { handle: 'n' })).toBeNull()
    expect(await handleComputerMethod(backend, 'setValue', { handle: 'n', text: 'v' })).toBeNull()
    expect(await handleComputerMethod(backend, 'click', { x: 1, y: 2, button: 'right', count: 2 })).toBeNull()
    expect(await handleComputerMethod(backend, 'type', { text: 'hi' })).toBeNull()
    expect(await handleComputerMethod(backend, 'key', { key: 'a', modifiers: ['shift'], repeat: 2 })).toBeNull()
    expect(await handleComputerMethod(backend, 'scroll', { x: 0, y: 0, direction: 'up', amount: 2 })).toBeNull()
    expect(await handleComputerMethod(backend, 'move', { x: 3, y: 4 })).toBeNull()
    expect(await handleComputerMethod(backend, 'drag', { fromX: 0, fromY: 0, toX: 1, toY: 1 })).toBeNull()
    expect(await handleComputerMethod(backend, 'clipboardRead', undefined)).toBe('clip')
    expect(await handleComputerMethod(backend, 'clipboardWrite', { text: 'z' })).toBeNull()
    await expect(handleComputerMethod(backend, 'nope', {})).rejects.toMatchObject({ code: 'COMPUTER_UNSUPPORTED' })
    const throwing = fakeBackend({
      press: async () => {
        throw new Error('native')
      },
      type: async () => {
        throw 'bare'
      },
    })
    const native = JSON.parse(await handleHostLine(throwing, rpcRequest(8, 'press', { handle: 'n' }))) as { error: { code: string } }
    expect(native.error.code).toBe('COMPUTER_UNSUPPORTED')
    const bare = JSON.parse(await handleHostLine(throwing, rpcRequest(9, 'type', { text: 'x' }))) as { error: { message: string } }
    expect(bare.error.message).toBe('bare')
  })

  it('defaults click/scroll/key fields and returns null for a missed window', async () => {
    const backend = fakeBackend({ windowAtPoint: async () => undefined })
    expect(await handleComputerMethod(backend, 'windowAtPoint', {})).toBeNull()
    await handleComputerMethod(backend, 'click', {})
    await handleComputerMethod(backend, 'click', 1)
    await handleComputerMethod(backend, 'scroll', {})
    await handleComputerMethod(backend, 'key', {})
    await handleComputerMethod(backend, 'click', { button: 'middle', count: 2 })
    expect(await handleComputerMethod(backend, 'listWindows', {})).toHaveLength(1)
    const shot = await handleComputerMethod(backend, 'screenshot', {}) as { pngBase64: string }
    expect(typeof shot.pngBase64).toBe('string')
    expect(await handleComputerMethod(backend, 'snapshot', { windowId: 'w1', maxNodes: 3 })).toMatchObject({ title: 'Notes' })
  })
})

describe('host loop', () => {
  it('answers valid requests and rejects invalid or mismatched envelopes', async () => {
    const backend = fakeBackend()
    const ok = JSON.parse(await handleHostLine(backend, rpcRequest(4, 'capabilities'))) as { result: unknown }
    expect(ok.result).toEqual(['a11y', 'screenshot'])
    const invalid = JSON.parse(await handleHostLine(backend, { nope: true })) as { error: { message: string } }
    expect(invalid.error.message).toMatch(/invalid/)
    const mismatch = JSON.parse(await handleHostLine(backend, { ...rpcRequest(5, 'capabilities'), protocolVersion: 9 })) as { error: { message: string } }
    expect(mismatch.error.message).toMatch(/version/)
    const failed = JSON.parse(await handleHostLine(backend, rpcRequest(6, 'nope'))) as { error: { code: string } }
    expect(failed.error.code).toBe('COMPUTER_UNSUPPORTED')
  })

  it('serves newline-delimited requests until stdin closes', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    output.setEncoding('utf8')
    const chunks: string[] = []
    output.on('data', (chunk: string) => { chunks.push(chunk) })
    const serving = serveHost(fakeBackend(), input, output)
    input.write(encodeLine(rpcRequest(1, 'clipboardRead')))
    input.end()
    await serving
    expect(chunks.join('')).toContain('"clip"')
  })

  it('main writes thrown errors to stderr and shouldRunHostMain detects the helper entry', async () => {
    const { Readable } = await import('node:stream')
    const stderr = new PassThrough()
    stderr.setEncoding('utf8')
    let err = ''
    stderr.on('data', (chunk: string) => { err += chunk })
    const boom = Readable.from((async function* () {
      throw new ComputerError('boom', 'COMPUTER_HOST_CRASHED')
    })())
    await main({ backend: fakeBackend(), input: boom, output: new PassThrough(), stderr })
    expect(err).toMatch(/boom/)
    err = ''
    const plain = Readable.from((async function* () {
      throw new Error('plain')
    })())
    await main({ backend: fakeBackend(), input: plain, output: new PassThrough(), stderr })
    expect(err).toMatch(/plain/)
    expect(shouldRunHostMain('lib/host.js')).toBe(true)
    expect(shouldRunHostMain('src/host.ts')).toBe(true)
    expect(shouldRunHostMain('index.ts')).toBe(false)
  })

  it('main writes a non-Error throw when serveHost fails', async () => {
    const stderr = new PassThrough()
    stderr.setEncoding('utf8')
    let err = ''
    stderr.on('data', (chunk: string) => { err += chunk })
    const { Readable } = await import('node:stream')
    const boom = Readable.from((async function* () {
      throw 'bare-main'
    })())
    await main({ backend: fakeBackend(), input: boom, output: new PassThrough(), stderr })
    expect(err).toMatch(/bare-main/)
  })

  it('resolveBackend picks simulang when loaded, else the platform backend, and main parses argv flags', async () => {
    const fallback = await resolveBackend(async () => undefined)
    expect(fallback.capabilities()).not.toContain('a11y')
    const fake = fakeSimulang()
    const native = await resolveBackend(async () => fake.module, { windowCacheMs: 500 })
    expect(native.capabilities()).toContain('a11y')
    await native.listWindows()
    await native.listWindows()
    expect(fake.enumerations()).toBe(1)
    expect(hostBackendFlags(2_000)).toEqual(['--window-cache-ms=2000'])
    expect(parseHostBackendFlags(['node', 'host.js', '--window-cache-ms=2000'])).toEqual({ windowCacheMs: 2000 })
    expect(parseHostBackendFlags(['node', 'host.js'])).toEqual({})
    expect(() => parseHostBackendFlags(['--window-cache-ms=-1'])).toThrow(ComputerError)
    expect(() => parseHostBackendFlags(['--window-cache-ms=soon'])).toThrow(/invalid helper flag/)
    const input = new PassThrough()
    const stderr = new PassThrough()
    input.end()
    await main({ input, output: new PassThrough(), stderr, argv: ['node', 'host.js', '--window-cache-ms=0'] })
    const bare = new PassThrough()
    bare.end()
    await main({ input: bare, output: new PassThrough(), stderr })
    let err = ''
    stderr.on('data', (chunk: string) => { err += chunk })
    await main({ input: new PassThrough(), output: new PassThrough(), stderr, argv: ['node', 'host.js', '--window-cache-ms=x'] })
    expect(err).toMatch(/invalid helper flag/)
  })

  it('sets process.exitCode when main fails without an injected stderr', async () => {
    const previous = process.exitCode
    const { Readable } = await import('node:stream')
    const boom = Readable.from((async function* () {
      throw new Error('no-stderr')
    })())
    await main({ backend: fakeBackend(), input: boom, output: new PassThrough() })
    expect(process.exitCode).toBe(1)
    process.exitCode = previous
  })
})

function fakeProcess(handler: (method: string, params: unknown, id: number) => unknown, options?: {
  readonly silent?: boolean
}): ComputerHostProcess & {
  stdin: PassThrough
  stdout: PassThrough
  fail(): void
} {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  stdin.setEncoding('utf8')
  let pending = ''
  stdin.on('data', (chunk: string) => {
    if (options?.silent === true) return
    const combined = pending + chunk
    const parts = combined.split('\n')
    pending = parts.pop() ?? ''
    for (const part of parts) {
      if (part.length === 0) continue
      const request = JSON.parse(part) as { id: number; method: string; params?: unknown }
      const result = handler(request.method, request.params, request.id)
      if (!stdout.writableEnded) stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`)
    }
  })
  let settle!: (value: { exitCode: number | null; signal: NodeJS.Signals | null }) => void
  const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    settle = resolve
  })
  return {
    pid: 1,
    stdin,
    stdout,
    terminate: () => { settle({ exitCode: 0, signal: null }) },
    waitForExit: async () => true,
    done,
    fail() {
      settle({ exitCode: 1, signal: null })
      stdout.end()
    },
  }
}

describe('host client', () => {
  it('round-trips RPC and maps helper errors', async () => {
    const current = fakeProcess(() => 'ok')
    const client = new ComputerHostClient({
      requestTimeoutMs: 50,
      spawn: () => current,
      argv: ['node', 'host.js'],
    })
    expect(await client.call('clipboardRead')).toBe('ok')
    await client.dispose()
    const failing = fakeProcess((_method, _params, id) => {
      failing.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code: 'COMPUTER_UNSUPPORTED', message: 'nope' } })}\n`)
      return undefined
    })
    const errorClient = new ComputerHostClient({ spawn: () => failing, argv: ['node', 'host.js'] })
    await expect(errorClient.call('press', { handle: 'n' })).rejects.toMatchObject({ code: 'COMPUTER_UNSUPPORTED' })
    await errorClient.dispose()
  })

  it('times out a silent helper', async () => {
    const timeoutClient = new ComputerHostClient({
      requestTimeoutMs: 20,
      spawn: () => fakeProcess(() => undefined, { silent: true }),
      argv: ['node', 'host.js'],
    })
    await expect(timeoutClient.call('listApps')).rejects.toMatchObject({ code: 'COMPUTER_UNSUPPORTED' })
    await timeoutClient.dispose()
  })

  it('rejects in-flight calls when the helper exits', async () => {
    const crashed = fakeProcess(() => 'x', { silent: true })
    const crashClient = new ComputerHostClient({ spawn: () => crashed, argv: ['node', 'host.js'] })
    const pending = crashClient.call('listApps')
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    crashed.fail()
    await expect(pending).rejects.toMatchObject({ code: 'COMPUTER_HOST_CRASHED' })
  })

  it('rejects abort, missing pipes, and a missing helper entry', async () => {
    const proc = fakeProcess(() => 'ok')
    const client = new ComputerHostClient({ spawn: () => proc, argv: ['node', 'host.js'] })
    const signal = AbortSignal.abort(new Error('stop'))
    await expect(client.call('listApps', undefined, signal)).rejects.toThrow('stop')
    await client.dispose()

    const noIn = fakeProcess(() => 'ok')
    Object.defineProperty(noIn, 'stdin', { value: undefined })
    const missingIn = new ComputerHostClient({ spawn: () => noIn, argv: ['node', 'host.js'] })
    await expect(missingIn.call('listApps')).rejects.toMatchObject({ code: 'COMPUTER_HOST_CRASHED' })

    const noOut = fakeProcess(() => 'ok')
    Object.defineProperty(noOut, 'stdout', { value: undefined })
    const missingOut = new ComputerHostClient({ spawn: () => noOut, argv: ['node', 'host.js'] })
    await expect(missingOut.call('listApps')).rejects.toMatchObject({ code: 'COMPUTER_HOST_CRASHED' })

    expect(isHostProcessEntry('lib/host.js')).toBe(true)
    expect(isHostProcessEntry('src/host.ts')).toBe(true)
    expect(isHostProcessEntry('index.ts')).toBe(false)
    const sourceClient = pathToFileURL(join(fileURLToPath(new URL('../src/client.ts', import.meta.url)))).href
    expect(resolveHostArgv(sourceClient).length).toBeGreaterThan(1)
    const missingDir = await mkdtemp(join(tmpdir(), 'dsh-computer-host-missing-'))
    expect(() => resolveHostArgv(pathToFileURL(join(missingDir, 'client.js')).href)).toThrow(/missing/)
    await rm(missingDir, { recursive: true, force: true })
    const bundledDir = await mkdtemp(join(tmpdir(), 'dsh-computer-host-bundled-'))
    await writeFile(join(bundledDir, 'host.js'), '')
    expect(resolveHostArgv(pathToFileURL(join(bundledDir, 'client.js')).href)).toEqual([
      process.execPath,
      join(bundledDir, 'host.js'),
    ])
    await rm(bundledDir, { recursive: true, force: true })
  })

  it('ignores non-response lines and concurrent ensureProcess', async () => {
    const proc = fakeProcess(() => 'ok')
    const client = new ComputerHostClient({ spawn: () => proc, argv: ['node', 'host.js'] })
    const a = client.call('listApps')
    const b = client.call('listApps')
    expect(await Promise.all([a, b])).toEqual(['ok', 'ok'])
    expect(await client.call('listApps')).toBe('ok')
    proc.stdout.write('{}\n')
    await client.dispose()
    await client.dispose()
  })

  it('covers default argv, non-Error abort, spawn failure, and unused dispose', async () => {
    const idle = new ComputerHostClient({
      spawn: () => fakeProcess(() => 'ok'),
    })
    expect(await idle.call('listApps')).toBe('ok')
    await idle.dispose()

    const proc = fakeProcess(() => 'ok')
    const client = new ComputerHostClient({ spawn: () => proc, argv: ['node', 'host.js'] })
    await expect(client.call('listApps', undefined, AbortSignal.abort('stop'))).rejects.toMatchObject({
      code: 'COMPUTER_UNSUPPORTED',
    })
    await client.dispose()

    let rejectDone!: (error: Error) => void
    const failing = fakeProcess(() => 'ok', { silent: true })
    Object.defineProperty(failing, 'done', {
      value: new Promise<never>((_, reject) => {
        rejectDone = reject
      }),
    })
    const crash = new ComputerHostClient({ spawn: () => failing, argv: ['node', 'host.js'] })
    const pending = crash.call('listApps')
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    rejectDone(new Error('spawn failed'))
    await expect(pending).rejects.toMatchObject({ code: 'COMPUTER_HOST_CRASHED' })
  })
})

describe('local provider + plugin', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('maps provider methods through a fake RPC client', async () => {
    const client = {
      call: vi.fn(async (method: string, params?: unknown) => {
        if (method === 'screenshot') {
          return { pngBase64: Buffer.from([1, 2]).toString('base64'), width: 1, height: 1, scale: 1, bounds: { x: 0, y: 0, width: 1, height: 1 } }
        }
        if (method === 'windowAtPoint') {
          return (params as { x: number }).x === 0
            ? { id: 'w1', appId: 'notes', title: 'Notes', bounds: { x: 0, y: 0, width: 1, height: 1 }, focused: true }
            : null
        }
        if (method === 'listWindows') return []
        if (method === 'listApps') return []
        if (method === 'permissions') {
          return { accessibility: 'unknown', screenRecording: 'unknown', inputInjection: 'unknown' }
        }
        if (method === 'clipboardRead') return 'c'
        if (method === 'capabilities') return ['a11y']
        return { id: 'a', name: 'A', pid: 1 }
      }),
      dispose: vi.fn(async () => undefined),
    }
    const ctx = new Context()
    const provider = new LocalComputerProvider(ctx, {
      requestTimeoutMs: 1000,
      windowCacheMs: 0,
      graceMs: 100,
      client: client as never,
    })
    expect(provider.id).toBe(LOCAL_COMPUTER_PROVIDER_ID)
    expect(provider.available()).toBe(true)
    expect(provider.capabilities()).toContain('a11y')
    await provider.permissions()
    await provider.listApps()
    await provider.listWindows()
    await provider.listWindows(ComputerAppId('a'))
    await provider.launchApp({ name: 'A' })
    await provider.focusWindow(ComputerWindowId('w'))
    expect(await provider.windowAtPoint(0, 0)).toMatchObject({ id: 'w1' })
    expect(await provider.windowAtPoint(9, 9)).toBeUndefined()
    await provider.snapshot({ windowId: ComputerWindowId('w'), maxNodes: 1 })
    expect((await provider.screenshot({})).png).toEqual(new Uint8Array([1, 2]))
    await provider.press('n')
    await provider.setValue('n', 'v')
    await provider.click({ x: 0, y: 0 })
    await provider.type('x')
    await provider.key({ key: 'a' })
    await provider.scroll({ x: 0, y: 0, direction: 'down', amount: 1 })
    await provider.drag({ fromX: 0, fromY: 0, toX: 1, toY: 1 })
    await provider.move({ x: 0, y: 0 })
    expect(await provider.clipboardRead()).toBe('c')
    await provider.clipboardWrite('z')
    await provider.dispose()
    expect(client.dispose).toHaveBeenCalledOnce()
  })

  it('rejects a malformed screenshot payload', async () => {
    const client = { call: async () => ({}), dispose: async () => undefined }
    const provider = new LocalComputerProvider(new Context(), {
      requestTimeoutMs: 1000,
      windowCacheMs: 0,
      graceMs: 100,
      client: client as never,
    })
    await expect(provider.screenshot({})).rejects.toMatchObject({ code: 'COMPUTER_UNSUPPORTED' })
    const client2 = { call: async () => null, dispose: async () => undefined }
    const provider2 = new LocalComputerProvider(new Context(), {
      requestTimeoutMs: 1000,
      windowCacheMs: 0,
      graceMs: 100,
      client: client2 as never,
    })
    await expect(provider2.screenshot({})).rejects.toMatchObject({ code: 'COMPUTER_UNSUPPORTED' })
    const client3 = { call: async () => ({ pngBase64: Buffer.from([1]).toString('base64') }), dispose: async () => undefined }
    const provider3 = new LocalComputerProvider(new Context(), {
      requestTimeoutMs: 1000,
      windowCacheMs: 0,
      graceMs: 100,
      client: client3 as never,
    })
    expect(await provider3.screenshot({})).toMatchObject({ width: 0, height: 0, scale: 1, bounds: { x: 0, y: 0, width: 0, height: 0 } })
  })

  it('registers through apply and tears down with the fiber', async () => {
    const ctx = new Context()
    await ctx.plugin(ComputerRuntime)
    Object.assign(ctx, {
      subprocess: {
        spawn: () => {
          throw new Error('spawn should stay lazy')
        },
      },
    })
    expect(name).toBe('computer-use-local')
    expect(Config({}).requestTimeoutMs).toBe(30_000)
    apply(ctx, { requestTimeoutMs: 1_000, graceMs: 100, windowCacheMs: 0 })
    expect(ctx.computer.capabilities()).toContain('a11y')
    expect(() => { apply(ctx, { requestTimeoutMs: 0, graceMs: 1, windowCacheMs: 0 }) }).toThrow(/requestTimeoutMs/)
    expect(() => { apply(ctx, { requestTimeoutMs: 1, graceMs: Number.NaN, windowCacheMs: 0 }) }).toThrow(/graceMs/)
    expect(() => { apply(ctx, { requestTimeoutMs: 1, graceMs: 1, windowCacheMs: -1 }) }).toThrow(/windowCacheMs/)
    expect(Config({}).windowCacheMs).toBe(2_000)
    await ctx.fiber.dispose()
  })

  it('spawns the helper through ctx.subprocess on first use', async () => {
    const proc = fakeProcess(() => ({
      accessibility: 'granted',
      screenRecording: 'granted',
      inputInjection: 'granted',
    }))
    const ctx = new Context()
    await ctx.plugin(ComputerRuntime)
    Object.assign(ctx, {
      subprocess: {
        spawn: () => proc,
      },
    })
    apply(ctx, { requestTimeoutMs: 1_000, graceMs: 100, windowCacheMs: 0 })
    await expect(ctx.computer.permissions()).resolves.toMatchObject({ accessibility: 'granted' })
    await ctx.fiber.dispose()
  })
})

describe('doctor', () => {
  it('prints a platform fallback report and OS remediations', async () => {
    const none = async () => undefined
    const darwin = await doctor({ platform: 'darwin', load: none })
    expect(darwin.backend).toBe('platform')
    expect(formatDoctorReport(darwin)).toContain('accessibility:')
    const linux = await doctor({ platform: 'linux', load: none })
    expect(linux.remediation.some(line => line.includes('AT-SPI'))).toBe(true)
    const previous = process.env.WAYLAND_DISPLAY
    process.env.WAYLAND_DISPLAY = 'wayland-0'
    try {
      const wayland = await doctor({ platform: 'linux', load: none })
      expect(wayland.remediation.some(line => line.includes('Wayland'))).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.WAYLAND_DISPLAY
      else process.env.WAYLAND_DISPLAY = previous
    }
    const windows = await doctor({ platform: 'win32', load: none })
    expect(windows.remediation[0]).toMatch(/Windows/)
    const requested = await doctor({ platform: 'win32', request: true, load: none })
    expect(requested.platform).toBe('win32')
    const granted = {
      accessibility: 'granted' as const,
      screenRecording: 'granted' as const,
      inputInjection: 'granted' as const,
    }
    expect(computerDoctorRemediation('darwin', granted)).toEqual([])
    expect(computerDoctorRemediation('darwin', { ...granted, inputInjection: 'not-required' })).toEqual([])
    expect(computerDoctorRemediation('linux', { ...granted, inputInjection: 'not-required' })).toEqual([])
    expect(computerDoctorRemediation('win32', granted)[0]).toMatch(/Windows/)
    expect(formatDoctorReport({
      platform: 'darwin',
      backend: 'simulang',
      permissions: granted,
      capabilities: [],
      remediation: [],
    })).toContain('(none)')
    const native = await doctor({
      platform: 'darwin',
      request: true,
      load: async () => fakeSimulang({ screenCapture: true }).module,
    })
    expect(native.backend).toBe('simulang')
    expect(native.permissions).toEqual(granted)
    expect(native.remediation).toEqual([])
    const omitted = await doctor({ load: none })
    expect(omitted.platform).toBe(process.platform)
  })
})
