import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import ComputerRuntime, {
  ComputerAppId,
  ComputerDisplayId,
  ComputerError,
  ComputerWindowId,
  type ComputerApp,
  type ComputerProvider,
  type ComputerSnapshot,
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
  viewComputerSnapshot,
} from '@deepseek-ai/dsh-tool-computer-use'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'

function textOf(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
}

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
    listDisplays: () => Promise.resolve([{
      id: ComputerDisplayId('d1'),
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      scale: 1,
      primary: true,
    }]),
    launchApp: request => Promise.resolve({ ...notes, name: request.name }),
    focusWindow: () => Promise.resolve(),
    setWindowBounds: () => Promise.resolve(),
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
        actions: ['activate'],
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
          actions: ['setValue'],
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
    focusElement: () => Promise.resolve(),
    action: () => Promise.resolve(),
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
  attachmentSize?: { width: number; height: number }
  provider?: ComputerProvider
  llm?: boolean
  computerConfig?: ConstructorParameters<typeof ComputerRuntime>[1]
  skipProvider?: boolean
} = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(ComputerRuntime, opts.computerConfig ?? {})
  if (opts.skipProvider !== true) {
    ctx.computer.registerProvider(opts.provider ?? makeProvider())
  }
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
        width: opts.attachmentSize?.width ?? 100,
        height: opts.attachmentSize?.height ?? 50,
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
    const tree: ComputerSnapshot = {
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
        actions: ['activate'],
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
          actions: ['setValue'],
          secure: true,
        }],
      }],
    }
    const snapshot = buildComputerSnapshot(tree, { observationId: '4', maxNodes: 10 })
    expect(snapshot.nodes[0]?.ref).toBe('4-e0')
    expect(snapshot.nodes[1]?.value).toBe('<redacted>')
    expect(SNAPSHOT_REF.test('4-e0')).toBe(true)
    expect(resolveRef('4-e0', snapshot).handle).toBe('n1')
    expect(() => resolveRef('nope', snapshot)).toThrow(ComputerError)
    expect(() => resolveRef('2-e0', snapshot)).toThrow(/stale/)
    expect(() => resolveRef('4-e9', snapshot)).toThrow(/unknown/)
    const filtered = buildComputerSnapshot(tree, { observationId: '1', maxNodes: 10, query: 'password' })
    expect(filtered.nodes[0]?.name).toBe('Password')
    expect(filtered.nodes[0]?.ref).toBe('1-e1')
    expect(filtered.truncated).toBe(false)
    expect(viewComputerSnapshot(filtered, 'ok').nodes[0]?.ref).toBe('1-e0')
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
        actions: [],
        secure: false,
      }],
    }, { observationId: '1', maxNodes: 10 })
    expect(emptyName.text).toContain('- generic [1-e0]')
    const longName = buildComputerSnapshot({
      ...tree,
      nodes: [{
        handle: 'n4',
        role: 'button',
        name: 'Hello',
        bounds: { x: 0, y: 0, width: 1, height: 1 },
        states: [],
        supportsPress: true,
        supportsSetValue: false,
        actions: ['activate'],
        secure: false,
      }],
    }, { observationId: '1', maxNodes: 10, maxFieldChars: 2 })
    expect(longName.nodes[0]?.name).toBe('He')
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
        actions: ['setValue'],
        secure: false,
      }],
    }, { observationId: '1', maxNodes: 10 })
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
        actions: [],
        secure: false,
        children: [{
          handle: 'a',
          role: 'button',
          name: 'One',
          bounds: { x: 0, y: 0, width: 1, height: 1 },
          states: [],
          supportsPress: true,
          supportsSetValue: false,
          actions: ['activate'],
          secure: false,
        }, {
          handle: 'b',
          role: 'button',
          name: 'Two',
          bounds: { x: 0, y: 0, width: 1, height: 1 },
          states: [],
          supportsPress: true,
          supportsSetValue: false,
          actions: ['activate'],
          secure: false,
        }],
      }],
    }, { observationId: '1', maxNodes: 2, query: 'button' })
    expect(capped.nodes).toHaveLength(1)
    expect(capped.truncated).toBe(true)
    const deep = buildComputerSnapshot(tree, { observationId: '1', maxNodes: 10, maxDepth: 0 })
    expect(deep.nodes).toHaveLength(1)
    expect(deep.truncated).toBe(true)
    const subtree = buildComputerSnapshot(tree, { observationId: '1', maxNodes: 10, rootHandle: 'n2' })
    expect(subtree.nodes[0]?.handle).toBe('n2')
    expect(() => buildComputerSnapshot(tree, { observationId: '1', maxNodes: 10, rootHandle: 'missing' }))
      .toThrow(/unknown snapshot handle/)
    const advertised = buildComputerSnapshot({
      ...tree,
      nodes: [{
        handle: 'x',
        role: 'button',
        name: 'Go',
        bounds: { x: 0, y: 0, width: 1, height: 1 },
        states: [],
        supportsPress: true,
        supportsSetValue: false,
        actions: ['activate'],
        secure: false,
      }, {
        handle: 'y',
        role: 'textbox',
        name: 'Field',
        bounds: { x: 0, y: 0, width: 1, height: 1 },
        states: [],
        supportsPress: false,
        supportsSetValue: true,
        actions: ['setValue'],
        secure: false,
      }, {
        handle: 'z',
        role: 'checkbox',
        name: 'On',
        bounds: { x: 0, y: 0, width: 1, height: 1 },
        states: [],
        supportsPress: false,
        supportsSetValue: false,
        actions: ['toggle'],
        secure: false,
      }],
    }, { observationId: '1', maxNodes: 10 })
    expect(advertised.nodes.map(node => node.actions)).toEqual([['activate'], ['setValue'], ['toggle']])
    expect(advertised.nodes[2]?.supportsPress).toBe(true)
    const leaf = buildComputerSnapshot({
      ...tree,
      nodes: [{
        handle: 'leaf',
        role: 'button',
        name: 'Only',
        bounds: { x: 0, y: 0, width: 1, height: 1 },
        states: [],
        supportsPress: true,
        supportsSetValue: false,
        actions: ['activate'],
        secure: false,
      }],
    }, { observationId: '1', maxNodes: 10, maxDepth: 0 })
    expect(leaf.truncated).toBe(false)
  })
})

describe('presenters', () => {
  it('builds cards and meta', () => {
    expect(presentComputerCall('X', 'fetch').title).toBe('X')
    expect(presentComputerResult('Y', 'z').title).toBe('Y')
    expect(presentComputerResult('Y').content).toBeUndefined()
    expect(computerMetaFromValue({
      app: 'Notes',
      windowTitle: 'T',
      windowId: 'w1',
      observationId: 'w1:1',
      observationError: 'boom',
    })).toEqual({
      app: 'Notes',
      windowTitle: 'T',
      windowId: 'w1',
      observationId: 'w1:1',
      observationError: 'boom',
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
    expect((snap.value as { text: string }).text).toContain('[1-e0]')
    const clicked = await call('computer_click', { windowId: 'w1', ref: '1-e0' })
    expect(clicked.isError).toBe(false)
    const observed = await call('computer_observe', { windowId: 'w1', screenshot: true })
    expect(observed.isError).toBe(false)
    expect(observed.value).not.toHaveProperty('attachmentId')
  })

  it('types, keys, scrolls, drags, moves, waits, and uses the clipboard', async () => {
    const { call } = await mount()
    const typedSnap = await call('computer_snapshot', { windowId: 'w1' })
    const passwordRef = /\[(\d+-e1)\]/.exec((typedSnap.value as { text: string }).text)?.[1]
    expect((await call('computer_type', { windowId: 'w1', ref: passwordRef, text: 'hi', submit: true })).isError).toBe(false)
    expect((await call('computer_type', { windowId: 'w1', text: 'x' })).isError).toBe(false)
    expect((await call('computer_press_key', { windowId: 'w1', key: 'a', modifiers: ['shift'], repeat: 2 })).isError).toBe(false)
    const scrolledSnap = await call('computer_snapshot', { windowId: 'w1' })
    const scrollRef = /\[(\d+-e0)\]/.exec((scrolledSnap.value as { text: string }).text)?.[1]
    expect((await call('computer_scroll', { windowId: 'w1', ref: scrollRef, direction: 'up', amount: 2 })).isError).toBe(false)
    expect((await call('computer_scroll', { windowId: 'w1', x: 1, y: 1, direction: 'down', amount: 1, space: 'screen' })).isError).toBe(false)
    expect((await call('computer_drag', { windowId: 'w1', from: { x: 1, y: 1 }, to: { x: 2, y: 2 }, space: 'screen' })).isError).toBe(false)
    expect((await call('computer_mouse_move', { windowId: 'w1', x: 3, y: 4, space: 'screen' })).isError).toBe(false)
    expect((await call('computer_wait_for', { windowId: 'w1', text: 'OK', title: 'Notes' })).isError).toBe(false)
    expect((await call('computer_wait_for', { windowId: 'w1', text: 'missing', timeoutMs: 1 })).value).toMatchObject({ matched: false })
    expect((await call('computer_clipboard', { action: 'read' })).value).toMatchObject({ text: 'clip' })
    expect((await call('computer_clipboard', { action: 'write', text: 'z' })).isError).toBe(false)
    expect((await call('computer_clipboard', { action: 'write' })).isError).toBe(true)
  })

  it('reports computer_status, observes, and invokes advertised actions', async () => {
    const { call } = await mount({ vision: true })
    const status = await call('computer_status', {})
    expect(status.isError).toBe(false)
    expect(status.value).toMatchObject({ available: true, connection: 'live' })
    const observed = await call('computer_observe', { windowId: 'w1', screenshot: true })
    expect(observed.isError).toBe(false)
    const observedValue = observed.value as { observationId?: string; attachmentId?: string }
    expect(observedValue.observationId).toBeTypeOf('string')
    expect(observedValue.attachmentId).toBe('att-1')
    const acted = await call('computer_action', { windowId: 'w1', ref: '1-e0', action: 'activate' })
    expect(acted.isError).toBe(false)
    const snap = await call('computer_snapshot', { windowId: 'w1', maxDepth: 0 })
    const ref = /\[(\d+-e0)\]/.exec((snap.value as { text: string }).text)?.[1]
    expect((await call('computer_action', { windowId: 'w1', ref, action: 'toggle' })).isError).toBe(true)
    expect((await call('computer_action', { windowId: 'w1', ref, action: 'setValue' })).isError).toBe(true)
    expect((await call('computer_action', { windowId: 'w1', ref, action: 'nope' })).isError).toBe(true)
  })

  it('rejects screenshot-space clicks after geometry changes and supports wait/drag refs', async () => {
    let bounds = { x: 0, y: 0, width: 800, height: 600 }
    const { call } = await mount({
      vision: true,
      provider: makeProvider({
        listWindows: () => Promise.resolve([{
          id: ComputerWindowId('w1'),
          appId: ComputerAppId('notes'),
          title: 'Notes',
          bounds,
          focused: true,
        }]),
        snapshot: request => Promise.resolve({
          windowId: request.windowId,
          appId: ComputerAppId('notes'),
          title: 'Notes',
          truncated: false,
          nodes: [{
            handle: 'n1',
            role: 'checkbox',
            name: 'Bold',
            bounds: { x: 10, y: 10, width: 20, height: 10 },
            states: ['enabled', 'selected'],
            supportsPress: true,
            supportsSetValue: false,
            actions: ['toggle', 'select'],
            secure: false,
          }],
        }),
      }),
    })
    const observed = await call('computer_observe', { windowId: 'w1' })
    const observationId = (observed.value as { observationId: string }).observationId
    bounds = { x: 10, y: 10, width: 800, height: 600 }
    expect((await call('computer_click', { windowId: 'w1', x: 5, y: 5, observationId })).isError).toBe(true)
    bounds = { x: 0, y: 0, width: 800, height: 600 }
    const snap = await call('computer_snapshot', { windowId: 'w1' })
    const ref = /\[(\d+-e0)\]/.exec((snap.value as { text: string }).text)?.[1]
    expect((await call('computer_wait_for', { windowId: 'w1', ref, state: 'selected' })).value).toMatchObject({ matched: true })
    const gone = await call('computer_wait_for', { windowId: 'w1', text: 'missing', gone: true, timeoutMs: 1 })
    expect(gone.value).toMatchObject({ matched: true })
    const dragRef = /\[(\d+-e0)\]/.exec((gone.value as { text: string }).text)?.[1]
    expect((await call('computer_drag', {
      windowId: 'w1',
      from: { ref: dragRef },
      to: { x: 2, y: 2 },
      space: 'screen',
    })).isError).toBe(false)
    const afterDrag = await call('computer_snapshot', { windowId: 'w1' })
    const fresh = /\[(\d+-e0)\]/.exec((afterDrag.value as { text: string }).text)?.[1]
    expect((await call('computer_action', { windowId: 'w1', ref: fresh, action: 'toggle' })).isError).toBe(false)
    expect((await call('computer_drag', { windowId: 'w1', from: {}, to: { x: 1, y: 1 }, space: 'screen' })).isError).toBe(true)
  })

  it('covers snapshot refs, setValue, modifiers, and mismatched observation ids', async () => {
    const { call } = await mount({ vision: true })
    expect((await call('computer_action', { windowId: 'w1', ref: '1-e0', action: 'activate' })).isError).toBe(true)
    expect((await call('computer_drag', { windowId: 'w1', from: { ref: '1-e0' }, to: { x: 1, y: 1 }, space: 'screen' })).isError).toBe(true)
    const snap = await call('computer_snapshot', { windowId: 'w1' })
    const field = /\[(\d+-e1)\]/.exec((snap.value as { text: string }).text)?.[1]
    expect((await call('computer_action', { windowId: 'w1', ref: field, action: 'setValue', value: 'Ada' })).isError).toBe(false)
    const after = await call('computer_snapshot', { windowId: 'w1' })
    const nextButton = /\[(\d+-e0)\]/.exec((after.value as { text: string }).text)?.[1]
    expect((await call('computer_snapshot', { windowId: 'w1', ref: nextButton, maxDepth: 1 })).isError).toBe(false)
    const afterSubtree = await call('computer_snapshot', { windowId: 'w1' })
    const next = /\[(\d+-e0)\]/.exec((afterSubtree.value as { text: string }).text)?.[1]
    expect((await call('computer_click', {
      windowId: 'w1',
      ref: next,
      modifiers: ['shift'],
    })).isError).toBe(false)
    await call('computer_observe', { windowId: 'w1', screenshot: false })
    expect((await call('computer_click', { windowId: 'w1', x: 1, y: 1, observationId: 'stale' })).isError).toBe(true)
    expect((await call('computer_wait_for', { windowId: 'w1', state: 'busy', timeoutMs: 1 })).value)
      .toMatchObject({ matched: true })
    const failed = await mount({
      provider: makeProvider({
        permissions: () => Promise.reject(new ComputerError('helper down', 'COMPUTER_HOST_CRASHED')),
      }),
    })
    expect((await failed.call('computer_status', {})).value).toMatchObject({ connection: 'probe-failed' })
  })

  it('keeps a completed action when the follow-up observation fails', async () => {
    let failSnapshot = false
    const { call } = await mount({
      provider: makeProvider({
        snapshot: (request) => {
          if (failSnapshot) return Promise.reject(new ComputerError('tree gone', 'COMPUTER_HOST_CRASHED'))
          return Promise.resolve({
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
              actions: ['activate'],
              secure: false,
            }],
          })
        },
      }),
    })
    await call('computer_snapshot', { windowId: 'w1' })
    failSnapshot = true
    const clicked = await call('computer_click', { windowId: 'w1', ref: '1-e0' })
    expect(clicked.isError).toBe(false)
    expect((clicked.value as { observationError?: string }).observationError).toContain('tree gone')
  })

  it('clicks coordinates, maps screenshot space, and refuses a screenshot on a text-only route', async () => {
    const { call } = await mount()
    await call('computer_snapshot', { windowId: 'w1' })
    const click = await call('computer_click', { windowId: 'w1', x: 10, y: 10, space: 'screen' })
    expect(click.isError).toBe(false)
    const shot = await call('computer_screenshot', { windowId: 'w1', region: { x: 0, y: 0, width: 10, height: 10 } })
    expect(shot.isError).toBe(true)
    expect(shot.content[0]).toMatchObject({ type: 'text' })
  })

  it('saves a screenshot on a vision route without resizing the capture', async () => {
    const { call } = await mount({ vision: true, config: { approval: 'never' } })
    const shot = await call('computer_screenshot', { windowId: 'w1' })
    expect(shot.isError).toBe(false)
    const shotId = (shot.value as { observationId: string }).observationId
    await call('computer_click', { windowId: 'w1', x: 25, y: 25, observationId: shotId })
    const full = await call('computer_screenshot', {})
    expect(full.isError).toBe(false)
  })

  it('maps screenshot-space coordinates through the dimensions the result declares', async () => {
    const clicks: { x: number; y: number }[] = []
    const { call } = await mount({
      vision: true,
      config: { approval: 'never' },
      provider: makeProvider({
        click: (request) => {
          clicks.push({ x: request.x, y: request.y })
          return Promise.resolve()
        },
      }),
    })
    // The capture is 100x50 px over an 800x600 window, so the centre of the
    // declared image is the centre of the window, and the declared scale is the
    // delivered image's own ratio to those logical units.
    const observed = await call('computer_observe', { windowId: 'w1' })
    expect(observed.value).toMatchObject({ width: 100, height: 50, scale: 0.125 })
    const observationId = (observed.value as { observationId: string }).observationId
    expect((await call('computer_click', { windowId: 'w1', x: 50, y: 25, observationId })).isError).toBe(false)
    expect(clicks.at(-1)).toEqual({ x: 400, y: 300 })
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
            actions: [],
            secure: false,
          }],
        }),
      }),
    })
    await call('computer_snapshot', { windowId: 'w1' })
    expect((await call('computer_click', { windowId: 'w1', ref: '1-e0', button: 'right', count: 2, modifiers: ['shift'] })).isError).toBe(false)
    const afterRight = await call('computer_snapshot', { windowId: 'w1' })
    const middleRef = /\[(\d+-e0)\]/.exec((afterRight.value as { text: string }).text)?.[1]
    expect((await call('computer_click', { windowId: 'w1', ref: middleRef, button: 'middle' })).isError).toBe(false)
    const afterMiddle = await call('computer_snapshot', { windowId: 'w1' })
    const leftRef = /\[(\d+-e0)\]/.exec((afterMiddle.value as { text: string }).text)?.[1]
    expect((await call('computer_click', { windowId: 'w1', ref: leftRef })).isError).toBe(false)
    const afterClick = await call('computer_snapshot', { windowId: 'w1' })
    const typeRef = /\[(\d+-e0)\]/.exec((afterClick.value as { text: string }).text)?.[1]
    expect((await call('computer_type', { windowId: 'w1', ref: typeRef, text: 'hi' })).isError).toBe(false)
  })

  it('leaves tools unregistered when disabled and rejects non-positive caps', async () => {
    const { ctx } = await mount({ config: { enabled: false } })
    expect(ctx.tools.schemas().map(schema => schema.name)).not.toContain('computer_apps')
    const ctx2 = new Context()
    await ctx2.plugin(SystemPrompt)
    await ctx2.plugin(ToolRuntime)
    await ctx2.plugin(ComputerRuntime)
    const invalid = (patch: Partial<ToolComputer.Config>): void => {
      ToolComputer.apply(ctx2, {
        snapshotMaxNodes: 1,
        screenshotMaxBytes: 1,
        timeoutMs: 1,
        ...patch,
      })
    }
    expect(() => { invalid({ snapshotMaxNodes: 0 }) }).toThrow(/snapshotMaxNodes/)
    expect(() => { invalid({ screenshotMaxBytes: 0 }) }).toThrow(/screenshotMaxBytes/)
    expect(() => { invalid({ timeoutMs: 0 }) }).toThrow(/timeoutMs/)
  })

  it('disposes with the fiber', async () => {
    const { ctx, fiber } = await mount()
    expect(ctx.tools.schemas().some(schema => schema.name === 'computer_apps')).toBe(true)
    await fiber.dispose()
  })

  it('covers presenters, gone windows, unresolved routes, and screenshot mapping', async () => {
    const { ctx, call } = await mount({ vision: true, config: { approval: 'never' } })
    const presenterArgs: Record<string, Record<string, unknown>> = {
      computer_status: {},
      computer_apps: {},
      computer_launch: { app: 'Notes' },
      computer_focus: { windowId: 'w1' },
      computer_displays: {},
      computer_focus_element: { windowId: 'w1', ref: '1-e0' },
      computer_set_window_bounds: { windowId: 'w1', x: 0, y: 0, width: 100, height: 100 },
      computer_snapshot: { windowId: 'w1' },
      computer_observe: { windowId: 'w1' },
      computer_action: { windowId: 'w1', ref: '1-e0', action: 'activate' },
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
        operations: ['snapshot'],
        unsupportedOperations: ['clipboardRead'],
        issues: [{ code: 'X', message: 'm', recovery: 'r' }],
        connection: 'live',
        available: true,
        bounds: { x: 0, y: 0, width: 100, height: 80 },
        displays: [{ id: 'd1', x: 0, y: 0, width: 800, height: 600, scale: 1, primary: true }],
      })
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
        observationError: 'observe failed',
        operations: [],
        unsupportedOperations: [],
        issues: [],
        bounds: { x: 1, y: 2, width: 3, height: 4 },
        displays: [],
      })
      tool?.output.render(args, {
        action: 'read',
        apps: [],
        operations: ['snapshot'],
        unsupportedOperations: [],
        issues: [],
        bounds: { x: 0, y: 0, width: 1, height: 1 },
        displays: [],
      })
      tool?.output.presentationMeta?.(args, { app: 'Notes', windowTitle: 'Notes', windowId: 'w1' })
    }
    ctx.tools.get('computer_click')?.presentCall?.({ windowId: 'w1', x: 1, y: 2 })
    ctx.tools.get('computer_clipboard')?.presentCall?.({ action: 'write' })

    const shot = await call('computer_screenshot', { windowId: 'w1', region: { x: 0, y: 0, width: 10, height: 10 } })
    expect(shot.isError).toBe(false)
    const shotId = (shot.value as { observationId: string }).observationId
    expect((await call('computer_click', { windowId: 'w1', x: 10, y: 10, observationId: shotId })).isError).toBe(false)
    expect((await call('computer_click', { windowId: 'w1', x: 1, y: 1, space: 'screen', button: 'middle' })).isError).toBe(false)
    expect((await call('computer_press_key', { windowId: 'w1', key: 'b' })).isError).toBe(false)
    expect((await call('computer_wait_for', { windowId: 'w1' })).isError).toBe(false)
    expect((await call('computer_scroll', { windowId: 'w1', x: 1, y: 1, direction: 'sideways', amount: 1, space: 'screen' })).isError).toBe(false)
    expect((await call('computer_scroll', { windowId: 'w1', x: 2, y: 2, direction: 'left', amount: 1, space: 'screen' })).isError).toBe(false)
    expect((await call('computer_drag', { windowId: 'w1', from: { x: 1, y: 1 }, to: { x: 2, y: 2 }, space: 'screen' })).isError).toBe(false)
    expect((await call('computer_mouse_move', { windowId: 'w1', x: 3, y: 4, space: 'screen' })).isError).toBe(false)

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
    expect((await zero.call('computer_click', { windowId: 'w1', x: 3, y: 4 })).isError).toBe(true)
    expect((await zero.call('computer_click', { windowId: 'w1', x: 3, y: 4, space: 'screen' })).isError).toBe(false)

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

    const fresh = await mount({ vision: true })
    expect((await fresh.call('computer_snapshot', { windowId: 'w1', ref: '1-e0' })).isError).toBe(true)
    expect((await fresh.call('computer_wait_for', { windowId: 'w1', ref: '1-e0', timeoutMs: 1 })).isError).toBe(false)
    const loaded = await fresh.call('computer_snapshot', { windowId: 'w1' })
    const live = /\[(\d+-e0)\]/.exec((loaded.value as { text: string }).text)?.[1]
    expect((await fresh.call('computer_screenshot', { windowId: 'w1' })).isError).toBe(false)
    expect((await fresh.call('computer_action', { windowId: 'w1', ref: '1-e0', action: 'expandCollapse' })).isError).toBe(true)
    expect((await fresh.call('computer_action', { windowId: 'w1', ref: '1-e1', action: 'setValue' })).isError).toBe(true)
    expect((await fresh.call('computer_observe', { windowId: 'w1', maxDepth: 1, ref: live })).isError).toBe(false)
    expect((await fresh.call('computer_click', { windowId: 'w1', x: 2, y: 2, modifiers: ['alt'], space: 'screen' })).isError).toBe(false)
    expect((await fresh.call('computer_scroll', { windowId: 'w1', x: 1, y: 1, direction: 'down', amount: 1, modifiers: ['ctrl'], space: 'screen' })).isError).toBe(false)
    await fresh.call('computer_snapshot', { windowId: 'w1' })
    expect((await fresh.call('computer_drag', {
      windowId: 'w1',
      from: { x: 1, y: 1 },
      to: { x: 2, y: 2 },
      space: 'screen',
      modifiers: ['shift'],
    })).isError).toBe(false)
    expect((await fresh.call('computer_wait_for', { windowId: 'w1', state: 'selected', timeoutMs: 1 })).value)
      .toMatchObject({ matched: false })
    expect((await fresh.call('computer_wait_for', { windowId: 'w1', text: 'never', timeoutMs: -1 })).value)
      .toMatchObject({ matched: false, timedOut: true })
    expect((await fresh.call('computer_displays', {})).value).toMatchObject({
      displays: [{ id: 'd1', primary: true }],
    })
    const beforeFocus = await fresh.call('computer_snapshot', { windowId: 'w1' })
    const focusRef = /\[(\d+-e0)\]/.exec((beforeFocus.value as { text: string }).text)?.[1]
    expect((await fresh.call('computer_focus_element', { windowId: 'w1', ref: focusRef })).isError).toBe(false)
    expect((await fresh.call('computer_set_window_bounds', { windowId: 'w1', x: 1, y: 2, width: 3, height: 4 })).isError).toBe(false)
    expect((await fresh.call('computer_press_key', { windowId: 'w1', key: 'Shift', action: 'down' })).isError).toBe(false)
    expect((await fresh.call('computer_press_key', { windowId: 'w1', key: 'Shift', action: 'up' })).isError).toBe(false)
    const reused = await fresh.call('computer_snapshot', { windowId: 'w1' })
    const observationId = (reused.value as { observationId: string }).observationId
    const filtered = await fresh.call('computer_snapshot', { windowId: 'w1', observationId, query: 'OK' })
    expect((filtered.value as { observationId: string }).observationId).toBe(observationId)
    expect((await fresh.call('computer_clipboard', { action: 'write', text: 'clip' })).isError).toBe(false)
    const noProvider = await mount({ skipProvider: true })
    expect((await noProvider.call('computer_status', {})).value).toMatchObject({ available: false })
    const configured = await mount({ computerConfig: { provider: 'fake' } })
    expect((await configured.call('computer_status', {})).value).toMatchObject({ configuredProvider: 'fake' })
    const bare = await mount({
      provider: makeProvider({
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- this case covers the non-Error observationError.
        snapshot: () => Promise.reject('bare'),
      }),
    })
    const afterBare = await bare.call('computer_click', { windowId: 'w1', x: 1, y: 1, space: 'screen' })
    expect(afterBare.isError).toBe(false)
    expect(afterBare.value).toMatchObject({ observationError: 'bare' })
    const noAttach = await mount({ vision: true, attachments: false })
    expect((await noAttach.call('computer_observe', { windowId: 'w1' })).isError).toBe(false)
    const huge = await mount({
      vision: true,
      config: { approval: 'never', screenshotMaxBytes: 1 },
    })
    expect((await huge.call('computer_observe', { windowId: 'w1' })).isError).toBe(false)
    const scaled = await mount({
      vision: true,
      config: { approval: 'never' },
    })
    expect((await scaled.call('computer_observe', { windowId: 'w1' })).isError).toBe(false)
    expect((await scaled.call('computer_screenshot', {})).isError).toBe(false)
    const emptyActs = await mount({
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
            bounds: { x: 0, y: 0, width: 1, height: 1 },
            states: [],
            supportsPress: false,
            supportsSetValue: false,
            actions: [],
            secure: false,
          }],
        }),
      }),
    })
    await emptyActs.call('computer_snapshot', { windowId: 'w1' })
    expect((await emptyActs.call('computer_action', { windowId: 'w1', ref: '1-e0', action: 'activate' })).isError).toBe(true)

    const noSnap = await mount()
    expect((await noSnap.call('computer_focus_element', { windowId: 'w1', ref: '1-e0' })).isError).toBe(true)
    await noSnap.call('computer_snapshot', { windowId: 'w1' })
    expect((await noSnap.call('computer_click', {
      windowId: 'w1', ref: '1-e0', button: 'left', count: 1,
    })).isError).toBe(false)
    const afterPress = await noSnap.call('computer_snapshot', { windowId: 'w1' })
    const valueRef = /\[(\d+-e1)\]/.exec((afterPress.value as { text: string }).text)?.[1]
    expect((await noSnap.call('computer_action', { windowId: 'w1', ref: valueRef, action: 'setValue' })).isError).toBe(true)
  })

  it('does not let a fresh text observation reuse an older screenshot transform', async () => {
    let moved = false
    const clicks: number[] = []
    const { call } = await mount({ vision: true, provider: makeProvider({
      listWindows: async () => [{ ...windowOf('w1'), bounds: { x: moved ? 100 : 0, y: 0, width: 800, height: 600 } }],
      click: async (request) => { clicks.push(request.x) },
    }) })
    const shot = await call('computer_screenshot', { windowId: 'w1' })
    const shotId = (shot.value as { observationId: string }).observationId
    expect(textOf(shot)).toContain(`Observation: ${shotId}`)
    moved = true
    const snapshot = await call('computer_snapshot', { windowId: 'w1' })
    const observationId = (snapshot.value as { observationId: string }).observationId
    expect(observationId).not.toBe(shotId)
    expect(textOf(snapshot)).toContain(`Observation: ${observationId}`)
    const result = await call('computer_click', { windowId: 'w1', observationId, x: 25, y: 25, space: 'screenshot' })
    expect(result.isError).toBe(true)
    expect(clicks).toEqual([])
    const observed = await call('computer_observe', { windowId: 'w1' })
    expect(textOf(observed)).toContain(`Observation: ${(observed.value as { observationId: string }).observationId}`)
  })

  it('saves real PNG screenshots, lists empty displays, and auto-grants clipboard writes', async () => {
    const png = new Uint8Array(await sharp({
      create: { width: 100, height: 40, channels: 3, background: { r: 255, g: 0, b: 0 } },
    }).png().toBuffer())
    const fitted = await mount({
      vision: true,
      config: { approval: 'never' },
      provider: makeProvider({
        screenshot: () => Promise.resolve({
          png,
          width: 100,
          height: 40,
          scale: 1,
          bounds: { x: 0, y: 0, width: 800, height: 600 },
        }),
      }),
    })
    const shot = await fitted.call('computer_screenshot', { windowId: 'w1', displayId: 'd1' })
    expect(shot.isError).toBe(false)

    const none = await mount({
      provider: makeProvider({ listDisplays: () => Promise.resolve([]) }),
    })
    expect((await none.call('computer_displays', {})).content[0]).toMatchObject({ type: 'text', text: '(no displays)' })

    const appsOnly = await mount({
      questions: 'Allow once',
      approval: async () => 'allowed-once',
      provider: makeProvider({ listWindows: () => Promise.resolve([]) }),
    })
    expect((await appsOnly.call('computer_clipboard', { action: 'write', text: 'clip' })).isError).toBe(false)

    const appsSilent = await mount({
      provider: makeProvider({ listWindows: () => Promise.resolve([]) }),
    })
    expect((await appsSilent.call('computer_clipboard', { action: 'write', text: 'clip' })).isError).toBe(false)

    const emptyDesk = await mount({
      provider: makeProvider({
        listWindows: () => Promise.resolve([]),
        listApps: () => Promise.resolve([]),
      }),
    })
    expect((await emptyDesk.call('computer_clipboard', { action: 'write', text: 'clip' })).isError).toBe(true)

    const unfocused = await mount({
      questions: 'Allow once',
      provider: makeProvider({
        listWindows: () => Promise.resolve([windowOf('w1', 'notes')].map(window => ({ ...window, focused: false }))),
      }),
    })
    expect((await unfocused.call('computer_clipboard', { action: 'write', text: 'clip' })).isError).toBe(false)

    const secondary = await mount({
      provider: makeProvider({
        listDisplays: () => Promise.resolve([
          { id: ComputerDisplayId('d1'), bounds: { x: 0, y: 0, width: 800, height: 600 }, scale: 1, primary: true },
          { id: ComputerDisplayId('d2'), bounds: { x: 800, y: 0, width: 800, height: 600 }, scale: 1, primary: false },
        ]),
      }),
    })
    expect(textOfDisplays(await secondary.call('computer_displays', {}))).toContain('d2')

    const stale = await mount()
    expect((await stale.call('computer_snapshot', { windowId: 'w1', observationId: '999' })).isError).toBe(true)
    await stale.call('computer_snapshot', { windowId: 'w1' })
    expect((await stale.call('computer_action', { windowId: 'w1', ref: '1-e0', action: 'setValue' })).isError).toBe(true)

    const zeroGeom = await mount({
      vision: true,
      attachmentSize: { width: 0, height: 0 },
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
    const zeroShot = await zeroGeom.call('computer_screenshot', { windowId: 'w1' })
    const zeroId = (zeroShot.value as { observationId: string }).observationId
    expect((await zeroGeom.call('computer_click', { windowId: 'w1', x: 3, y: 4, observationId: zeroId })).isError).toBe(true)

    const mapped = await mount({ vision: true })
    const mappedShot = await mapped.call('computer_screenshot', { windowId: 'w1' })
    const mappedId = (mappedShot.value as { observationId: string }).observationId
    expect((await mapped.call('computer_scroll', {
      windowId: 'w1', x: 1, y: 1, direction: 'down', amount: 1, observationId: mappedId,
    })).isError).toBe(false)
    const afterScrollShot = await mapped.call('computer_screenshot', { windowId: 'w1' })
    const afterScrollId = (afterScrollShot.value as { observationId: string }).observationId
    expect((await mapped.call('computer_mouse_move', {
      windowId: 'w1', x: 1, y: 1, observationId: afterScrollId,
    })).isError).toBe(false)
    expect((await mapped.call('computer_drag', {
      windowId: 'w1', from: { x: 1, y: 1 }, to: { x: 2, y: 2 }, observationId: afterScrollId,
    })).isError).toBe(false)
    expect((await mapped.call('computer_click', {
      windowId: 'w1', x: 1, y: 1, button: 'left', count: 1, space: 'screen',
    })).isError).toBe(false)
  })
})

function textOfDisplays(result: { content: readonly unknown[] }): string {
  const block = result.content[0]
  return typeof block === 'object' && block !== null && 'text' in block && typeof block.text === 'string'
    ? block.text
    : ''
}
