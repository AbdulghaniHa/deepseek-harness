import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import ComputerRuntime, {
  ComputerAppId,
  ComputerDisplayId,
  ComputerError,
  ComputerWindowId,
  connectionState,
  isDeniedApp,
  isHarnessPid,
  normalizeDenyToken,
  permissionIssues,
  recoveryForComputerCode,
  TERMINAL_DENY_IDS,
  type ComputerApp,
  type ComputerProvider,
  type ComputerRect,
  type ComputerWindow,
} from '@deepseek-ai/dsh-computer-use'

function makeAgent(id: string): Agent {
  return { id: SessionId(id) } as unknown as Agent
}

const BOUNDS: ComputerRect = { x: 0, y: 0, width: 800, height: 600 }

function app(id: string, overrides: Partial<ComputerApp> = {}): ComputerApp {
  return {
    id: ComputerAppId(id),
    name: id,
    pid: 4000,
    bundleId: `app.${id}`,
    ...overrides,
  }
}

function windowOf(id: string, appId: string, overrides: Partial<ComputerWindow> = {}): ComputerWindow {
  return {
    id: ComputerWindowId(id),
    appId: ComputerAppId(appId),
    title: id,
    bounds: BOUNDS,
    focused: false,
    ...overrides,
  }
}

function makeProvider(id: string, available: boolean, extras: Partial<ComputerProvider> = {}): ComputerProvider & {
  clicks: { x: number; y: number }[]
} {
  const clicks: { x: number; y: number }[] = []
  const first = app('notes')
  const firstWindow = windowOf('w1', 'notes', { focused: true })
  return {
    id,
    available: () => available,
    capabilities: () => ['a11y', 'screenshot', 'input', 'clipboard'],
    permissions: () => Promise.resolve({
      accessibility: 'granted',
      screenRecording: 'granted',
      inputInjection: 'granted',
    }),
    listApps: () => Promise.resolve([first]),
    listWindows: () => Promise.resolve([firstWindow]),
    listDisplays: () => Promise.resolve([{
      id: ComputerDisplayId('d1'),
      bounds: BOUNDS,
      scale: 1,
      primary: true,
    }]),
    launchApp: request => Promise.resolve(app('launched', { name: request.name })),
    focusWindow: () => Promise.resolve(),
    setWindowBounds: () => Promise.resolve(),
    windowAtPoint: (x, y) => Promise.resolve(windowOf('w1', 'notes', { bounds: { x, y, width: 1, height: 1 } })),
    snapshot: request => Promise.resolve({
      windowId: request.windowId,
      appId: ComputerAppId('notes'),
      title: 'Notes',
      truncated: false,
      nodes: [{
        handle: 'n1',
        role: 'button',
        name: 'OK',
        bounds: BOUNDS,
        states: [],
        supportsPress: true,
        supportsSetValue: false,
        actions: ['activate'],
        secure: false,
      }],
    }),
    screenshot: () => Promise.resolve({
      png: new Uint8Array([1, 2, 3]),
      width: 10,
      height: 10,
      scale: 1,
      bounds: BOUNDS,
    }),
    press: () => Promise.resolve(),
    setValue: () => Promise.resolve(),
    focusElement: () => Promise.resolve(),
    action: () => Promise.resolve(),
    click: (request) => {
      clicks.push({ x: request.x, y: request.y })
      return Promise.resolve()
    },
    type: () => Promise.resolve(),
    key: () => Promise.resolve(),
    scroll: () => Promise.resolve(),
    drag: () => Promise.resolve(),
    move: () => Promise.resolve(),
    clipboardRead: () => Promise.resolve('clip'),
    clipboardWrite: () => Promise.resolve(),
    clicks,
    ...extras,
  }
}

async function mount(config: ConstructorParameters<typeof ComputerRuntime>[1] = {}): Promise<{
  ctx: Context
  computer: ComputerRuntime
}> {
  const ctx = new Context()
  await ctx.plugin(ComputerRuntime, config)
  return { ctx, computer: ctx.computer }
}

const available = true
const unavailable = false

describe('deny list', () => {
  it('normalizes paths, bundle ids, and .app suffixes', () => {
    expect(normalizeDenyToken('/Applications/Terminal.app')).toBe('terminal')
    expect(normalizeDenyToken('COM.APPLE.TERMINAL')).toBe('com.apple.terminal')
    expect(TERMINAL_DENY_IDS).toContain('com.apple.terminal')
  })

  it('matches terminals by name, bundle id, and extra tokens', () => {
    expect(isDeniedApp(app('Terminal', { name: 'Terminal', bundleId: 'com.apple.Terminal' }))).toBe(true)
    expect(isDeniedApp(app('notes'))).toBe(false)
    expect(isDeniedApp(app('secret', { name: 'Secret' }), ['secret'])).toBe(true)
  })

  it('treats this process and its parent as the harness', () => {
    expect(isHarnessPid(process.pid)).toBe(true)
    expect(isHarnessPid(process.ppid)).toBe(true)
    expect(isHarnessPid(1)).toBe(false)
  })
})

describe('ComputerRuntime registration', () => {
  it('registers a provider and unregisters it via the returned disposer', async () => {
    const { computer } = await mount()
    const provider = makeProvider('local', available)
    const dispose = computer.registerProvider(provider)
    await expect(computer.listApps()).resolves.toHaveLength(1)
    dispose()
    await expect(computer.listApps()).rejects.toThrow(expect.objectContaining({ code: 'COMPUTER_PROVIDER_UNAVAILABLE' }))
  })

  it('throws COMPUTER_DUPLICATE_PROVIDER on a duplicate id', async () => {
    const { computer } = await mount()
    computer.registerProvider(makeProvider('local', available))
    expect(() => computer.registerProvider(makeProvider('local', available)))
      .toThrow(expect.objectContaining({ code: 'COMPUTER_DUPLICATE_PROVIDER' }))
  })

  it('clears providers when the computer runtime fiber is disposed', async () => {
    const { ctx, computer } = await mount()
    computer.registerProvider(makeProvider('local', available))
    await expect(computer.listApps()).resolves.toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('disposes provider registrations when the contributing fiber is disposed (HMR safety)', async () => {
    const { ctx, computer } = await mount()
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.computer.registerProvider(makeProvider('local', available))
    }, { inject: ['computer'] }))
    await expect(computer.listApps()).resolves.toHaveLength(1)
    await fiber.dispose()
    await expect(computer.listApps()).rejects.toThrow(expect.objectContaining({ code: 'COMPUTER_PROVIDER_UNAVAILABLE' }))
  })
})

describe('ComputerRuntime execution resolution', () => {
  it('throws COMPUTER_PROVIDER_UNAVAILABLE when nothing is registered', async () => {
    const { computer } = await mount()
    await expect(computer.listApps()).rejects.toThrow(expect.objectContaining({ code: 'COMPUTER_PROVIDER_UNAVAILABLE' }))
    expect(computer.capabilities()).toEqual([])
  })

  it('throws COMPUTER_PROVIDER_UNAVAILABLE when providers exist but none are usable', async () => {
    const { computer } = await mount()
    computer.registerProvider(makeProvider('local', unavailable))
    await expect(computer.listApps()).rejects.toThrow(expect.objectContaining({ code: 'COMPUTER_PROVIDER_UNAVAILABLE' }))
  })

  it('throws COMPUTER_PROVIDER_CONFIGURED_MISSING for an unregistered configured id', async () => {
    const { computer } = await mount({ provider: 'missing' })
    computer.registerProvider(makeProvider('local', available))
    await expect(computer.listApps()).rejects.toThrow(expect.objectContaining({ code: 'COMPUTER_PROVIDER_CONFIGURED_MISSING' }))
  })

  it('throws COMPUTER_PROVIDER_CONFIGURED_UNAVAILABLE for an unusable configured id', async () => {
    const { computer } = await mount({ provider: 'local' })
    computer.registerProvider(makeProvider('local', unavailable))
    await expect(computer.listApps()).rejects.toThrow(expect.objectContaining({ code: 'COMPUTER_PROVIDER_CONFIGURED_UNAVAILABLE' }))
  })

  it('throws COMPUTER_PROVIDER_AMBIGUOUS rather than picking by order', async () => {
    const { computer } = await mount()
    computer.registerProvider(makeProvider('local', available))
    computer.registerProvider(makeProvider('remote', available))
    await expect(computer.listApps()).rejects.toThrow(expect.objectContaining({ code: 'COMPUTER_PROVIDER_AMBIGUOUS' }))
  })

  it('runs the configured provider even when another usable provider is registered', async () => {
    const { computer } = await mount({ provider: 'remote' })
    computer.registerProvider(makeProvider('local', available))
    computer.registerProvider(makeProvider('remote', available, {
      listApps: () => Promise.resolve([app('remote')]),
    }))
    await expect(computer.listApps()).resolves.toEqual([expect.objectContaining({ id: 'remote' })])
  })

  it('auto-selects the single usable provider and reports capabilities', async () => {
    const { computer } = await mount()
    computer.registerProvider(makeProvider('local', available))
    expect(computer.capabilities()).toEqual(['a11y', 'screenshot', 'input', 'clipboard'])
    await expect(computer.permissions()).resolves.toMatchObject({ accessibility: 'granted' })
    await expect(computer.listWindows()).resolves.toHaveLength(1)
    await expect(computer.clipboardRead()).resolves.toBe('clip')
  })

  it('rethrows non-ComputerError from capabilities()', async () => {
    const { computer } = await mount()
    computer.registerProvider(makeProvider('local', available, {
      available: () => {
        throw new TypeError('boom')
      },
    }))
    expect(() => computer.capabilities()).toThrow(TypeError)
  })
})

describe('ComputerRuntime grants and deny', () => {
  it('records, lists, and revokes per-owner grants', async () => {
    const { computer } = await mount()
    computer.registerProvider(makeProvider('local', available))
    const owner = makeAgent('a')
    const other = makeAgent('b')
    computer.grant(owner, ComputerAppId('notes'), 'session')
    expect(computer.hasGrant(owner, ComputerAppId('notes'))).toBe(true)
    expect(computer.listGrants(owner)).toEqual([
      expect.objectContaining({ appId: 'notes', scope: 'session', owner }),
    ])
    expect(computer.listGrants(other)).toEqual([])
    computer.revoke(owner, ComputerAppId('notes'))
    expect(computer.hasGrant(owner, ComputerAppId('notes'))).toBe(false)
  })

  it('rejects mutating calls without a grant', async () => {
    const { computer } = await mount()
    computer.registerProvider(makeProvider('local', available))
    const owner = makeAgent('a')
    await expect(computer.focusWindow(owner, ComputerWindowId('w1')))
      .rejects.toThrow(expect.objectContaining({ code: 'COMPUTER_APP_NOT_ALLOWED' }))
  })

  it('rejects the fixed terminal deny list even with a grant', async () => {
    const { computer } = await mount()
    computer.registerProvider(makeProvider('local', available, {
      listApps: () => Promise.resolve([app('Terminal', { name: 'Terminal', bundleId: 'com.apple.Terminal' })]),
      listWindows: () => Promise.resolve([windowOf('w1', 'Terminal')]),
    }))
    const owner = makeAgent('a')
    computer.grant(owner, ComputerAppId('Terminal'), 'session')
    await expect(computer.focusWindow(owner, ComputerWindowId('w1')))
      .rejects.toThrow(expect.objectContaining({ code: 'COMPUTER_APP_DENIED' }))
  })

  it('rejects the harness pid even with a grant', async () => {
    const { computer } = await mount()
    computer.registerProvider(makeProvider('local', available, {
      listApps: () => Promise.resolve([app('notes', { pid: process.pid })]),
    }))
    const owner = makeAgent('a')
    computer.grant(owner, ComputerAppId('notes'), 'session')
    await expect(computer.focusWindow(owner, ComputerWindowId('w1')))
      .rejects.toThrow(expect.objectContaining({ code: 'COMPUTER_APP_DENIED' }))
  })

  it('rejects extra configured deny tokens', async () => {
    const { computer } = await mount({ deniedApps: ['notes'] })
    computer.registerProvider(makeProvider('local', available))
    const owner = makeAgent('a')
    computer.grant(owner, ComputerAppId('notes'), 'session')
    await expect(computer.focusWindow(owner, ComputerWindowId('w1')))
      .rejects.toThrow(expect.objectContaining({ code: 'COMPUTER_APP_DENIED' }))
  })

  it('consumes a once grant on a mutating call and keeps a session grant', async () => {
    const { computer } = await mount()
    computer.registerProvider(makeProvider('local', available))
    const owner = makeAgent('a')
    computer.grant(owner, ComputerAppId('notes'), 'once')
    await computer.focusWindow(owner, ComputerWindowId('w1'))
    expect(computer.hasGrant(owner, ComputerAppId('notes'))).toBe(false)
    computer.grant(owner, ComputerAppId('notes'), 'session')
    await computer.focusWindow(owner, ComputerWindowId('w1'))
    expect(computer.hasGrant(owner, ComputerAppId('notes'))).toBe(true)
  })

  it('does not consume a once grant on snapshot or screenshot', async () => {
    const { computer } = await mount()
    computer.registerProvider(makeProvider('local', available))
    const owner = makeAgent('a')
    computer.grant(owner, ComputerAppId('notes'), 'once')
    await computer.snapshot(owner, { windowId: ComputerWindowId('w1'), maxNodes: 10 })
    await computer.screenshot(owner, { windowId: ComputerWindowId('w1') })
    expect(computer.hasGrant(owner, ComputerAppId('notes'))).toBe(true)
  })
})

describe('ComputerRuntime actions', () => {
  it('launches, snapshots, presses, types, and keys under a grant', async () => {
    const { computer } = await mount()
    computer.registerProvider(makeProvider('local', available))
    const owner = makeAgent('a')
    computer.grant(owner, ComputerAppId('launched'), 'session')
    const launched = await computer.launchApp(owner, { name: 'Notes' })
    expect(launched.name).toBe('Notes')
    computer.grant(owner, ComputerAppId('notes'), 'session')
    const snapshot = await computer.snapshot(owner, { windowId: ComputerWindowId('w1'), maxNodes: 20 })
    expect(snapshot.nodes[0]?.name).toBe('OK')
    await computer.press(owner, ComputerWindowId('w1'), 'n1')
    await computer.setValue(owner, ComputerWindowId('w1'), 'n1', 'hello')
    await computer.type(owner, ComputerWindowId('w1'), 'hello')
    await computer.key(owner, ComputerWindowId('w1'), { key: 'Enter' })
    await computer.clipboardWrite(owner, 'x')
  })

  it('hit-tests coordinate actions and rejects a foreign window', async () => {
    const { computer } = await mount()
    computer.registerProvider(makeProvider('local', available, {
      windowAtPoint: () => Promise.resolve(windowOf('other', 'chrome')),
    }))
    const owner = makeAgent('a')
    computer.grant(owner, ComputerAppId('notes'), 'session')
    await expect(computer.click(owner, ComputerWindowId('w1'), { x: 10, y: 10 }))
      .rejects.toThrow(expect.objectContaining({ code: 'COMPUTER_TARGET_MISMATCH' }))
  })

  it('forwards click, scroll, drag, and move when the hit matches', async () => {
    const { computer } = await mount()
    const provider = makeProvider('local', available)
    computer.registerProvider(provider)
    const owner = makeAgent('a')
    computer.grant(owner, ComputerAppId('notes'), 'session')
    await computer.click(owner, ComputerWindowId('w1'), { x: 4, y: 5 })
    computer.grant(owner, ComputerAppId('notes'), 'session')
    await computer.scroll(owner, ComputerWindowId('w1'), { x: 4, y: 5, direction: 'down', amount: 1 })
    computer.grant(owner, ComputerAppId('notes'), 'session')
    await computer.drag(owner, ComputerWindowId('w1'), { fromX: 1, fromY: 1, toX: 2, toY: 2 })
    computer.grant(owner, ComputerAppId('notes'), 'session')
    await computer.move(owner, ComputerWindowId('w1'), { x: 3, y: 3 })
    expect(provider.clicks).toEqual([{ x: 4, y: 5 }])
  })

  it('rejects a hit-test miss (undefined) after a grant', async () => {
    const { computer } = await mount()
    computer.registerProvider(makeProvider('local', available, {
      windowAtPoint: () => Promise.resolve(undefined),
    }))
    const owner = makeAgent('a')
    computer.grant(owner, ComputerAppId('notes'), 'session')
    await expect(computer.click(owner, ComputerWindowId('w1'), { x: 1, y: 1 }))
      .rejects.toThrow(expect.objectContaining({ code: 'COMPUTER_TARGET_MISMATCH' }))
  })

  it('throws COMPUTER_WINDOW_GONE for an unknown window', async () => {
    const { computer } = await mount()
    computer.registerProvider(makeProvider('local', available))
    const owner = makeAgent('a')
    computer.grant(owner, ComputerAppId('notes'), 'session')
    await expect(computer.focusWindow(owner, ComputerWindowId('missing')))
      .rejects.toThrow(expect.objectContaining({ code: 'COMPUTER_WINDOW_GONE' }))
  })

  it('throws COMPUTER_WINDOW_GONE when the app disappears', async () => {
    const { computer } = await mount()
    computer.registerProvider(makeProvider('local', available, {
      listApps: () => Promise.resolve([]),
    }))
    const owner = makeAgent('a')
    computer.grant(owner, ComputerAppId('notes'), 'session')
    await expect(computer.focusWindow(owner, ComputerWindowId('w1')))
      .rejects.toThrow(expect.objectContaining({ code: 'COMPUTER_WINDOW_GONE' }))
  })

  it('rejects clipboard write without any grant', async () => {
    const { computer } = await mount()
    computer.registerProvider(makeProvider('local', available))
    await expect(computer.clipboardWrite(makeAgent('a'), 'x'))
      .rejects.toThrow(expect.objectContaining({ code: 'COMPUTER_APP_NOT_ALLOWED' }))
  })

  it('screenshots a full display without a window grant', async () => {
    const { computer } = await mount()
    computer.registerProvider(makeProvider('local', available))
    const shot = await computer.screenshot(makeAgent('a'), {})
    expect(shot.width).toBe(10)
  })

  it('denies launching a terminal or the harness process', async () => {
    const { computer } = await mount()
    computer.registerProvider(makeProvider('local', available, {
      launchApp: request => Promise.resolve(
        request.name === 'Terminal'
          ? app('Terminal', { name: 'Terminal', bundleId: 'com.apple.Terminal' })
          : app('notes', { pid: process.pid }),
      ),
    }))
    const owner = makeAgent('a')
    await expect(computer.launchApp(owner, { name: 'Terminal' }))
      .rejects.toThrow(expect.objectContaining({ code: 'COMPUTER_APP_DENIED' }))
    await expect(computer.launchApp(owner, { name: 'Notes' }))
      .rejects.toThrow(expect.objectContaining({ code: 'COMPUTER_APP_DENIED' }))
  })

  it('selects DSH_COMPUTER_PROVIDER and treats omitted deniedApps as empty', async () => {
    const previous = process.env.DSH_COMPUTER_PROVIDER
    process.env.DSH_COMPUTER_PROVIDER = 'remote'
    try {
      const { computer } = await mount()
      computer.registerProvider(makeProvider('local', available))
      computer.registerProvider(makeProvider('remote', available, {
        listApps: () => Promise.resolve([app('remote')]),
      }))
      await expect(computer.listApps()).resolves.toEqual([expect.objectContaining({ id: 'remote' })])
    } finally {
      if (previous === undefined) delete process.env.DSH_COMPUTER_PROVIDER
      else process.env.DSH_COMPUTER_PROVIDER = previous
    }
    const ctx = new Context()
    const runtime = new ComputerRuntime(ctx, {})
    runtime.registerProvider(makeProvider('local', available))
    expect(runtime.capabilities()).toContain('a11y')
  })
})

describe('status', () => {
  it('never throws when no provider is registered', async () => {
    const { computer } = await mount()
    const status = await computer.status()
    expect(status.available).toBe(false)
    expect(status.connection).toBe('unconfigured')
    expect(status.issues[0]?.code).toBe('COMPUTER_PROVIDER_UNAVAILABLE')
    expect(status.issues[0]?.recovery).toContain('computer_status')
  })

  it('reports a configured missing provider without throwing', async () => {
    const { computer } = await mount({ provider: 'missing' })
    const status = await computer.status()
    expect(status.configuredProvider).toBe('missing')
    expect(status.available).toBe(false)
    expect(status.issues[0]?.code).toBe('COMPUTER_PROVIDER_CONFIGURED_MISSING')
  })

  it('reports live operations after a permissions probe', async () => {
    const { computer } = await mount({ provider: 'local' })
    computer.registerProvider(makeProvider('local', available))
    const status = await computer.status()
    expect(status.connection).toBe('live')
    expect(status.selectedProvider).toBe('local')
    expect(status.operations).toContain('action')
    expect(status.permissions?.accessibility).toBe('granted')
  })

  it('reports probe-failed when the live probe throws', async () => {
    const { computer } = await mount()
    computer.registerProvider(makeProvider('local', available, {
      permissions: () => Promise.reject(new ComputerError('helper down', 'COMPUTER_HOST_CRASHED')),
    }))
    const status = await computer.status()
    expect(status.available).toBe(true)
    expect(status.connection).toBe('probe-failed')
    expect(status.issues[0]?.code).toBe('COMPUTER_HOST_CRASHED')
  })

  it('maps a non-ComputerError probe failure to COMPUTER_HOST_CRASHED', async () => {
    const { computer } = await mount()
    computer.registerProvider(makeProvider('local', available, {
      permissions: () => Promise.reject(new Error('io')),
    }))
    expect((await computer.status()).issues[0]).toMatchObject({ code: 'COMPUTER_HOST_CRASHED', message: 'io' })
    const second = await mount()
    second.computer.registerProvider(makeProvider('local', available, {
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- this case covers the non-Error status message.
      permissions: () => Promise.reject('bare'),
    }))
    expect((await second.computer.status()).issues[0]?.message).toBe('bare')
  })

  it('lists permission recovery when Accessibility is denied', async () => {
    const { computer } = await mount()
    computer.registerProvider(makeProvider('local', available, {
      permissions: () => Promise.resolve({
        accessibility: 'denied',
        screenRecording: 'unknown',
        inputInjection: 'not-required',
      }),
    }))
    const status = await computer.status()
    expect(status.issues.some(issue => issue.code === 'COMPUTER_PERMISSION_ACCESSIBILITY')).toBe(true)
    expect(status.issues.some(issue => issue.code === 'COMPUTER_PERMISSION_SCREEN')).toBe(true)
  })

  it('invokes action after a grant', async () => {
    const { computer } = await mount()
    computer.registerProvider(makeProvider('local', available))
    const owner = makeAgent('a')
    computer.grant(owner, ComputerAppId('notes'), 'session')
    await computer.action(owner, ComputerWindowId('w1'), { handle: 'n1', action: 'activate' })
  })

  it('lists displays, moves windows, focuses elements, and tracks held keys', async () => {
    const { ctx, computer } = await mount()
    const keys: { key: string; action?: string }[] = []
    computer.registerProvider(makeProvider('local', available, {
      key: (request) => {
        keys.push({ key: request.key, ...request.action !== undefined ? { action: request.action } : {} })
        return Promise.resolve()
      },
    }))
    const owner = makeAgent('a')
    const other = makeAgent('b')
    computer.grant(owner, ComputerAppId('notes'), 'session')
    computer.grant(other, ComputerAppId('notes'), 'session')
    await computer.releaseHeldKeys(owner)
    await computer.key(owner, ComputerWindowId('w1'), { key: 'Escape', action: 'up' })
    expect((await computer.listDisplays())[0]?.id).toBe('d1')
    await computer.setWindowBounds(owner, ComputerWindowId('w1'), { x: 1, y: 2, width: 3, height: 4 })
    await computer.focusElement(owner, ComputerWindowId('w1'), 'n1')
    await computer.key(owner, ComputerWindowId('w1'), { key: 'Shift', action: 'down' })
    await computer.key(owner, ComputerWindowId('w1'), { key: 'a', action: 'down' })
    await computer.key(owner, ComputerWindowId('w1'), { key: 'Shift', action: 'up' })
    await expect(computer.click(other, ComputerWindowId('w1'), { x: 1, y: 1 }))
      .rejects.toThrow(expect.objectContaining({ code: 'COMPUTER_INPUT_BUSY' }))
    await computer.key(owner, ComputerWindowId('w1'), { key: 'a', action: 'up' })
    await computer.key(owner, ComputerWindowId('w1'), { key: 'a', action: 'down' })
    await ctx.serial('agent/turn-stopping', { agent: owner, turn: 1, signal: new AbortController().signal })
    expect(keys.some(item => item.key === 'a' && item.action === 'up')).toBe(true)
  })

  it('rejects typing when the window cannot be focused', async () => {
    const { computer } = await mount()
    computer.registerProvider(makeProvider('local', available, {
      listWindows: () => Promise.resolve([windowOf('w1', 'notes', { focused: false })]),
    }))
    const owner = makeAgent('a')
    computer.grant(owner, ComputerAppId('notes'), 'session')
    await expect(computer.type(owner, ComputerWindowId('w1'), 'hi'))
      .rejects.toThrow(expect.objectContaining({ code: 'COMPUTER_TARGET_MISMATCH' }))
  })

  it('types after focusing an unfocused window', async () => {
    const { computer } = await mount()
    let focused = false
    computer.registerProvider(makeProvider('local', available, {
      listWindows: () => Promise.resolve([windowOf('w1', 'notes', { focused })]),
      focusWindow: () => {
        focused = true
        return Promise.resolve()
      },
    }))
    const owner = makeAgent('a')
    computer.grant(owner, ComputerAppId('notes'), 'session')
    await computer.type(owner, ComputerWindowId('w1'), 'hi')
  })

  it('releases held keys when a later key call fails', async () => {
    const { computer } = await mount()
    let fail = false
    computer.registerProvider(makeProvider('local', available, {
      key: (_request) => {
        if (fail) return Promise.reject(new Error('helper'))
        return Promise.resolve()
      },
    }))
    const owner = makeAgent('a')
    computer.grant(owner, ComputerAppId('notes'), 'session')
    await computer.key(owner, ComputerWindowId('w1'), { key: 'Shift', action: 'down' })
    fail = true
    await expect(computer.key(owner, ComputerWindowId('w1'), { key: 'a' })).rejects.toThrow('helper')
    fail = false
    const other = makeAgent('b')
    computer.grant(other, ComputerAppId('notes'), 'session')
    await computer.click(other, ComputerWindowId('w1'), { x: 1, y: 1 })
  })

  it('swallows key-up failures while releasing held keys', async () => {
    const { computer } = await mount()
    computer.registerProvider(makeProvider('local', available, {
      key: request => request.action === 'up'
        ? Promise.reject(new Error('gone'))
        : Promise.resolve(),
    }))
    const owner = makeAgent('a')
    computer.grant(owner, ComputerAppId('notes'), 'session')
    await computer.key(owner, ComputerWindowId('w1'), { key: 'Shift', action: 'down' })
    await computer.releaseHeldKeys(owner)
  })

  it('releases held keys once when cancellation and turn cleanup overlap', async () => {
    const { computer } = await mount()
    const keys: string[] = []
    computer.registerProvider(makeProvider('local', available, {
      key: async (request) => {
        await Promise.resolve()
        keys.push(`${request.key}:${request.action}`)
      },
    }))
    const owner = makeAgent('a')
    computer.grant(owner, ComputerAppId('notes'), 'session')
    const controller = new AbortController()
    await computer.key(owner, ComputerWindowId('w1'), { key: 'Shift', action: 'down' }, controller.signal)
    controller.abort()
    await computer.releaseHeldKeys(owner)
    expect(keys).toEqual(['Shift:down', 'Shift:up'])
  })

  it('waits for in-flight key-down before releasing it during disposal', async () => {
    const { ctx, computer } = await mount()
    const entered = Promise.withResolvers<undefined>()
    const finish = Promise.withResolvers<undefined>()
    const keys: string[] = []
    computer.registerProvider(makeProvider('local', available, {
      key: async (request) => {
        if (request.action === 'down') {
          entered.resolve(undefined)
          await finish.promise
        }
        keys.push(`${request.key}:${request.action}`)
      },
    }))
    const owner = makeAgent('a')
    computer.grant(owner, ComputerAppId('notes'), 'session')
    const down = computer.key(owner, ComputerWindowId('w1'), { key: 'Shift', action: 'down' })
    await entered.promise
    const disposal = ctx.fiber.dispose()
    finish.resolve(undefined)
    await Promise.all([down, disposal])
    expect(keys).toEqual(['Shift:down', 'Shift:up'])
  })

  it('releases held keys before fiber disposal settles', async () => {
    const { ctx, computer } = await mount()
    const keys: string[] = []
    computer.registerProvider(makeProvider('local', available, {
      key: async (request) => {
        await Promise.resolve()
        keys.push(`${request.key}:${request.action}`)
      },
    }))
    const owner = makeAgent('a')
    computer.grant(owner, ComputerAppId('notes'), 'session')
    await computer.key(owner, ComputerWindowId('w1'), { key: 'Shift', action: 'down' })
    await ctx.fiber.dispose()
    expect(keys).toEqual(['Shift:down', 'Shift:up'])
  })
})

describe('status helpers', () => {
  it('covers connection labels, recovery copy, and platform permission advice', () => {
    expect(connectionState(false, false, false)).toBe('unconfigured')
    expect(connectionState(true, false, false)).toBe('configured')
    expect(connectionState(true, true, true)).toBe('live')
    expect(connectionState(true, true, false)).toBe('probe-failed')
    expect(recoveryForComputerCode('COMPUTER_PROVIDER_CONFIGURED_MISSING')).toContain('not registered')
    expect(recoveryForComputerCode('COMPUTER_PROVIDER_CONFIGURED_MISSING', 'local')).toContain('local')
    expect(recoveryForComputerCode('COMPUTER_PROVIDER_CONFIGURED_UNAVAILABLE')).toContain('unavailable')
    expect(recoveryForComputerCode('COMPUTER_PROVIDER_CONFIGURED_UNAVAILABLE', 'local')).toContain('local')
    expect(recoveryForComputerCode('COMPUTER_PROVIDER_AMBIGUOUS')).toContain('Multiple')
    expect(recoveryForComputerCode('COMPUTER_UNSUPPORTED')).toContain('computer_status')
    expect(recoveryForComputerCode('COMPUTER_GEOMETRY_CHANGED')).toContain('computer_observe')
    expect(recoveryForComputerCode('COMPUTER_TARGET_MISMATCH')).toContain('declared window')
    expect(recoveryForComputerCode('COMPUTER_INPUT_BUSY')).toContain('holding keyboard')
    expect(recoveryForComputerCode('COMPUTER_UNKNOWN')).toContain('Inspect')
    const denied = {
      accessibility: 'denied' as const,
      screenRecording: 'denied' as const,
      inputInjection: 'denied' as const,
    }
    expect(permissionIssues(denied, 'linux').some(issue => issue.recovery.includes('Wayland'))).toBe(true)
    expect(permissionIssues(denied, 'win32')[0]?.recovery).toContain('Windows')
    expect(permissionIssues(denied, 'darwin').some(issue => issue.recovery.includes('Screen Recording'))).toBe(true)
  })
})

describe('ComputerError', () => {
  it('is a HarnessError with a stable code', () => {
    const error = new ComputerError('nope', 'COMPUTER_APP_DENIED')
    expect(error).toBeInstanceOf(Error)
    expect(error.code).toBe('COMPUTER_APP_DENIED')
    expect(error.name).toBe('ComputerError')
  })
})
