import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import ComputerRuntime, {
  ComputerAppId,
  ComputerError,
  ComputerWindowId,
  type ComputerApp,
  type ComputerProvider,
  type ComputerWindow,
} from '@deepseek-ai/dsh-computer-use'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolComputer from '@deepseek-ai/dsh-tool-computer-use'
import {
  SNAPSHOT_REF,
  approveComputerAction,
  buildComputerSnapshot,
  computerMetaFromValue,
  ensureAppGrant,
  formatComputerSnapshot,
  presentComputerCall,
  presentComputerResult,
  resolveRef,
} from '@deepseek-ai/dsh-tool-computer-use'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'

const signal = new AbortController().signal

function agent(id = 'owner'): Agent {
  return {
    id: SessionId(id),
    session: Session.create(SessionId(id)),
    options: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  } as unknown as Agent
}

function app(id: string): ComputerApp {
  return { id: ComputerAppId(id), name: id, pid: 4000 }
}

function windowOf(id: string, appId = 'notes'): ComputerWindow {
  return {
    id: ComputerWindowId(id),
    appId: ComputerAppId(appId),
    title: 'Notes',
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    focused: true,
  }
}

function makeProvider(extras: Partial<ComputerProvider> = {}): ComputerProvider {
  const notes = app('notes')
  const win = windowOf('w1')
  return {
    id: 'fake',
    available: () => true,
    capabilities: () => ['a11y', 'screenshot', 'input', 'clipboard'],
    permissions: () => Promise.resolve({ accessibility: 'granted', screenRecording: 'granted', inputInjection: 'granted' }),
    listApps: () => Promise.resolve([notes]),
    listWindows: () => Promise.resolve([win]),
    launchApp: request => Promise.resolve({ ...notes, name: request.name }),
    focusWindow: () => Promise.resolve(),
    windowAtPoint: () => Promise.resolve(win),
    snapshot: request => Promise.resolve({
      windowId: request.windowId,
      appId: ComputerAppId('notes'),
      title: 'Notes',
      truncated: false,
      nodes: [{
        handle: 'n1',
        role: 'button',
        name: 'OK',
        bounds: { x: 10, y: 10, width: 20, height: 10 },
        states: [],
        supportsPress: true,
        supportsSetValue: false,
        secure: false,
        children: [{
          handle: 'n2',
          role: 'textbox',
          name: 'Password',
          value: 'secret',
          bounds: { x: 0, y: 0, width: 40, height: 12 },
          states: [],
          supportsPress: false,
          supportsSetValue: true,
          secure: true,
        }],
      }],
    }),
    screenshot: () => Promise.resolve({
      png: new Uint8Array([1, 2, 3, 4]),
      width: 100,
      height: 50,
      scale: 2,
      bounds: { x: 0, y: 0, width: 800, height: 600 },
    }),
    press: () => Promise.resolve(),
    setValue: () => Promise.resolve(),
    click: () => Promise.resolve(),
    type: () => Promise.resolve(),
    key: () => Promise.resolve(),
    scroll: () => Promise.resolve(),
    drag: () => Promise.resolve(),
    move: () => Promise.resolve(),
    clipboardRead: () => Promise.resolve('clip'),
    clipboardWrite: () => Promise.resolve(),
    ...extras,
  }
}

async function mount(opts: {
  config?: ToolComputer.Config
  approval?: (req: { toolName: string }) => Promise<ApprovalOutcome>
  questions?: string
  vision?: boolean
  attachments?: boolean
  provider?: ComputerProvider
  llm?: boolean
} = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(ComputerRuntime)
  ctx.computer.registerProvider(opts.provider ?? makeProvider())
  if (opts.approval) {
    ctx.provide('approval', { request: (req: { toolName: string }) => opts.approval!(req) })
  }
  if (opts.questions !== undefined) {
    ctx.provide('userQuestions', {
      ask: async () => ({ answers: [{ id: 'computer-app-grant', selected: [opts.questions!] }] }),
    })
  }
  if (opts.attachments !== false) {
    ctx.provide('attachments', {
      saveImage: async (input: { data: Uint8Array }) => ({
        attachmentId: 'att-1',
        mediaType: 'image/png',
        bytes: input.data.byteLength,
        width: 100,
        height: 50,
      }),
    })
  }
  if (opts.llm !== false) {
    ctx.provide('llm', {
      resolveModelInfo: async () => ({
        inputModalities: opts.vision === true ? ['text', 'image'] : ['text'],
      }),
    })
  }
  const fiber = await ctx.plugin(ToolComputer, opts.config ?? { approval: 'never' })
  const owner = agent()
  let counter = 0
  const call = (name: string, args: unknown) => ctx.tools.execute({
    signal,
    callId: ToolCallId(`call-${++counter}`),
    name,
    arguments: args,
    agent: owner,
  })
  return { ctx, fiber, call, owner }
}

describe('snapshot builder', () => {
  it('mints epoch refs, redacts secure values, filters, and resolves', () => {
    const tree = {
      windowId: ComputerWindowId('w1'),
      appId: ComputerAppId('notes'),
      title: 'Notes',
      truncated: false,
      nodes: [{
        handle: 'n1',
        role: 'button',
        name: 'OK',
        bounds: { x: 0, y: 0, width: 1, height: 1 },
        states: [],
        supportsPress: true,
        supportsSetValue: false,
        secure: false,
        children: [{
          handle: 'n2',
          role: 'textbox',
          name: 'Password',
          value: 'secret',
          bounds: { x: 0, y: 0, width: 1, height: 1 },
          states: [],
          supportsPress: false,
          supportsSetValue: true,
          secure: true,
        }],
      }],
    }
    const snapshot = buildComputerSnapshot(tree, { epoch: 4, maxNodes: 10 })
    expect(snapshot.nodes[0]?.ref).toBe('4-e0')
    expect(snapshot.nodes[1]?.value).toBe('<redacted>')
    expect(SNAPSHOT_REF.test('4-e0')).toBe(true)
    expect(resolveRef('4-e0', snapshot).handle).toBe('n1')
    expect(() => resolveRef('nope', snapshot)).toThrow(ComputerError)
    expect(() => resolveRef('2-e0', snapshot)).toThrow(/stale/)
    expect(() => resolveRef('4-e9', snapshot)).toThrow(/unknown/)
    const filtered = buildComputerSnapshot(tree, { epoch: 1, maxNodes: 1, query: 'password' })
    expect(filtered.nodes[0]?.name).toBe('Password')
    expect(filtered.truncated).toBe(true)
    const emptyName = buildComputerSnapshot({
      ...tree,
      nodes: [{
        handle: 'n0',
        role: 'generic',
        name: '',
        bounds: { x: 0, y: 0, width: 1, height: 1 },
        states: [],
        supportsPress: false,
        supportsSetValue: false,
        secure: false,
      }],
    }, { epoch: 1, maxNodes: 10 })
    expect(emptyName.text).toContain('- generic [1-e0]')
    const visible = buildComputerSnapshot({
      ...tree,
      truncated: true,
      nodes: [{
        handle: 'n3',
        role: 'textbox',
        name: 'Title',
        value: 'hello',
        bounds: { x: 0, y: 0, width: 1, height: 1 },
        states: [],
        supportsPress: false,
        supportsSetValue: true,
        secure: false,
      }],
    }, { epoch: 1, maxNodes: 10 })
    expect(visible.nodes[0]?.value).toBe('hello')
    expect(visible.truncated).toBe(true)
    const capped = buildComputerSnapshot({
      ...tree,
      nodes: [{
        handle: 'g',
        role: 'group',
        name: 'skip',
        bounds: { x: 0, y: 0, width: 1, height: 1 },
        states: [],
        supportsPress: false,
        supportsSetValue: false,
        secure: false,
        children: [{
          handle: 'a',
          role: 'button',
          name: 'One',
          bounds: { x: 0, y: 0, width: 1, height: 1 },
          states: [],
          supportsPress: true,
          supportsSetValue: false,
          secure: false,
        }, {
          handle: 'b',
          role: 'button',
          name: 'Two',
          bounds: { x: 0, y: 0, width: 1, height: 1 },
          states: [],
          supportsPress: true,
          supportsSetValue: false,
          secure: false,
        }],
      }],
    }, { epoch: 1, maxNodes: 1, query: 'button' })
    expect(capped.nodes).toHaveLength(1)
    expect(capped.truncated).toBe(true)
  })
})

describe('presenters', () => {
  it('builds cards and meta', () => {
    expect(presentComputerCall('X', 'fetch').title).toBe('X')
    expect(presentComputerResult('Y', 'z').title).toBe('Y')
    expect(presentComputerResult('Y').content).toBeUndefined()
    expect(computerMetaFromValue({ app: 'Notes', windowTitle: 'T', windowId: 'w1' })).toEqual({
      app: 'Notes',
      windowTitle: 'T',
      windowId: 'w1',
    })
    expect(computerMetaFromValue({})).toEqual({})
    expect(formatComputerSnapshot({ app: 'A', windowTitle: 'T', text: '- button', truncated: true })).toContain('truncated')
  })
})

describe('approval helpers', () => {
  it('skips when mode is not always and maps every approval outcome', async () => {
    await approveComputerAction({ mode: 'never', toolName: 'computer_click', reason: 'x' })
    await expect(approveComputerAction({ mode: 'always', toolName: 'computer_click', reason: 'x' }))
      .rejects.toThrow(/no approval service/)
    await expect(approveComputerAction({
      mode: 'always',
      toolName: 'computer_click',
      reason: 'x',
      approval: { request: async () => 'allowed-once' },
    })).rejects.toThrow(/no agent/)
    const owner = agent()
    await approveComputerAction({
      mode: 'always',
      toolName: 'computer_click',
      reason: 'x',
      approval: { request: async () => 'allowed-once' },
      agent: owner,
      callId: ToolCallId('c1'),
      signal,
    })
    await expect(approveComputerAction({
      mode: 'always',
      toolName: 'computer_click',
      reason: 'x',
      approval: { request: async () => 'rejected' },
      agent: owner,
    })).rejects.toThrow(/rejected/)
    await expect(approveComputerAction({
      mode: 'always',
      toolName: 'computer_click',
      reason: 'x',
      approval: { request: async () => 'cancelled' },
      agent: owner,
    })).rejects.toThrow(/cancelled/)
    await expect(approveComputerAction({
      mode: 'always',
      toolName: 'computer_click',
      reason: 'x',
      approval: { request: async () => 'unavailable' },
      agent: owner,
    })).rejects.toThrow(/no approval channel/)
    await expect(approveComputerAction({
      mode: 'always',
      toolName: 'computer_click',
      reason: 'x',
      approval: { request: async () => 'bogus' as ApprovalOutcome },
      agent: owner,
    })).rejects.toThrow(/unhandled approval outcome/)
  })

  it('asks for a grant without callId or signal and maps userQuestions answers', async () => {
    const ctx = new Context()
    await ctx.plugin(ComputerRuntime)
    ctx.computer.registerProvider(makeProvider())
    const owner = agent()
    const questions = {
      ask: async () => ({ answers: [{ id: 'computer-app-grant', selected: ['Allow once'] }] }),
    }
    await ensureAppGrant({
      computer: ctx.computer,
      owner,
      app: app('notes'),
      mode: 'apps',
      grantScope: 'session',
      userQuestions: questions as never,
      toolName: 'computer_focus',
    })
    expect(ctx.computer.hasGrant(owner, ComputerAppId('notes'))).toBe(true)
    const approval = { request: async () => 'allowed-once' as ApprovalOutcome }
    const other = agent('other')
    await ensureAppGrant({
      computer: ctx.computer,
      owner: other,
      app: app('notes'),
      mode: 'apps',
      grantScope: 'session',
      approval,
      toolName: 'computer_focus',
    })
    expect(ctx.computer.hasGrant(other, ComputerAppId('notes'))).toBe(true)
  })
})

describe('computer tools', () => {
  it('lists apps, launches, focuses, snapshots, and clicks by ref', async () => {
    const { call } = await mount()
    const apps = await call('computer_apps', {})
    expect(apps.isError).toBe(false)
    const launched = await call('computer_launch', { app: 'Notes' })
    expect(launched.isError).toBe(false)
    const focused = await call('computer_focus', { windowId: 'w1' })
    expect(focused.isError).toBe(false)
    expect((await call('computer_apps', {})).isError).toBe(false)
    const snap = await call('computer_snapshot', { windowId: 'w1', query: 'button' })
    expect(snap.isError).toBe(false)
    expect(String((snap.value as { text: string }).text)).toContain('[1-e0]')
    const clicked = await call('computer_click', { windowId: 'w1', ref: '1-e0' })
    expect(clicked.isError).toBe(false)
  })

  it('types, keys, scrolls, drags, moves, waits, and uses the clipboard', async () => {
    const { call } = await mount()
    const typedSnap = await call('computer_snapshot', { windowId: 'w1' })
    const passwordRef = /\[(\d+-e1)\]/.exec(String((typedSnap.value as { text: string }).text))?.[1]
    expect((await call('computer_type', { windowId: 'w1', ref: passwordRef, text: 'hi', submit: true })).isError).toBe(false)
    expect((await call('computer_type', { windowId: 'w1', text: 'x' })).isError).toBe(false)
    expect((await call('computer_press_key', { windowId: 'w1', key: 'a', modifiers: ['shift'], repeat: 2 })).isError).toBe(false)
    const scrolledSnap = await call('computer_snapshot', { windowId: 'w1' })
    const scrollRef = /\[(\d+-e0)\]/.exec(String((scrolledSnap.value as { text: string }).text))?.[1]
    expect((await call('computer_scroll', { windowId: 'w1', ref: scrollRef, direction: 'up', amount: 2 })).isError).toBe(false)
    expect((await call('computer_scroll', { windowId: 'w1', x: 1, y: 1, direction: 'down', amount: 1 })).isError).toBe(false)
    expect((await call('computer_drag', { windowId: 'w1', from: { x: 1, y: 1 }, to: { x: 2, y: 2 }, space: 'screen' })).isError).toBe(false)
    expect((await call('computer_mouse_move', { windowId: 'w1', x: 3, y: 4, space: 'screen' })).isError).toBe(false)
    expect((await call('computer_wait_for', { windowId: 'w1', text: 'OK', title: 'Notes' })).isError).toBe(false)
    expect((await call('computer_wait_for', { windowId: 'w1', text: 'missing', timeoutMs: 1 })).value).toMatchObject({ matched: false })
    expect((await call('computer_clipboard', { action: 'read' })).value).toMatchObject({ text: 'clip' })
    expect((await call('computer_clipboard', { action: 'write', text: 'z' })).isError).toBe(false)
    expect((await call('computer_clipboard', { action: 'write' })).isError).toBe(true)
  })

  it('clicks coordinates, maps screenshot space, and refuses a screenshot on a text-only route', async () => {
    const { call } = await mount()
    await call('computer_snapshot', { windowId: 'w1' })
    const click = await call('computer_click', { windowId: 'w1', x: 10, y: 10 })
    expect(click.isError).toBe(false)
    const shot = await call('computer_screenshot', { windowId: 'w1', region: { x: 0, y: 0, width: 10, height: 10 } })
    expect(shot.isError).toBe(true)
    expect(shot.content[0]).toMatchObject({ type: 'text' })
  })

  it('saves a screenshot on a vision route and downscales logical size', async () => {
    const { call } = await mount({ vision: true, config: { approval: 'never', screenshotMaxWidth: 50 } })
    const shot = await call('computer_screenshot', { windowId: 'w1' })
    expect(shot.isError).toBe(false)
    await call('computer_click', { windowId: 'w1', x: 25, y: 25 })
    const full = await call('computer_screenshot', {})
    expect(full.isError).toBe(false)
  })

  it('refuses screenshots when capture is disabled, attachments are missing, or bytes exceed the cap', async () => {
    const disabled = await mount({ vision: true, config: { approval: 'never', allowScreenCapture: false } })
    expect((await disabled.call('computer_screenshot', {})).isError).toBe(true)
    const missing = await mount({ vision: true, attachments: false })
    expect((await missing.call('computer_screenshot', {})).isError).toBe(true)
    const huge = await mount({
      vision: true,
      config: { approval: 'never', screenshotMaxBytes: 1 },
    })
    expect((await huge.call('computer_screenshot', { windowId: 'w1' })).isError).toBe(true)
  })

  it('asks userQuestions for a first-use grant and records a session event', async () => {
    const { call, owner } = await mount({ config: { approval: 'apps' }, questions: 'Allow for this session' })
    const result = await call('computer_focus', { windowId: 'w1' })
    expect(result.isError).toBe(false)
    expect(owner.session.snapshotEvents().some(event => event.type === 'computer/app-grant')).toBe(true)
    expect((await call('computer_focus', { windowId: 'w1' })).isError).toBe(false)
  })

  it('maps once grants, denials, and approval fallbacks', async () => {
    const once = await mount({ config: { approval: 'apps' }, questions: 'Allow once' })
    expect((await once.call('computer_focus', { windowId: 'w1' })).isError).toBe(false)
    const denied = await mount({ config: { approval: 'apps' }, questions: 'Deny' })
    expect((await denied.call('computer_focus', { windowId: 'w1' })).isError).toBe(true)
    const fallback = await mount({
      config: { approval: 'apps' },
      approval: async () => 'allowed-once',
    })
    expect((await fallback.call('computer_focus', { windowId: 'w1' })).isError).toBe(false)
    const rejected = await mount({
      config: { approval: 'apps' },
      approval: async () => 'rejected',
    })
    expect((await rejected.call('computer_focus', { windowId: 'w1' })).isError).toBe(true)
    const cancelled = await mount({
      config: { approval: 'apps' },
      approval: async () => 'cancelled',
    })
    expect((await cancelled.call('computer_focus', { windowId: 'w1' })).isError).toBe(true)
    const unavailable = await mount({
      config: { approval: 'apps' },
      approval: async () => 'unavailable',
    })
    expect((await unavailable.call('computer_focus', { windowId: 'w1' })).isError).toBe(true)
    const bogus = await mount({
      config: { approval: 'apps' },
      approval: async () => 'bogus' as ApprovalOutcome,
    })
    expect((await bogus.call('computer_focus', { windowId: 'w1' })).isError).toBe(true)
    const closed = await mount({ config: { approval: 'apps' } })
    expect((await closed.call('computer_focus', { windowId: 'w1' })).isError).toBe(true)
  })

  it('asks per action when approval is always', async () => {
    const { call } = await mount({
      config: { approval: 'always' },
      approval: async () => 'allowed-once',
      questions: 'Allow for this session',
    })
    expect((await call('computer_launch', { app: 'Notes' })).isError).toBe(false)
  })

  it('requires an agent, a snapshot before ref actions, and x/y without a ref', async () => {
    const { ctx } = await mount()
    const missing = await ctx.tools.execute({
      signal,
      callId: ToolCallId('no-agent'),
      name: 'computer_apps',
      arguments: {},
    })
    expect(missing.isError).toBe(true)
    const { call } = await mount()
    expect((await call('computer_click', { windowId: 'w1', ref: '1-e0' })).isError).toBe(true)
    expect((await call('computer_click', { windowId: 'w1' })).isError).toBe(true)
    expect((await call('computer_type', { windowId: 'w1', ref: '1-e0', text: 'x' })).isError).toBe(true)
    expect((await call('computer_scroll', { windowId: 'w1', ref: '1-e0', direction: 'left', amount: 1 })).isError).toBe(true)
  })

  it('clicks a ref without press support at the node center and types without setValue', async () => {
    const { call } = await mount({
      provider: makeProvider({
        snapshot: request => Promise.resolve({
          windowId: request.windowId,
          appId: ComputerAppId('notes'),
          title: 'Notes',
          truncated: false,
          nodes: [{
            handle: 'n1',
            role: 'generic',
            name: 'Box',
            bounds: { x: 0, y: 0, width: 10, height: 10 },
            states: [],
            supportsPress: false,
            supportsSetValue: false,
            secure: false,
          }],
        }),
      }),
    })
    await call('computer_snapshot', { windowId: 'w1' })
    expect((await call('computer_click', { windowId: 'w1', ref: '1-e0', button: 'right', count: 2 })).isError).toBe(false)
    const afterRight = await call('computer_snapshot', { windowId: 'w1' })
    const middleRef = /\[(\d+-e0)\]/.exec(String((afterRight.value as { text: string }).text))?.[1]
    expect((await call('computer_click', { windowId: 'w1', ref: middleRef, button: 'middle' })).isError).toBe(false)
    const afterMiddle = await call('computer_snapshot', { windowId: 'w1' })
    const leftRef = /\[(\d+-e0)\]/.exec(String((afterMiddle.value as { text: string }).text))?.[1]
    expect((await call('computer_click', { windowId: 'w1', ref: leftRef })).isError).toBe(false)
    const afterClick = await call('computer_snapshot', { windowId: 'w1' })
    const typeRef = /\[(\d+-e0)\]/.exec(String((afterClick.value as { text: string }).text))?.[1]
    expect((await call('computer_type', { windowId: 'w1', ref: typeRef, text: 'hi' })).isError).toBe(false)
  })

  it('leaves tools unregistered when disabled and rejects non-positive caps', async () => {
    const { ctx } = await mount({ config: { enabled: false } })
    expect(ctx.tools.schemas().map(schema => schema.name)).not.toContain('computer_apps')
    const ctx2 = new Context()
    await ctx2.plugin(SystemPrompt)
    await ctx2.plugin(ToolRuntime)
    await ctx2.plugin(ComputerRuntime)
    expect(() => ToolComputer.apply(ctx2, { snapshotMaxNodes: 0, screenshotMaxWidth: 1, screenshotMaxBytes: 1, timeoutMs: 1 })).toThrow(/snapshotMaxNodes/)
    expect(() => ToolComputer.apply(ctx2, { snapshotMaxNodes: 1, screenshotMaxWidth: 0, screenshotMaxBytes: 1, timeoutMs: 1 })).toThrow(/screenshotMaxWidth/)
    expect(() => ToolComputer.apply(ctx2, { snapshotMaxNodes: 1, screenshotMaxWidth: 1, screenshotMaxBytes: 0, timeoutMs: 1 })).toThrow(/screenshotMaxBytes/)
    expect(() => ToolComputer.apply(ctx2, { snapshotMaxNodes: 1, screenshotMaxWidth: 1, screenshotMaxBytes: 1, timeoutMs: 0 })).toThrow(/timeoutMs/)
  })

  it('disposes with the fiber', async () => {
    const { ctx, fiber } = await mount()
    expect(ctx.tools.schemas().some(schema => schema.name === 'computer_apps')).toBe(true)
    await fiber.dispose()
  })

  it('covers presenters, gone windows, unresolved routes, and screenshot mapping', async () => {
    const { ctx, call } = await mount({ vision: true, config: { approval: 'never', screenshotMaxWidth: 50 } })
    const presenterArgs: Record<string, Record<string, unknown>> = {
      computer_apps: {},
      computer_launch: { app: 'Notes' },
      computer_focus: { windowId: 'w1' },
      computer_snapshot: { windowId: 'w1' },
      computer_screenshot: { windowId: 'w1' },
      computer_click: { windowId: 'w1', ref: '1-e0' },
      computer_type: { windowId: 'w1', text: 'x' },
      computer_press_key: { windowId: 'w1', key: 'a' },
      computer_scroll: { windowId: 'w1', direction: 'down', amount: 1 },
      computer_drag: { windowId: 'w1', from: { x: 1, y: 1 }, to: { x: 2, y: 2 } },
      computer_mouse_move: { windowId: 'w1', x: 1, y: 2 },
      computer_wait_for: { windowId: 'w1', text: 'OK' },
      computer_clipboard: { action: 'read' },
    }
    for (const schema of ctx.tools.schemas()) {
      const tool = ctx.tools.get(schema.name)
      const args = presenterArgs[schema.name] ?? {}
      tool?.presentCall?.(args)
      tool?.presentResult?.(args, { isError: false, content: [] })
      tool?.isConcurrencySafe?.(args)
      tool?.output.render(args, {
        apps: [],
        typed: false,
        matched: true,
        windowTitle: 'Notes',
        action: 'write',
        windowId: 'w1',
        app: 'Notes',
        text: '- button',
        truncated: false,
        attachmentId: 'att-1',
        mediaType: 'image/png',
        bytes: 4,
        width: 10,
        height: 10,
        scale: 1,
        x: 1,
        y: 2,
        key: 'a',
      } as JsonValue)
      tool?.output.render(args, {
        apps: [{
          appId: 'notes',
          name: 'Notes',
          granted: false,
          windows: [{ windowId: 'w1', title: 'Notes', focused: false }],
        }],
        typed: true,
        matched: false,
        windowTitle: 'Notes',
        action: 'read',
        text: 'clip',
        truncated: true,
        app: 'Notes',
        attachmentId: 'att-1',
        mediaType: 'image/png',
        bytes: 4,
        width: 10,
        height: 10,
        scale: 1,
      } as JsonValue)
      tool?.output.render(args, { action: 'read', apps: [] } as JsonValue)
      tool?.output.presentationMeta?.(args, { app: 'Notes', windowTitle: 'Notes', windowId: 'w1' } as JsonValue)
    }
    ctx.tools.get('computer_click')?.presentCall?.({ windowId: 'w1', x: 1, y: 2 })
    ctx.tools.get('computer_clipboard')?.presentCall?.({ action: 'write' })

    const shot = await call('computer_screenshot', { windowId: 'w1', region: { x: 0, y: 0, width: 10, height: 10 } })
    expect(shot.isError).toBe(false)
    expect((await call('computer_click', { windowId: 'w1', x: 10, y: 10 })).isError).toBe(false)
    expect((await call('computer_click', { windowId: 'w1', x: 1, y: 1, space: 'screen', button: 'middle' })).isError).toBe(false)
    expect((await call('computer_press_key', { windowId: 'w1', key: 'b' })).isError).toBe(false)
    expect((await call('computer_wait_for', { windowId: 'w1' })).isError).toBe(false)
    expect((await call('computer_scroll', { windowId: 'w1', x: 1, y: 1, direction: 'sideways', amount: 1 })).isError).toBe(false)
    expect((await call('computer_scroll', { windowId: 'w1', x: 2, y: 2, direction: 'left', amount: 1, space: 'screen' })).isError).toBe(false)
    expect((await call('computer_drag', { windowId: 'w1', from: { x: 1, y: 1 }, to: { x: 2, y: 2 } })).isError).toBe(false)
    expect((await call('computer_mouse_move', { windowId: 'w1', x: 3, y: 4 })).isError).toBe(false)

    const goneWindow = await mount({
      provider: makeProvider({ listWindows: () => Promise.resolve([]) }),
    })
    expect((await goneWindow.call('computer_focus', { windowId: 'w1' })).isError).toBe(true)
    const goneApp = await mount({
      provider: makeProvider({ listApps: () => Promise.resolve([]) }),
    })
    expect((await goneApp.call('computer_focus', { windowId: 'w1' })).isError).toBe(true)

    const zero = await mount({
      vision: true,
      provider: makeProvider({
        screenshot: () => Promise.resolve({
          png: new Uint8Array([1]),
          width: 0,
          height: 0,
          scale: 1,
          bounds: { x: 0, y: 0, width: 0, height: 0 },
        }),
      }),
    })
    expect((await zero.call('computer_screenshot', { windowId: 'w1' })).isError).toBe(false)
    expect((await zero.call('computer_click', { windowId: 'w1', x: 3, y: 4 })).isError).toBe(false)

    const noLlm = await mount({ llm: false, vision: true })
    expect((await noLlm.call('computer_screenshot', {})).isError).toBe(true)

    const unresolved = await noLlm.ctx.tools.execute({
      signal,
      callId: ToolCallId('no-model'),
      name: 'computer_screenshot',
      arguments: {},
      agent: { id: SessionId('owner'), session: Session.create(SessionId('owner')), options: {} } as unknown as Agent,
    })
    expect(unresolved.isError).toBe(true)
  })
})
