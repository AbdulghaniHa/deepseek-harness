import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import BrowserRuntime, {
  BrowserTabId,
  type BrowserCdpEvent,
  type BrowserProvider,
  type BrowserTab,
} from '@deepseek-ai/dsh-browser'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolBrowser from '@deepseek-ai/dsh-tool-browser'
import {
  approveBrowserAction,
  browserMetaFromValue,
  buildSnapshot,
  cdpClient,
  clickAt,
  formatSnapshot,
  nodeCenter,
  pageIdentity,
  presentBrowserCall,
  presentBrowserResult,
  resolveRef,
  SNAPSHOT_REF,
  typeText,
} from '@deepseek-ai/dsh-tool-browser'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'

const signal = new AbortController().signal

function agent(id = 'owner'): Agent {
  return { id: SessionId(id) } as unknown as Agent
}

function tab(id: string, overrides: Partial<BrowserTab> = {}): BrowserTab {
  return {
    id: BrowserTabId(id),
    url: `https://example.com/${id}`,
    title: id,
    active: true,
    windowId: 1,
    grouped: false,
    ...overrides,
  }
}

function textOf(result: { content: readonly unknown[] }): string {
  const block = result.content[0]
  return typeof block === 'object' && block !== null && 'text' in block && typeof block.text === 'string'
    ? block.text
    : ''
}

function axTree() {
  return {
    nodes: [
      { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Home' }, childIds: ['2', '3', '4'] },
      { nodeId: '4', role: { value: 'link' }, name: { value: 'More' } },
      { nodeId: '2', backendDOMNodeId: 10, role: { value: 'button' }, name: { value: 'Submit' } },
      {
        nodeId: '3',
        backendDOMNodeId: 11,
        role: { value: 'textbox' },
        name: { value: 'Password' },
        value: { value: 'secret' },
      },
    ],
  }
}

function makeProvider(cdpImpl?: (method: string, params?: Readonly<Record<string, unknown>>) => unknown): BrowserProvider & {
  events: Set<(event: BrowserCdpEvent) => void>
  emit(event: BrowserCdpEvent): void
} {
  const events = new Set<(event: BrowserCdpEvent) => void>()
  const first = tab('1')
  const tabs: BrowserTab[] = [first]
  return {
    id: 'fake',
    available: () => true,
    capabilities: () => ['tabs', 'cdp', 'history', 'bookmarks', 'readingList', 'downloads'],
    listTabs: () => Promise.resolve(tabs.slice()),
    openTab: (request) => {
      const opened = tab('opened', { url: request.url, title: 'Opened', grouped: request.group === true, active: false })
      tabs.push(opened)
      return Promise.resolve(opened)
    },
    attach: () => Promise.resolve(),
    detach: () => Promise.resolve(),
    closeTab: (tabId) => {
      const index = tabs.findIndex(item => item.id === tabId)
      if (index >= 0) tabs.splice(index, 1)
      return Promise.resolve()
    },
    cdp: request => Promise.resolve(cdpImpl?.(request.method, request.params) ?? {}),
    onCdpEvent: (listener) => {
      events.add(listener)
      return () => { events.delete(listener) }
    },
    historySearch: () => Promise.resolve([{ url: 'https://example.com', title: 'Example', lastVisitTime: 1 }]),
    listBookmarks: () => Promise.resolve([{ id: 'b1', title: 'Docs', url: 'https://docs.example' }]),
    createBookmark: item => Promise.resolve({ id: 'b2', title: item.title, url: item.url }),
    listReadingList: () => Promise.resolve([{ url: 'https://read.example', title: 'Read later', hasBeenRead: false }]),
    addReadingList: item => Promise.resolve({ url: item.url, title: item.title, hasBeenRead: false }),
    listDownloads: () => Promise.resolve([{ id: 1, url: 'https://dl.example/a', filename: 'a.zip', state: 'complete' }]),
    events,
    emit(event) {
      for (const listener of events) listener(event)
    },
  }
}

async function mount(opts: {
  config?: ToolBrowser.Config
  cdp?: (method: string, params?: Readonly<Record<string, unknown>>) => unknown
  approval?: (req: { toolName: string }) => Promise<ApprovalOutcome>
  provider?: BrowserProvider
} = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(BrowserRuntime)
  const provider = (opts.provider ?? makeProvider(opts.cdp)) as ReturnType<typeof makeProvider>
  ctx.browser.registerProvider(provider)
  if (opts.approval) {
    ctx.provide('approval', {
      request: (req: { toolName: string }) => opts.approval!(req),
    })
  }
  const fiber = await ctx.plugin(ToolBrowser, opts.config ?? { approval: 'never' })
  const owner = agent()
  let counter = 0
  const call = (name: string, args: unknown) => ctx.tools.execute({
    signal,
    callId: ToolCallId(`call-${++counter}`),
    name,
    arguments: args,
    agent: owner,
  })
  return { ctx, fiber, call, owner, provider }
}

describe('snapshot builder', () => {
  it('mints epoch refs, redacts secrets, and truncates', () => {
    const snapshot = buildSnapshot(axTree().nodes, {
      url: 'https://example.com',
      title: 'Home',
      epoch: 3,
      maxNodes: 3,
    })
    expect(snapshot.nodes).toHaveLength(3)
    expect(snapshot.nodes[0]?.ref).toBe('3-e0')
    expect(snapshot.nodes[2]?.value).toBe('<redacted>')
    expect(snapshot.truncated).toBe(true)
    expect(snapshot.text).toContain('[3-e0]')
    expect(SNAPSHOT_REF.test('3-e0')).toBe(true)
    expect(resolveRef('3-e0', snapshot).role).toBe('RootWebArea')
    expect(() => resolveRef('nope', snapshot)).toThrow('invalid snapshot ref')
    expect(() => resolveRef('2-e0', snapshot)).toThrow('stale snapshot ref')
    expect(() => resolveRef('3-e9', snapshot)).toThrow('unknown snapshot ref')
    const dup = buildSnapshot([
      { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Home' }, childIds: ['2', '2'] },
      { nodeId: '2', role: { value: 'button' }, name: { value: 'Once' } },
    ], { url: 'https://example.com', title: 'Home', epoch: 1, maxNodes: 8 })
    expect(dup.nodes.filter(node => node.role === 'button')).toHaveLength(1)
  })

  it('redacts autocomplete-marked fields and skips ignored generics', () => {
    const snapshot = buildSnapshot([
      {
        nodeId: '1',
        role: { value: 'textbox' },
        name: { value: 'Card' },
        value: { value: '4111' },
        properties: [{ name: 'autocomplete', value: { value: 'cc-number' } }],
      },
      { nodeId: '2', role: { value: 'generic' }, ignored: true },
    ], { url: 'u', title: 't', epoch: 1, maxNodes: 10 })
    expect(snapshot.nodes[0]?.value).toBe('<redacted>')
    expect(snapshot.nodes.some(node => node.role === 'generic')).toBe(false)
  })

  it('renders an empty page when nothing is collectable', () => {
    const snapshot = buildSnapshot([], { url: 'u', title: 't', epoch: 1, maxNodes: 10 })
    expect(snapshot.text).toBe('(empty page)')
  })

  it('walks nameless generics as structure only and keeps a named generic', () => {
    const snapshot = buildSnapshot([
      { role: { value: 'generic' }, childIds: ['missing'] },
      { nodeId: 'root', role: { value: 'RootWebArea' }, name: { value: 'R' }, childIds: ['a'] },
      { nodeId: 'a', role: { value: 'generic' }, name: { value: 'Keep' }, childIds: ['a'] },
      { nodeId: 'b', name: { value: 'NoRole' }, value: { value: 'plain' } },
      { nodeId: 'd', role: { value: 'button' } },
      {
        nodeId: 'c',
        role: { value: 'textbox' },
        name: { value: 'Token' },
        properties: [{ name: 'autocomplete' }],
      },
    ], { url: 'u', title: 't', epoch: 1, maxNodes: 10 })
    expect(snapshot.nodes.some(node => node.name === 'Keep')).toBe(true)
    expect(snapshot.nodes.some(node => node.value === 'plain')).toBe(true)
    expect(snapshot.text).toContain('NoRole')
  })

  it('returns when a child id is revisited', () => {
    const snapshot = buildSnapshot([
      { nodeId: 'r', role: { value: 'RootWebArea' }, name: { value: 'R' }, childIds: ['a', 'a'] },
      { nodeId: 'a', role: { value: 'button' }, name: { value: 'Once' } },
    ], { url: 'u', title: 't', epoch: 1, maxNodes: 10 })
    expect(snapshot.nodes.filter(node => node.name === 'Once')).toHaveLength(1)
  })

  it('walks every node when the tree has no root id', () => {
    const snapshot = buildSnapshot([
      { role: { value: 'generic' }, childIds: ['missing'] },
      { nodeId: 'loop', role: { value: 'button' }, name: { value: 'X' }, childIds: ['loop'] },
    ], { url: 'u', title: 't', epoch: 1, maxNodes: 10 })
    expect(snapshot.nodes.some(node => node.name === 'X')).toBe(true)
  })
})

describe('presenters and CDP helpers', () => {
  it('builds call/result cards and meta', () => {
    expect(presentBrowserCall('Open', 'fetch')).toEqual({
      card: 'generic', title: 'Open', kind: 'fetch', rawInput: 'Open',
    })
    expect(presentBrowserResult('Opened', 'done').content?.[0]).toEqual({ type: 'text', text: 'done' })
    expect(browserMetaFromValue({ url: 'https://a', title: 'A', tabId: '1', screenshot: 'abc' }))
      .toEqual({ url: 'https://a', title: 'A', tabId: '1', screenshot: 'abc' })
    expect(browserMetaFromValue({})).toEqual({})
    expect(formatSnapshot({ url: 'https://a', title: 'A', text: '- button', truncated: true }))
      .toContain('Snapshot truncated')
  })

  it('sends trusted input and reads identity', async () => {
    const sent: { method: string; params?: Readonly<Record<string, unknown>> }[] = []
    const cdp = {
      send: (method: string, params?: Readonly<Record<string, unknown>>) => {
        sent.push({ method, ...params !== undefined ? { params } : {} })
        if (method === 'Target.getTargetInfo') return Promise.resolve({ targetInfo: { url: 'https://fallback', title: 'fb' } })
        if (method === 'Runtime.evaluate') return Promise.resolve({ result: { value: { url: 'https://page', title: 'Page' } } })
        if (method === 'DOM.getBoxModel') return Promise.resolve({ model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } })
        return Promise.resolve({})
      },
    }
    expect(await pageIdentity(cdp)).toEqual({ url: 'https://page', title: 'Page' })
    await clickAt(cdp, 1, 2)
    await typeText(cdp, 'ab')
    expect(await nodeCenter(cdp, 9)).toEqual({ x: 5, y: 5 })
    expect(sent.some(item => item.method === 'Input.dispatchMouseEvent')).toBe(true)
    const empty = { send: () => Promise.resolve({}) }
    expect(await pageIdentity(empty)).toEqual({ url: '', title: '' })
    expect(await nodeCenter(empty, 1)).toBeUndefined()
    const shortBox = { send: () => Promise.resolve({ model: { content: [1, 2] } }) }
    expect(await nodeCenter(shortBox, 1)).toBeUndefined()
  })

  it('binds cdpClient to the seam', async () => {
    const { ctx, owner } = await mount({
      cdp: method => method === 'Page.reload' ? { ok: true } : {},
    })
    const client = cdpClient(ctx.browser, owner, BrowserTabId('1'), signal)
    await ctx.browser.attach(owner, BrowserTabId('1'))
    expect(await client.send('Page.reload')).toEqual({ ok: true })
  })
})

describe('approval', () => {
  it('skips never and agent-tab under user-tabs', async () => {
    await approveBrowserAction({ mode: 'never', kind: 'user-tab', toolName: 'browser_attach', reason: 'x' })
    await approveBrowserAction({ mode: 'user-tabs', kind: 'agent-tab', toolName: 'browser_click', reason: 'x' })
  })

  it('requires an approver and agent, then routes outcomes', async () => {
    await expect(approveBrowserAction({
      mode: 'always', kind: 'agent-tab', toolName: 'browser_open', reason: 'x',
    })).rejects.toThrow('no approval service')
    await expect(approveBrowserAction({
      mode: 'always',
      kind: 'agent-tab',
      toolName: 'browser_open',
      reason: 'x',
      approval: { request: () => Promise.resolve('allowed-once') },
    })).rejects.toThrow('no agent')
    await approveBrowserAction({
      mode: 'always',
      kind: 'agent-tab',
      toolName: 'browser_open',
      reason: 'x',
      agent: agent(),
      approval: { request: () => Promise.resolve('allowed-once') },
    })
    await expect(approveBrowserAction({
      mode: 'always',
      kind: 'agent-tab',
      toolName: 'browser_open',
      reason: 'x',
      agent: agent(),
      approval: { request: () => Promise.resolve('rejected') },
    })).rejects.toThrow('rejected')
    await expect(approveBrowserAction({
      mode: 'always',
      kind: 'agent-tab',
      toolName: 'browser_open',
      reason: 'x',
      agent: agent(),
      approval: { request: () => Promise.resolve('cancelled') },
    })).rejects.toThrow('cancelled')
    await expect(approveBrowserAction({
      mode: 'always',
      kind: 'agent-tab',
      toolName: 'browser_open',
      reason: 'x',
      agent: agent(),
      approval: { request: () => Promise.resolve('unavailable') },
    })).rejects.toThrow('no approval channel')
  })
})

describe('tool-browser plugin', () => {
  it('registers tools and tears them down with the fiber', async () => {
    const { ctx, fiber } = await mount()
    const names = ctx.tools.schemas().map(schema => schema.name)
    expect(names).toContain('browser_tabs')
    expect(names).not.toContain('browser_cdp')
    const prompt = await ctx.systemPrompt.assemble()
    expect(prompt.sections.some(section => section.name === 'tool:browser')).toBe(true)
    await fiber.dispose()
    expect(ctx.tools.schemas().map(schema => schema.name)).not.toContain('browser_tabs')
  })

  it('skips registration when disabled and rejects invalid caps', async () => {
    const { ctx, fiber } = await mount({ config: { enabled: false } })
    expect(ctx.tools.schemas().map(schema => schema.name)).not.toContain('browser_tabs')
    await fiber.dispose()
    const ctx2 = new Context()
    await ctx2.plugin(SystemPrompt)
    await ctx2.plugin(ToolRuntime)
    await ctx2.plugin(BrowserRuntime)
    await expect(ctx2.plugin(ToolBrowser, { snapshotMaxNodes: 0 })).rejects.toThrow('snapshotMaxNodes')
    await expect(ctx2.plugin(ToolBrowser, { screenshotMaxBytes: 0 })).rejects.toThrow('screenshotMaxBytes')
    await expect(ctx2.plugin(ToolBrowser, { evaluateTimeoutMs: 0 })).rejects.toThrow('evaluateTimeoutMs')
    await expect(ctx2.plugin(ToolBrowser, { timeoutMs: 0 })).rejects.toThrow('timeoutMs')
  })

  it('lists, opens, attaches, snapshots, and closes tabs', async () => {
    const { call, owner, ctx } = await mount({
      cdp: (method) => {
        if (method === 'Runtime.evaluate') return { result: { value: { url: 'https://example.com/1', title: 'Home' } } }
        if (method === 'Accessibility.getFullAXTree') return axTree()
        return {}
      },
    })
    const tabs = await call('browser_tabs', {})
    expect(tabs.isError).toBe(false)
    expect(textOf(tabs)).toContain('[1]')
    const opened = await call('browser_open', { url: 'https://example.com/new' })
    expect(opened.isError).toBe(false)
    expect(opened.value).toMatchObject({ url: 'https://example.com/new' })
    expect(typeof (opened.value as { previewError: string }).previewError).toBe('string')
    expect(opened.value).not.toHaveProperty('screenshot')
    expect(textOf(opened)).toContain('Opened')
    expect(textOf(opened)).not.toMatch(/previewError|AAAA/)
    expect(ctx.tools.get('browser_open')?.presentCall?.({ url: 'https://example.com/new' }))
      .toMatchObject({ title: 'Open https://example.com/new' })
    await ctx.browser.attach(owner, BrowserTabId('1'))
    const attached = await call('browser_attach', { tabId: '1' })
    expect(attached.value).toEqual({ tabId: '1', attached: true })
    const snapshot = await call('browser_snapshot', { tabId: '1' })
    expect(textOf(snapshot)).toContain('untrusted')
    const closed = await call('browser_close', { tabId: '1' })
    expect(closed.value).toEqual({ tabId: '1', closed: true })
  })

  it('attaches preview bytes on open without putting them in Native render text', async () => {
    const { call } = await mount({
      cdp: method => method === 'Page.captureScreenshot' ? { data: 'AAAA' } : {},
    })
    const opened = await call('browser_open', { url: 'https://example.com/new' })
    expect(opened.isError).toBe(false)
    expect(opened.value).toMatchObject({ screenshot: 'AAAA', url: 'https://example.com/new' })
    expect(textOf(opened)).not.toContain('AAAA')
  })

  it('names a freshly opened tab once Chrome commits its URL', async () => {
    const base = makeProvider(method => method === 'Page.captureScreenshot' ? { data: 'AAAA' } : {})
    const opened = await mount({
      provider: {
        ...base,
        openTab: () => Promise.resolve(tab('opened', { url: '', title: '', active: false })),
        listTabs: () => Promise.resolve([tab('opened', { url: 'https://example.com/', title: 'Example Domain' })]),
      },
    })
    const result = await opened.call('browser_open', { url: 'https://example.com' })
    expect(result.value).toMatchObject({ url: 'https://example.com/', title: 'Example Domain', screenshot: 'AAAA' })
  })

  it('records a previewError when capture rejects a non-Error', async () => {
    const { call } = await mount({
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- previewError must stringify a non-Error rejection
      cdp: () => Promise.reject('fail'),
    })
    const opened = await call('browser_open', { url: 'https://example.com/new' })
    expect(opened.isError).toBe(false)
    expect(opened.value).toMatchObject({ previewError: 'fail' })
  })

  it('navigates, reads text, and captures screenshots', async () => {
    const { call, owner, ctx } = await mount({
      cdp: (method, params) => {
        if (method === 'Runtime.evaluate') {
          const expression = typeof params?.expression === 'string' ? params.expression : ''
          if (expression.includes('innerText')) return { result: { value: 'body' } }
          return { result: { value: { url: 'https://example.com/1', title: 'Home' } } }
        }
        if (method === 'Accessibility.getFullAXTree') return axTree()
        if (method === 'Page.captureScreenshot') return { data: 'AAAA' }
        return {}
      },
    })
    await ctx.browser.attach(owner, BrowserTabId('1'))
    expect((await call('browser_navigate', { tabId: '1', action: 'reload' })).isError).toBe(false)
    expect((await call('browser_navigate', { tabId: '1', action: 'back' })).isError).toBe(false)
    expect((await call('browser_navigate', { tabId: '1', action: 'forward' })).isError).toBe(false)
    expect((await call('browser_navigate', { tabId: '1', action: 'goto', url: 'https://example.com' })).isError).toBe(false)
    const missing = await call('browser_navigate', { tabId: '1', action: 'goto' })
    expect(missing.isError).toBe(true)
    const text = await call('browser_text', { tabId: '1' })
    expect(text.isError).toBe(false)
    const { call: callText, owner: ownerText, ctx: ctxText } = await mount({
      config: { approval: 'never' },
      cdp: () => ({}),
    })
    await ctxText.browser.attach(ownerText, BrowserTabId('1'))
    expect((await callText('browser_text', { tabId: '1' })).value).toMatchObject({ text: '' })
    const shot = await call('browser_screenshot', { tabId: '1', fullPage: true })
    expect(shot.value).toMatchObject({ mimeType: 'image/png', truncated: false })
  })

  it('omits oversized screenshots', async () => {
    const { call, owner, ctx } = await mount({
      config: { approval: 'never', screenshotMaxBytes: 1 },
      cdp: method => method === 'Page.captureScreenshot' ? { data: 'A'.repeat(32) } : {},
    })
    await ctx.browser.attach(owner, BrowserTabId('1'))
    const shot = await call('browser_screenshot', { tabId: '1' })
    expect(shot.value).toMatchObject({ truncated: true })
  })

  it('clicks, types, presses, scrolls, and hovers', async () => {
    const { call, owner, ctx } = await mount({
      cdp: (method) => {
        if (method === 'Runtime.evaluate') return { result: { value: { url: 'https://example.com/1', title: 'Home' } } }
        if (method === 'Accessibility.getFullAXTree') return axTree()
        if (method === 'DOM.getBoxModel') return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } }
        return {}
      },
    })
    await ctx.browser.attach(owner, BrowserTabId('1'))
    expect((await call('browser_click', { tabId: '1', x: 3, y: 4 })).isError).toBe(false)
    const noTarget = await call('browser_click', { tabId: '1' })
    expect(noTarget.isError).toBe(true)
    const stale = await call('browser_click', { tabId: '1', ref: '1-e0' })
    expect(stale.isError).toBe(true)
    await call('browser_snapshot', { tabId: '1' })
    expect((await call('browser_click', { tabId: '1', ref: '1-e1' })).isError).toBe(false)
    expect((await call('browser_type', { tabId: '1', text: 'hi', ref: '1-e1', clear: true, submit: true })).isError).toBe(false)
    expect((await call('browser_press_key', { tabId: '1', key: 'Enter', modifiers: 0 })).isError).toBe(false)
    expect((await call('browser_press_key', { tabId: '1', key: 'Tab' })).isError).toBe(false)
    expect((await call('browser_scroll', { tabId: '1', deltaY: 80 })).isError).toBe(false)
    expect((await call('browser_hover', { tabId: '1', ref: '1-e1' })).isError).toBe(false)
    expect((await call('browser_hover', { tabId: '1', x: 1, y: 1 })).isError).toBe(false)
  })

  it('selects, waits, evaluates, and handles dialogs and uploads', async () => {
    const { call, owner, ctx } = await mount({
      cdp: (method) => {
        if (method === 'Runtime.evaluate') return { result: { value: true } }
        if (method === 'Accessibility.getFullAXTree') return axTree()
        return {}
      },
    })
    await ctx.browser.attach(owner, BrowserTabId('1'))
    expect((await call('browser_select_option', { tabId: '1', ref: '1-e1', value: 'A' })).isError).toBe(true)
    await call('browser_snapshot', { tabId: '1' })
    expect((await call('browser_select_option', { tabId: '1', ref: '1-e1', value: 'A' })).isError).toBe(false)
    expect((await call('browser_wait_for', { tabId: '1', text: 'Home' })).isError).toBe(false)
    expect((await call('browser_wait_for', { tabId: '1', expression: 'true' })).isError).toBe(false)
    const waitMissing = await call('browser_wait_for', { tabId: '1' })
    expect(waitMissing.isError).toBe(true)
    const evaluated = await call('browser_evaluate', { tabId: '1', expression: '1+1' })
    expect(evaluated.value).toEqual({ tabId: '1', value: true })
    const emptyEval = await ctx.tools.execute({
      signal,
      callId: ToolCallId('eval-empty'),
      name: 'browser_evaluate',
      arguments: { tabId: '1', expression: 'void 0' },
      agent: owner,
    })
    expect(emptyEval.isError).toBe(false)
    expect((await call('browser_handle_dialog', { tabId: '1', accept: true, promptText: 'ok' })).isError).toBe(false)
    expect((await call('browser_upload', { tabId: '1', ref: '1-e1', paths: ['/tmp/a'] })).isError).toBe(false)
  })

  it('surfaces evaluate exceptions and missing agents', async () => {
    const { ctx, owner } = await mount({
      cdp: method => method === 'Runtime.evaluate' ? { exceptionDetails: { text: 'boom' } } : {},
    })
    await ctx.browser.attach(owner, BrowserTabId('1'))
    const evaluated = await ctx.tools.execute({
      signal,
      callId: ToolCallId('eval'),
      name: 'browser_evaluate',
      arguments: { tabId: '1', expression: 'throw 1' },
      agent: owner,
    })
    expect(evaluated.isError).toBe(true)
    const { ctx: ctx2, owner: owner2 } = await mount({
      cdp: method => method === 'Runtime.evaluate' ? { exceptionDetails: {} } : {},
    })
    await ctx2.browser.attach(owner2, BrowserTabId('1'))
    const nameless = await ctx2.tools.execute({
      signal,
      callId: ToolCallId('eval-nameless'),
      name: 'browser_evaluate',
      arguments: { tabId: '1', expression: 'throw 1' },
      agent: owner2,
    })
    expect(nameless.isError).toBe(true)
    const { ctx: ctx3, owner: owner3 } = await mount({
      cdp: () => ({}),
    })
    await ctx3.browser.attach(owner3, BrowserTabId('1'))
    const nil = await ctx3.tools.execute({
      signal,
      callId: ToolCallId('eval-nil'),
      name: 'browser_evaluate',
      arguments: { tabId: '1', expression: 'void 0' },
      agent: owner3,
    })
    expect(nil.value).toEqual({ tabId: '1', value: null })
    const noAgent = await ctx.tools.execute({
      signal,
      callId: ToolCallId('no-agent'),
      name: 'browser_tabs',
      arguments: {},
    })
    expect(noAgent.isError).toBe(false)
    const attach = await ctx.tools.execute({
      signal,
      callId: ToolCallId('attach'),
      name: 'browser_attach',
      arguments: { tabId: '1' },
    })
    expect(attach.isError).toBe(true)
  })

  it('reads console messages and Chrome-API facets', async () => {
    const { call, owner, ctx, provider } = await mount()
    await ctx.browser.attach(owner, BrowserTabId('1'))
    const pending = call('browser_console', { tabId: '1' })
    await new Promise(resolve => setTimeout(resolve, 10))
    provider.emit({
      tabId: BrowserTabId('1'),
      method: 'Runtime.consoleAPICalled',
      params: { type: 'log', args: [{ value: 'hello' }] },
    })
    provider.emit({
      tabId: BrowserTabId('other'),
      method: 'Runtime.consoleAPICalled',
      params: { type: 'log', args: [{ value: 'skip' }] },
    })
    provider.emit({
      tabId: BrowserTabId('1'),
      method: 'Runtime.consoleAPICalled',
      params: { type: 'info' },
    })
    provider.emit({
      tabId: BrowserTabId('1'),
      method: 'Runtime.consoleAPICalled',
      params: { type: 'debug', args: [{}] },
    })
    provider.emit({
      tabId: BrowserTabId('1'),
      method: 'Log.entryAdded',
      params: {},
    })
    const consoleResult = await pending
    expect(consoleResult.isError).toBe(false)
    expect(consoleResult.value).toEqual({
      messages: [
        { level: 'log', text: 'hello' },
        { level: 'info', text: '' },
        { level: 'debug', text: '' },
      ],
    })
    expect((await call('browser_history_search', { query: 'ex' })).value).toMatchObject({
      items: [{ url: 'https://example.com', title: 'Example' }],
    })
    expect((await call('browser_bookmarks', { title: 'N', url: 'https://n.example' })).isError).toBe(false)
    expect((await call('browser_bookmarks', {})).isError).toBe(false)
    expect((await call('browser_reading_list', { title: 'R', url: 'https://r.example' })).isError).toBe(false)
    expect((await call('browser_reading_list', {})).isError).toBe(false)
    expect((await call('browser_downloads', {})).isError).toBe(false)
  })

  it('registers raw CDP only when allowed and requires approval', async () => {
    const { call, owner, ctx } = await mount({
      config: { allowRawCdp: true, approval: 'never' },
      cdp: () => ({ ok: true }),
    })
    expect(ctx.tools.schemas().map(schema => schema.name)).toContain('browser_cdp')
    await ctx.browser.attach(owner, BrowserTabId('1'))
    const result = await call('browser_cdp', { tabId: '1', method: 'Page.enable', params: {} })
    expect(result.value).toEqual({ tabId: '1', result: { ok: true } })
  })

  it('asks before attaching a user tab', async () => {
    const request = vi.fn(() => Promise.resolve('allowed-once' as const))
    const { call } = await mount({
      config: { approval: 'user-tabs' },
      approval: request,
    })
    const result = await call('browser_attach', { tabId: '1' })
    expect(result.isError).toBe(false)
    expect(request).toHaveBeenCalled()
  })

  it('invokes every presenter and covers remaining tool branches', async () => {
    const { ctx, call, owner, provider } = await mount({
      config: { approval: 'never', allowRawCdp: true, screenshotMaxBytes: 1_000_000 },
      cdp: (method, params) => {
        if (method === 'Runtime.evaluate') {
          const expression = typeof params?.expression === 'string' ? params.expression : ''
          if (expression.includes('innerText')) return { result: { value: 'body' } }
          if (expression.includes('includes')) return { result: { value: false } }
          return { result: { value: { url: 'https://example.com/1', title: 'Home' } } }
        }
        if (method === 'Accessibility.getFullAXTree') {
          return {
            nodes: [
              { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Home' }, childIds: ['2'] },
              { nodeId: '2', backendDOMNodeId: 10, role: { value: 'generic' }, name: { value: 'Named' } },
            ],
          }
        }
        if (method === 'Page.captureScreenshot') return {}
        if (method === 'DOM.getBoxModel') return { model: { content: [1, 2] } }
        return {}
      },
    })
    await ctx.browser.attach(owner, BrowserTabId('1'))
    expect((await call('browser_type', { tabId: '1', text: 'pre', ref: '1-e0' })).isError).toBe(true)
    expect((await call('browser_hover', { tabId: '1', ref: '1-e0' })).isError).toBe(true)
    expect((await call('browser_upload', { tabId: '1', ref: '1-e0', paths: ['/tmp/a'] })).isError).toBe(true)
    const presenterArgs: Record<string, Record<string, unknown>> = {
      browser_tabs: {},
      browser_open: { url: 'https://example.com' },
      browser_attach: { tabId: '1' },
      browser_navigate: { tabId: '1', action: 'reload' },
      browser_snapshot: { tabId: '1' },
      browser_text: { tabId: '1' },
      browser_screenshot: { tabId: '1' },
      browser_click: { tabId: '1', x: 1, y: 2 },
      browser_type: { tabId: '1', text: 'hi' },
      browser_press_key: { tabId: '1', key: 'Enter' },
      browser_scroll: { tabId: '1' },
      browser_select_option: { tabId: '1', ref: '1-e0', value: 'A' },
      browser_wait_for: { tabId: '1', text: 'x' },
      browser_evaluate: { tabId: '1', expression: '1' },
      browser_console: { tabId: '1' },
      browser_close: { tabId: '1' },
      browser_hover: { tabId: '1', x: 1, y: 1 },
      browser_handle_dialog: { tabId: '1', accept: true },
      browser_upload: { tabId: '1', ref: '1-e0', paths: ['/tmp/a'] },
      browser_cdp: { tabId: '1', method: 'Page.enable' },
      browser_history_search: { query: 'q' },
      browser_bookmarks: {},
      browser_reading_list: {},
      browser_downloads: {},
    }
    const dummyResult = { isError: false, content: [] }
    for (const schema of ctx.tools.schemas()) {
      const tool = ctx.tools.get(schema.name)
      const args = presenterArgs[schema.name] ?? {}
      tool?.presentCall?.(args)
      tool?.presentResult?.(args, dummyResult)
      tool?.isConcurrencySafe?.(args)
      tool?.output.render(args, {
        tabs: [{ tabId: '1', title: 'Home', url: 'https://example.com', active: false }],
        messages: [{ level: 'log', text: 'hi' }],
        items: [{ title: 'T', url: 'https://u', hasBeenRead: true, filename: 'f', state: 'complete' }],
        truncated: true, bytes: 2, mimeType: 'image/png',
        result: null, text: '', url: 'u', title: 't', tabId: '1',
      })
      tool?.output.render(args, {
        tabs: [], messages: [], items: [{ title: 'Folder' }], truncated: false, bytes: 2, mimeType: 'image/png',
        result: 1, value: 1, text: 'x', url: 'u', title: 't', tabId: '1',
      })
    }
    ctx.tools.get('browser_wait_for')?.presentCall?.({ tabId: '1', expression: '1' })
    ctx.tools.get('browser_wait_for')?.presentCall?.({ tabId: '1' })
    ctx.tools.get('browser_handle_dialog')?.presentCall?.({ tabId: '1', accept: false })
    ctx.tools.get('browser_click')?.presentCall?.({ tabId: '1', ref: '1-e0' })
    ctx.tools.get('browser_open')?.presentResult?.({ url: 'https://example.com' }, {
      isError: false,
      content: [{ type: 'text', text: 'Opened Home — https://example.com/new [opened]' }],
    })
    expect((await call('browser_screenshot', { tabId: '1' })).value).toMatchObject({ truncated: false })
    expect((await call('browser_click', { tabId: '1', ref: '1-e1' })).isError).toBe(true)
    await call('browser_snapshot', { tabId: '1' })
    expect((await call('browser_click', { tabId: '1', ref: '1-e1' })).isError).toBe(true)
    expect((await call('browser_type', { tabId: '1', text: 'z', ref: '1-e1' })).isError).toBe(false)
    expect((await call('browser_scroll', { tabId: '1' })).isError).toBe(false)
    expect((await call('browser_wait_for', { tabId: '1', text: 'Nope', timeoutMs: 1 })).isError).toBe(false)
    expect((await call('browser_hover', { tabId: '1' })).isError).toBe(true)
    expect((await call('browser_hover', { tabId: '1', ref: 'nope' })).isError).toBe(true)
    expect((await call('browser_hover', { tabId: '1', ref: '1-e1' })).isError).toBe(true)
    expect((await call('browser_handle_dialog', { tabId: '1', accept: false })).isError).toBe(false)
    expect((await call('browser_upload', { tabId: '1', ref: '1-e1', paths: ['/tmp/a'] })).isError).toBe(false)
    expect((await call('browser_snapshot', { tabId: '1' })).isError).toBe(false)
    expect((await call('browser_cdp', { tabId: '1', method: 'Page.enable' })).isError).toBe(false)
    ctx.tools.get('browser_cdp')?.output.render({ tabId: '1', method: 'Page.enable' }, { tabId: '1', result: null })
    const consolePending = call('browser_console', { tabId: '1' })
    await new Promise(resolve => setTimeout(resolve, 10))
    provider.emit({
      tabId: BrowserTabId('1'),
      method: 'Runtime.consoleAPICalled',
      params: { args: [{}] },
    })
    expect((await consolePending).isError).toBe(false)
    expect((await call('browser_history_search', { query: 'none' })).content[0]).toMatchObject({ type: 'text' })
    expect((await call('browser_type', { tabId: '1', text: 'solo' })).isError).toBe(false)
    expect((await call('browser_press_key', { tabId: '1', key: 'a' })).isError).toBe(false)
    expect((await call('browser_select_option', { tabId: '1', ref: '1-e1', value: 'A' })).isError).toBe(false)
    expect((await call('browser_type', { tabId: '1', text: 'root', ref: '1-e0' })).isError).toBe(false)
    expect((await call('browser_select_option', { tabId: '1', ref: '1-e0', value: 'A' })).isError).toBe(false)
    expect((await call('browser_upload', { tabId: '1', ref: '1-e0', paths: ['/tmp/a'] })).isError).toBe(true)
    ctx.tools.get('browser_bookmarks')?.output.render({}, { items: [] })
    ctx.tools.get('browser_reading_list')?.output.render({}, { items: [] })
    ctx.tools.get('browser_history_search')?.output.render({ query: 'q' }, { items: [] })
    ctx.tools.get('browser_downloads')?.output.render({}, { items: [] })
  })

  it('covers evaluate approval, empty facet renders, and wait-for expression timeout', async () => {
    const request = vi.fn(() => Promise.resolve('allowed-once' as const))
    const { call, owner, ctx } = await mount({
      config: { approval: 'always', allowRawCdp: true },
      approval: request,
      provider: {
        ...makeProvider((method) => {
          if (method === 'Runtime.evaluate') return { result: { value: 0 } }
          if (method === 'Accessibility.getFullAXTree') return {}
          if (method === 'Page.enable') return undefined
          return {}
        }),
        historySearch: () => Promise.resolve([]),
        listBookmarks: () => Promise.resolve([{ id: 'b', title: 'Folder' }]),
        createBookmark: item => Promise.resolve({ id: 'b2', title: item.title }),
        // url omitted on purpose so the create-bookmark render omits " — url"
        listReadingList: () => Promise.resolve([{ url: 'https://r', title: 'R', hasBeenRead: true }]),
        addReadingList: item => Promise.resolve({ url: item.url, title: item.title, hasBeenRead: false }),
        listDownloads: () => Promise.resolve([]),
      },
    })
    await ctx.browser.attach(owner, BrowserTabId('1'))
    expect((await call('browser_open', { url: 'https://example.com/new' })).isError).toBe(false)
    expect((await call('browser_evaluate', { tabId: '1', expression: '1' })).isError).toBe(false)
    expect((await call('browser_click', { tabId: '1', x: 1, y: 2 })).isError).toBe(false)
    expect(request).toHaveBeenCalled()
    expect((await call('browser_cdp', { tabId: '1', method: 'Page.enable', params: { a: 1 } })).isError).toBe(false)
    expect((await call('browser_wait_for', { tabId: '1', expression: '0', timeoutMs: 1 })).isError).toBe(false)
    expect((await call('browser_bookmarks', { title: 'N', url: 'https://n.example' })).isError).toBe(false)
    expect((await call('browser_bookmarks', {})).isError).toBe(false)
    expect((await call('browser_reading_list', {})).isError).toBe(false)
    expect((await call('browser_downloads', {})).isError).toBe(false)
    expect((await call('browser_history_search', { query: 'z' })).isError).toBe(false)
    const emptyTabs = await mount({
      config: { approval: 'never' },
      provider: {
        ...makeProvider(),
        listTabs: () => Promise.resolve([]),
      },
    })
    const listed = await emptyTabs.call('browser_tabs', {})
    expect(textOf(listed)).toBe('(no tabs)')
  })
})

describe('approval exhaustive default', () => {
  it('rejects an unhandled approval outcome', async () => {
    await expect(approveBrowserAction({
      mode: 'always',
      kind: 'agent-tab',
      toolName: 'browser_open',
      reason: 'x',
      agent: agent(),
      approval: { request: () => Promise.resolve('yolo' as never) },
    })).rejects.toThrow('unhandled approval outcome')
  })
})
