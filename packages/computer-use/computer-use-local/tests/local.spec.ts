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
  doctor,
  formatDoctorReport,
  computerDoctorRemediation,
  handleComputerMethod,
  isHostProcessEntry,
  loadSimulang,
  name,
  resolveHostArgv,
  type ComputerHostProcess,
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

describe('simulang adapter', () => {
  it('returns undefined when the optional native library is absent', async () => {
    expect(await loadSimulang()).toBeUndefined()
    expect(await loadSimulang(async () => ({ default: { listWindows: async () => [] } }))).toMatchObject({ listWindows: expect.any(Function) })
    expect(await loadSimulang(async () => ({ listWindows: async () => [] }))).toMatchObject({ listWindows: expect.any(Function) })
    await expect(loadSimulang(async () => { throw new Error('missing') })).resolves.toBeUndefined()
  })

  it('maps apps, windows, nodes, screenshots, and input through a duck-typed module', async () => {
    const backend = createSimulangBackend({
      listApps: async () => [{ name: 'Notes', pid: 3, bundleId: 'com.apple.Notes' }],
      listWindows: async () => [{ id: 'w', appId: 'com.apple.Notes', title: 'T', x: 1, y: 2, width: 3, height: 4, focused: true }],
      launch: async name => ({ name }),
      snapshot: async () => ({
        nodes: [
          { refId: 'a', role: 'button', name: 'OK', secure: true, value: 'secret', supportsPress: true, supportsSetValue: true, states: ['focused'] },
          { refId: 'b', role: 'textfield', name: 'Name', value: 'Ada' },
        ],
      }),
      screenshot: async () => ({ png: new Uint8Array([1]), width: 2, height: 3, scale: 2 }),
      press: async () => undefined,
      setValue: async () => undefined,
      click: async () => undefined,
      type: async () => undefined,
      key: async () => undefined,
      scroll: async () => undefined,
      move: async () => undefined,
      drag: async () => undefined,
      clipboard: { read: async () => 'c', write: async () => undefined },
      permissions: async () => ({ accessibility: 'granted', screenRecording: 'granted', inputInjection: 'granted' }),
    })
    expect(backend.capabilities()).toContain('a11y')
    expect((await backend.listApps())[0]?.id).toBe('com.apple.Notes')
    expect((await backend.listWindows())[0]?.title).toBe('T')
    await backend.launchApp({ name: 'Notes' })
    const snap = await backend.snapshot({ windowId: ComputerWindowId('w'), maxNodes: 10 })
    expect(snap.nodes[0]?.value).toBeUndefined()
    expect(snap.nodes[0]?.secure).toBe(true)
    expect(snap.nodes[1]?.value).toBe('Ada')
    const bytes = await backend.screenshot({})
    expect(bytes.scale).toBe(2)
    await backend.press('a')
    await backend.setValue('a', 'v')
    await backend.click({ x: 1, y: 2, button: 'left', count: 1 })
    await backend.click({ x: 3, y: 4 })
    await backend.type('x')
    await backend.key({ key: 'a' })
    await backend.scroll({ x: 0, y: 0, direction: 'down', amount: 3 })
    await backend.scroll({ x: 0, y: 0, direction: 'up', amount: 1 })
    await backend.scroll({ x: 0, y: 0, direction: 'left', amount: 1 })
    await backend.scroll({ x: 0, y: 0, direction: 'right', amount: 1 })
    await backend.move({ x: 1, y: 1 })
    await backend.drag({ fromX: 0, fromY: 0, toX: 1, toY: 1 })
    expect(await backend.clipboardRead()).toBe('c')
    await backend.clipboardWrite('z')
    expect(await backend.permissions()).toMatchObject({ accessibility: 'granted' })
    await expect(backend.focusWindow(ComputerWindowId('w'))).rejects.toMatchObject({ code: 'COMPUTER_UNSUPPORTED' })
    expect(await backend.windowAtPoint(0, 0)).toBeUndefined()
  })

  it('derives apps from windows and returns raw PNG bytes when helpers are partial', async () => {
    const backend = createSimulangBackend({
      listWindows: async () => [{ appId: 'a' }, { appId: 'a' }],
      screenshot: async () => new Uint8Array([9]),
      snapshot: async () => ({ nodes: Array.from({ length: 3 }, () => ({})) }),
    })
    expect(await backend.listApps()).toHaveLength(1)
    expect((await backend.screenshot({})).png).toEqual(new Uint8Array([9]))
    const snap = await backend.snapshot({ windowId: ComputerWindowId('w'), maxNodes: 1 })
    expect(snap.truncated).toBe(true)
    expect(snap.nodes).toHaveLength(1)
    await expect(backend.launchApp({ name: 'x' })).rejects.toMatchObject({ code: 'COMPUTER_UNSUPPORTED' })
    await expect(backend.press('x')).rejects.toMatchObject({ code: 'COMPUTER_UNSUPPORTED' })
    await expect(backend.setValue('x', 'y')).rejects.toMatchObject({ code: 'COMPUTER_UNSUPPORTED' })
    await expect(backend.click({ x: 0, y: 0 })).rejects.toMatchObject({ code: 'COMPUTER_UNSUPPORTED' })
    await expect(backend.type('x')).rejects.toMatchObject({ code: 'COMPUTER_UNSUPPORTED' })
    await expect(backend.key({ key: 'x' })).rejects.toMatchObject({ code: 'COMPUTER_UNSUPPORTED' })
    await expect(backend.scroll({ x: 0, y: 0, direction: 'down', amount: 1 })).rejects.toMatchObject({ code: 'COMPUTER_UNSUPPORTED' })
    await expect(backend.move({ x: 0, y: 0 })).rejects.toMatchObject({ code: 'COMPUTER_UNSUPPORTED' })
    await expect(backend.drag({ fromX: 0, fromY: 0, toX: 1, toY: 1 })).rejects.toMatchObject({ code: 'COMPUTER_UNSUPPORTED' })
    await expect(backend.clipboardRead()).rejects.toMatchObject({ code: 'COMPUTER_UNSUPPORTED' })
    await expect(backend.clipboardWrite('x')).rejects.toMatchObject({ code: 'COMPUTER_UNSUPPORTED' })
    expect(await backend.listWindows()).toHaveLength(2)
    expect(await backend.permissions()).toMatchObject({ accessibility: 'unknown' })
  })

  it('returns empty windows when listWindows is missing', async () => {
    const backend = createSimulangBackend({})
    expect(await backend.listWindows()).toEqual([])
    expect(await backend.listApps()).toEqual([])
    await expect(backend.snapshot({ windowId: ComputerWindowId('w'), maxNodes: 1 })).rejects.toMatchObject({ code: 'COMPUTER_UNSUPPORTED' })
    await expect(backend.screenshot({})).rejects.toMatchObject({ code: 'COMPUTER_UNSUPPORTED' })
  })

  it('fills missing app, window, and screenshot fields', async () => {
    const backend = createSimulangBackend({
      listApps: async () => [{ pid: 4 }, { bundleId: 'com.example.app' }],
      listWindows: async () => [{}],
      screenshot: async (options) => {
        void options
        return { png: new Uint8Array([1]), width: 2, height: 3 }
      },
    })
    const apps = await backend.listApps()
    expect(apps[0]?.name).toBe('app-0')
    expect(apps[1]?.name).toBe('com.example.app')
    expect((await backend.listWindows())[0]?.id).toBe('window-0')
    expect((await backend.screenshot({ windowId: ComputerWindowId('w') })).scale).toBe(1)
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

  it('resolveBackend falls back to the platform backend and main can use it', async () => {
    const backend = await resolveBackend()
    expect(backend.capabilities().length).toBeGreaterThan(0)
    const native = await resolveBackend(async () => ({
      listWindows: async () => [],
      permissions: async () => ({ accessibility: 'granted', screenRecording: 'granted', inputInjection: 'granted' }),
    }))
    expect(native.capabilities()).toContain('a11y')
    const input = new PassThrough()
    const stderr = new PassThrough()
    input.end()
    await main({ input, output: new PassThrough(), stderr })
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
  const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(resolve => {
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
    await new Promise<void>(resolve => { setImmediate(resolve) })
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
    await new Promise<void>(resolve => { setImmediate(resolve) })
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
      graceMs: 100,
      client: client as never,
    })
    await expect(provider.screenshot({})).rejects.toMatchObject({ code: 'COMPUTER_UNSUPPORTED' })
    const client2 = { call: async () => null, dispose: async () => undefined }
    const provider2 = new LocalComputerProvider(new Context(), {
      requestTimeoutMs: 1000,
      graceMs: 100,
      client: client2 as never,
    })
    await expect(provider2.screenshot({})).rejects.toMatchObject({ code: 'COMPUTER_UNSUPPORTED' })
    const client3 = { call: async () => ({ pngBase64: Buffer.from([1]).toString('base64') }), dispose: async () => undefined }
    const provider3 = new LocalComputerProvider(new Context(), {
      requestTimeoutMs: 1000,
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
    apply(ctx, { requestTimeoutMs: 1_000, graceMs: 100 })
    expect(ctx.computer.capabilities()).toContain('a11y')
    expect(() => apply(ctx, { requestTimeoutMs: 0, graceMs: 1 })).toThrow(/requestTimeoutMs/)
    expect(() => apply(ctx, { requestTimeoutMs: 1, graceMs: Number.NaN })).toThrow(/graceMs/)
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
    apply(ctx, { requestTimeoutMs: 1_000, graceMs: 100 })
    await expect(ctx.computer.permissions()).resolves.toMatchObject({ accessibility: 'granted' })
    await ctx.fiber.dispose()
  })
})

describe('doctor', () => {
  it('prints a platform fallback report and OS remediations', async () => {
    const darwin = await doctor({ platform: 'darwin' })
    expect(darwin.backend).toBe('platform')
    expect(formatDoctorReport(darwin)).toContain('accessibility:')
    const linux = await doctor({ platform: 'linux' })
    expect(linux.remediation.some(line => line.includes('AT-SPI'))).toBe(true)
    const previous = process.env.WAYLAND_DISPLAY
    process.env.WAYLAND_DISPLAY = 'wayland-0'
    try {
      const wayland = await doctor({ platform: 'linux' })
      expect(wayland.remediation.some(line => line.includes('Wayland'))).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.WAYLAND_DISPLAY
      else process.env.WAYLAND_DISPLAY = previous
    }
    const windows = await doctor({ platform: 'win32' })
    expect(windows.remediation[0]).toMatch(/Windows/)
    const requested = await doctor({ platform: 'win32', request: true })
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
      load: async () => ({
        permissions: async () => granted,
        listApps: async () => [],
        screenshot: async () => new Uint8Array([1]),
      }),
    })
    expect(native.backend).toBe('simulang')
    const omitted = await doctor()
    expect(omitted.platform).toBe(process.platform)
  })
})
