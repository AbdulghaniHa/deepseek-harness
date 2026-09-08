/**
 * Register every `browser_*` tool on `ctx.tools`.
 * @module @deepseek-ai/dsh-tool-browser/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { BrowserTabId } from '@deepseek-ai/dsh-browser'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { BrowserSnapshot } from './snapshot.ts'
import { buildSnapshot, resolveRef } from './snapshot.ts'
import { approveBrowserAction, type BrowserApprovalMode } from './approval.ts'
import { browserMetaFromValue, formatSnapshot, presentBrowserCall, presentBrowserResult } from './present.ts'
import { cdpClient, clickAt, nodeCenter, pageIdentity, typeText } from './cdp.ts'
import type { BrowserApprover } from './approval.ts'

/** Resolved tool-browser config used while registering tools. */
export interface ToolBrowserOptions {
  readonly approval: BrowserApprovalMode
  readonly snapshotMaxNodes: number
  readonly screenshotMaxBytes: number
  readonly evaluateTimeoutMs: number
  readonly allowRawCdp: boolean
  readonly timeoutMs: number
}

interface TabState {
  epoch: number
  snapshot: BrowserSnapshot | undefined
}

/**
 * Register Phase 1 and Phase 2 browser tools.
 * @param ctx - host context with tools + browser.
 * @param options - resolved config.
 */
export function registerBrowserTools(ctx: Context, options: ToolBrowserOptions): void {
  const states = new Map<string, TabState>()
  const approval = ctx.get('approval') as BrowserApprover | undefined

  const requireOwner = (agent: Agent | undefined): Agent => {
    if (agent === undefined) throw new Error('browser tools require an agent')
    return agent
  }

  const tabState = (tabId: string): TabState => {
    const existing = states.get(tabId)
    if (existing !== undefined) return existing
    const created: TabState = { epoch: 1, snapshot: undefined }
    states.set(tabId, created)
    return created
  }

  const bumpEpoch = (tabId: string): TabState => {
    const state = tabState(tabId)
    state.epoch += 1
    state.snapshot = undefined
    return state
  }

  const snapshotTab = async (owner: Agent, tabId: ReturnType<typeof BrowserTabId>, signal?: AbortSignal): Promise<BrowserSnapshot> => {
    const cdp = cdpClient(ctx.browser, owner, tabId, signal)
    const identity = await pageIdentity(cdp)
    const tree = await cdp.send('Accessibility.getFullAXTree') as { nodes?: unknown[] }
    const state = tabState(tabId)
    const snapshot = buildSnapshot((tree.nodes ?? []) as never, {
      url: identity.url,
      title: identity.title,
      epoch: state.epoch,
      maxNodes: options.snapshotMaxNodes,
    })
    state.snapshot = snapshot
    return snapshot
  }

  const previewProperties = {
    screenshot: { type: 'string' },
    previewError: { type: 'string' },
  } as const

  const previewValue = async (owner: Agent, tabId: ReturnType<typeof BrowserTabId>, signal?: AbortSignal) => {
    try {
      const preview = await ctx.browser.preview(owner, tabId, signal)
      return { url: preview.url, title: preview.title, media: { screenshot: preview.screenshot } }
    } catch (error) {
      // Preview failure must not turn a completed browser action into a retryable tool failure.
      return { url: '', title: '', media: { previewError: error instanceof Error ? error.message : String(error) } }
    }
  }

  const snapshotValue = async (owner: Agent, tabId: string, snapshot: BrowserSnapshot, signal?: AbortSignal) => {
    // Snapshot results carry their own page identity; only the capture is added.
    const preview = await previewValue(owner, BrowserTabId(tabId), signal)
    return {
      tabId,
      url: snapshot.url,
      title: snapshot.title,
      text: snapshot.text,
      truncated: snapshot.truncated,
      ...preview.media,
    }
  }

  const commonMeta = (_args: unknown, value: Record<string, unknown>) => browserMetaFromValue(value)

  ctx.tools.register(defineTool({
    name: 'browser_tabs',
    description: 'List open Chrome tabs across all windows.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tabs: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                tabId: { type: 'string', required: true },
                url: { type: 'string', required: true },
                title: { type: 'string', required: true },
                active: { type: 'boolean', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.tabs.map(tab => `- [${tab.tabId}] ${tab.title} — ${tab.url}${tab.active ? ' (active)' : ''}`).join('\n') || '(no tabs)',
      }],
      presentationMeta: commonMeta,
    },
    timeoutMs: options.timeoutMs,
    isConcurrencySafe: () => true,
    execute: async (_args, exec) => {
      const tabs = await ctx.browser.listTabs(exec.signal)
      return {
        tabs: tabs.map(tab => ({ tabId: tab.id, url: tab.url, title: tab.title, active: tab.active })),
      }
    },
    presentCall: () => presentBrowserCall('List tabs', 'fetch'),
    presentResult: () => presentBrowserResult('Tabs'),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_open',
    description: 'Open a URL in a new Chrome tab and attach to it.',
    parameters: {
      url: { type: 'string', required: true, description: 'http(s) URL to open.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tabId: { type: 'string', required: true },
          url: { type: 'string', required: true },
          title: { type: 'string', required: true },
          ...previewProperties,
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Opened ${value.title} — ${value.url} [${value.tabId}]` }],
      presentationMeta: commonMeta,
    },
    timeoutMs: options.timeoutMs,
    execute: async (args, exec) => {
      const owner = requireOwner(exec.agent)
      await approveBrowserAction({
        mode: options.approval,
        kind: 'agent-tab',
        ...approval !== undefined ? { approval } : {},
        agent: owner,
        toolName: 'browser_open',
        callId: exec.callId,
        reason: `open ${args.url}`,
        signal: exec.signal,
      })
      const opened = await ctx.browser.openTab(owner, { url: args.url, group: true }, exec.signal)
      const preview = await previewValue(owner, opened.tab.id, exec.signal)
      // A tab opened moments ago has not committed its URL yet; the capture's
      // identity names the page it landed on.
      return {
        tabId: opened.tab.id,
        url: opened.tab.url === '' ? preview.url || args.url : opened.tab.url,
        title: opened.tab.title === '' ? preview.title : opened.tab.title,
        ...preview.media,
      }
    },
    presentCall: args => presentBrowserCall(`Open ${args.url}`, 'fetch'),
    presentResult: (_args, result) => presentBrowserResult('Opened', result.content[0]?.type === 'text' ? result.content[0].text : undefined),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_attach',
    description: 'Attach to an existing Chrome tab so later browser_* calls can drive it. Requires approval because this reuses the user\'s logged-in session.',
    parameters: {
      tabId: { type: 'string', required: true, description: 'Tab id from browser_tabs.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { tabId: { type: 'string', required: true }, attached: { type: 'boolean', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: `Attached to tab ${value.tabId}` }],
      presentationMeta: commonMeta,
    },
    timeoutMs: options.timeoutMs,
    execute: async (args, exec) => {
      const owner = requireOwner(exec.agent)
      await approveBrowserAction({
        mode: options.approval,
        kind: 'user-tab',
        ...approval !== undefined ? { approval } : {},
        agent: owner,
        toolName: 'browser_attach',
        callId: exec.callId,
        reason: `attach to existing tab ${args.tabId}`,
        signal: exec.signal,
      })
      await ctx.browser.attach(owner, BrowserTabId(args.tabId), exec.signal)
      return { tabId: args.tabId, attached: true }
    },
    presentCall: args => presentBrowserCall(`Attach ${args.tabId}`, 'execute'),
    presentResult: () => presentBrowserResult('Attached'),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_navigate',
    description: 'Navigate an attached tab: goto, back, forward, or reload.',
    parameters: {
      tabId: { type: 'string', required: true },
      action: { type: 'string', required: true, enum: ['goto', 'back', 'forward', 'reload'] },
      url: { type: 'string', description: 'Required when action is goto.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tabId: { type: 'string', required: true },
          url: { type: 'string', required: true },
          title: { type: 'string', required: true },
          ...previewProperties,
          text: { type: 'string', required: true },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatSnapshot(value) }],
      presentationMeta: commonMeta,
    },
    timeoutMs: options.timeoutMs,
    execute: async (args, exec) => {
      const owner = requireOwner(exec.agent)
      const tabId = BrowserTabId(args.tabId)
      const cdp = cdpClient(ctx.browser, owner, tabId, exec.signal)
      if (args.action === 'goto') {
        if (args.url === undefined) throw new Error('url is required when action is goto')
        await cdp.send('Page.navigate', { url: args.url })
      } else if (args.action === 'back') {
        await cdp.send('Runtime.evaluate', { expression: 'history.back()' })
      } else if (args.action === 'forward') {
        await cdp.send('Runtime.evaluate', { expression: 'history.forward()' })
      } else {
        await cdp.send('Page.reload')
      }
      bumpEpoch(args.tabId)
      return snapshotValue(owner, args.tabId, await snapshotTab(owner, tabId, exec.signal), exec.signal)
    },
    presentCall: args => presentBrowserCall(`${args.action} ${args.url ?? args.tabId}`, 'fetch'),
    presentResult: () => presentBrowserResult('Navigated'),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_snapshot',
    description: 'Capture a ref-annotated accessibility outline of the attached tab.',
    parameters: { tabId: { type: 'string', required: true } },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tabId: { type: 'string', required: true },
          url: { type: 'string', required: true },
          title: { type: 'string', required: true },
          ...previewProperties,
          text: { type: 'string', required: true },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatSnapshot(value) }],
      presentationMeta: commonMeta,
    },
    timeoutMs: options.timeoutMs,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      const owner = requireOwner(exec.agent)
      return snapshotValue(owner, args.tabId, await snapshotTab(owner, BrowserTabId(args.tabId), exec.signal), exec.signal)
    },
    presentCall: args => presentBrowserCall(`Snapshot ${args.tabId}`, 'fetch'),
    presentResult: () => presentBrowserResult('Snapshot'),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_text',
    description: 'Read visible text from an attached tab.',
    parameters: { tabId: { type: 'string', required: true } },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { tabId: { type: 'string', required: true }, text: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    timeoutMs: options.timeoutMs,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      const cdp = cdpClient(ctx.browser, requireOwner(exec.agent), BrowserTabId(args.tabId), exec.signal)
      const result = await cdp.send('Runtime.evaluate', {
        expression: 'document.body?.innerText ?? ""',
        returnByValue: true,
      }) as { result?: { value?: string } }
      return { tabId: args.tabId, text: result.result?.value ?? '' }
    },
    presentCall: args => presentBrowserCall(`Text ${args.tabId}`, 'fetch'),
    presentResult: () => presentBrowserResult('Text'),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_screenshot',
    description: 'Capture a PNG screenshot of an attached tab. Oversized images are summarized instead of inlined.',
    parameters: {
      tabId: { type: 'string', required: true },
      fullPage: { type: 'boolean', description: 'Capture the full page instead of the viewport.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tabId: { type: 'string', required: true },
          mimeType: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
          screenshot: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.truncated
          ? `Screenshot captured (${value.bytes} bytes) exceeded screenshotMaxBytes and was omitted.`
          : `Screenshot captured (${value.bytes} bytes, ${value.mimeType}).`,
      }],
      presentationMeta: commonMeta,
    },
    timeoutMs: options.timeoutMs,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      const cdp = cdpClient(ctx.browser, requireOwner(exec.agent), BrowserTabId(args.tabId), exec.signal)
      const shot = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: args.fullPage === true,
      }) as { data?: string }
      const data = shot.data ?? ''
      const bytes = Math.ceil(data.length * 0.75)
      if (bytes > options.screenshotMaxBytes) {
        return { tabId: args.tabId, mimeType: 'image/png', bytes, truncated: true }
      }
      return { tabId: args.tabId, mimeType: 'image/png', bytes, truncated: false, screenshot: data }
    },
    presentCall: args => presentBrowserCall(`Screenshot ${args.tabId}`, 'fetch'),
    presentResult: () => presentBrowserResult('Screenshot'),
  }))

  const interactSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      tabId: { type: 'string', required: true },
      url: { type: 'string', required: true },
      title: { type: 'string', required: true },
      ...previewProperties,
      text: { type: 'string', required: true },
      truncated: { type: 'boolean', required: true },
    },
  } as const

  ctx.tools.register(defineTool({
    name: 'browser_click',
    description: 'Click a snapshot ref or raw viewport coordinates on an attached tab.',
    parameters: {
      tabId: { type: 'string', required: true },
      ref: { type: 'string', description: 'Snapshot ref from browser_snapshot.' },
      x: { type: 'number', description: 'Viewport x when not using a ref.' },
      y: { type: 'number', description: 'Viewport y when not using a ref.' },
    },
    output: { schema: interactSchema, render: (_args, value) => [{ type: 'text', text: formatSnapshot(value) }], presentationMeta: commonMeta },
    timeoutMs: options.timeoutMs,
    execute: async (args, exec) => {
      const owner = requireOwner(exec.agent)
      const tabId = BrowserTabId(args.tabId)
      await approveBrowserAction({
        mode: options.approval,
        kind: 'agent-tab',
        ...approval !== undefined ? { approval } : {},
        agent: owner,
        toolName: 'browser_click',
        callId: exec.callId,
        reason: `click on tab ${args.tabId}`,
        signal: exec.signal,
      })
      const cdp = cdpClient(ctx.browser, owner, tabId, exec.signal)
      let x = args.x
      let y = args.y
      if (args.ref !== undefined) {
        const state = tabState(args.tabId)
        if (state.snapshot === undefined) throw new Error('take a browser_snapshot before clicking a ref')
        const node = resolveRef(args.ref, state.snapshot)
        if (node.backendNodeId === undefined) throw new Error(`snapshot ref "${args.ref}" has no backend node`)
        const center = await nodeCenter(cdp, node.backendNodeId)
        if (center === undefined) throw new Error(`snapshot ref "${args.ref}" has no box model`)
        x = center.x
        y = center.y
      }
      if (x === undefined || y === undefined) throw new Error('browser_click needs a ref or x/y')
      await clickAt(cdp, x, y)
      return snapshotValue(owner, args.tabId, await snapshotTab(owner, tabId, exec.signal), exec.signal)
    },
    presentCall: args => presentBrowserCall(`Click ${args.ref ?? `${args.x},${args.y}`}`, 'execute'),
    presentResult: () => presentBrowserResult('Clicked'),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_type',
    description: 'Type text into the focused field on an attached tab.',
    parameters: {
      tabId: { type: 'string', required: true },
      text: { type: 'string', required: true },
      ref: { type: 'string', description: 'Optional snapshot ref to focus first.' },
      clear: { type: 'boolean', description: 'Select-all before typing.' },
      submit: { type: 'boolean', description: 'Press Enter after typing.' },
    },
    output: { schema: interactSchema, render: (_args, value) => [{ type: 'text', text: formatSnapshot(value) }], presentationMeta: commonMeta },
    timeoutMs: options.timeoutMs,
    execute: async (args, exec) => {
      const owner = requireOwner(exec.agent)
      const tabId = BrowserTabId(args.tabId)
      const cdp = cdpClient(ctx.browser, owner, tabId, exec.signal)
      if (args.ref !== undefined) {
        const state = tabState(args.tabId)
        if (state.snapshot === undefined) throw new Error('take a browser_snapshot before typing into a ref')
        const node = resolveRef(args.ref, state.snapshot)
        if (node.backendNodeId !== undefined) {
          const center = await nodeCenter(cdp, node.backendNodeId)
          if (center !== undefined) await clickAt(cdp, center.x, center.y)
        }
      }
      if (args.clear === true) {
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', modifiers: 2 })
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', modifiers: 2 })
      }
      await typeText(cdp, args.text)
      if (args.submit === true) {
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter' })
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter' })
      }
      return snapshotValue(owner, args.tabId, await snapshotTab(owner, tabId, exec.signal), exec.signal)
    },
    presentCall: args => presentBrowserCall(`Type ${args.text}`, 'execute'),
    presentResult: () => presentBrowserResult('Typed'),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_press_key',
    description: 'Press a single key with optional modifiers on an attached tab.',
    parameters: {
      tabId: { type: 'string', required: true },
      key: { type: 'string', required: true },
      modifiers: { type: 'integer', description: 'CDP modifier bitmask.' },
    },
    output: { schema: interactSchema, render: (_args, value) => [{ type: 'text', text: formatSnapshot(value) }], presentationMeta: commonMeta },
    timeoutMs: options.timeoutMs,
    execute: async (args, exec) => {
      const owner = requireOwner(exec.agent)
      const tabId = BrowserTabId(args.tabId)
      const cdp = cdpClient(ctx.browser, owner, tabId, exec.signal)
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: args.key, ...args.modifiers !== undefined ? { modifiers: args.modifiers } : {} })
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: args.key, ...args.modifiers !== undefined ? { modifiers: args.modifiers } : {} })
      return snapshotValue(owner, args.tabId, await snapshotTab(owner, tabId, exec.signal), exec.signal)
    },
    presentCall: args => presentBrowserCall(`Key ${args.key}`, 'execute'),
    presentResult: () => presentBrowserResult('Key'),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_scroll',
    description: 'Scroll the page or a snapshot ref on an attached tab.',
    parameters: {
      tabId: { type: 'string', required: true },
      deltaX: { type: 'number' },
      deltaY: { type: 'number' },
    },
    output: { schema: interactSchema, render: (_args, value) => [{ type: 'text', text: formatSnapshot(value) }], presentationMeta: commonMeta },
    timeoutMs: options.timeoutMs,
    execute: async (args, exec) => {
      const owner = requireOwner(exec.agent)
      const tabId = BrowserTabId(args.tabId)
      const cdp = cdpClient(ctx.browser, owner, tabId, exec.signal)
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: 0,
        y: 0,
        deltaX: args.deltaX ?? 0,
        deltaY: args.deltaY ?? 400,
      })
      return snapshotValue(owner, args.tabId, await snapshotTab(owner, tabId, exec.signal), exec.signal)
    },
    presentCall: () => presentBrowserCall('Scroll', 'execute'),
    presentResult: () => presentBrowserResult('Scrolled'),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_select_option',
    description: 'Choose a select option by visible text on an attached tab.',
    parameters: {
      tabId: { type: 'string', required: true },
      ref: { type: 'string', required: true },
      value: { type: 'string', required: true },
    },
    output: { schema: interactSchema, render: (_args, value) => [{ type: 'text', text: formatSnapshot(value) }], presentationMeta: commonMeta },
    timeoutMs: options.timeoutMs,
    execute: async (args, exec) => {
      const owner = requireOwner(exec.agent)
      const tabId = BrowserTabId(args.tabId)
      const state = tabState(args.tabId)
      if (state.snapshot === undefined) throw new Error('take a browser_snapshot before selecting an option')
      const node = resolveRef(args.ref, state.snapshot)
      const cdp = cdpClient(ctx.browser, owner, tabId, exec.signal)
      if (node.backendNodeId !== undefined) {
        await cdp.send('DOM.focus', { backendNodeId: node.backendNodeId })
      }
      await cdp.send('Runtime.evaluate', {
        expression: `document.activeElement && [...document.activeElement.options].some(o => { if (o.text === ${JSON.stringify(args.value)} || o.value === ${JSON.stringify(args.value)}) { o.selected = true; document.activeElement.dispatchEvent(new Event('change', { bubbles: true })); return true } return false })`,
        returnByValue: true,
      })
      return snapshotValue(owner, args.tabId, await snapshotTab(owner, tabId, exec.signal), exec.signal)
    },
    presentCall: args => presentBrowserCall(`Select ${args.value}`, 'execute'),
    presentResult: () => presentBrowserResult('Selected'),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_wait_for',
    description: 'Wait until text appears or a JS expression is truthy on an attached tab.',
    parameters: {
      tabId: { type: 'string', required: true },
      text: { type: 'string' },
      expression: { type: 'string' },
      timeoutMs: { type: 'integer' },
    },
    output: { schema: interactSchema, render: (_args, value) => [{ type: 'text', text: formatSnapshot(value) }], presentationMeta: commonMeta },
    timeoutMs: options.timeoutMs,
    execute: async (args, exec) => {
      const owner = requireOwner(exec.agent)
      const tabId = BrowserTabId(args.tabId)
      const cdp = cdpClient(ctx.browser, owner, tabId, exec.signal)
      const deadline = Date.now() + (args.timeoutMs ?? 5000)
      while (Date.now() < deadline) {
        exec.signal.throwIfAborted()
        if (args.text !== undefined) {
          const result = await cdp.send('Runtime.evaluate', {
            expression: `document.body?.innerText?.includes(${JSON.stringify(args.text)}) === true`,
            returnByValue: true,
          }) as { result?: { value?: boolean } }
          if (result.result?.value === true) break
        } else if (args.expression !== undefined) {
          const result = await cdp.send('Runtime.evaluate', {
            expression: args.expression,
            returnByValue: true,
            awaitPromise: true,
          }) as { result?: { value?: unknown } }
          if (result.result?.value) break
        } else {
          throw new Error('browser_wait_for needs text or expression')
        }
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      return snapshotValue(owner, args.tabId, await snapshotTab(owner, tabId, exec.signal), exec.signal)
    },
    presentCall: args => presentBrowserCall(`Wait ${args.text ?? args.expression ?? ''}`, 'fetch'),
    presentResult: () => presentBrowserResult('Waited'),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_evaluate',
    description: 'Run a JavaScript expression in the attached tab and return a JSON value. Requires approval.',
    parameters: {
      tabId: { type: 'string', required: true },
      expression: { type: 'string', required: true },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { tabId: { type: 'string', required: true }, value: { type: 'json' } },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value.value ?? null, null, 2) }],
    },
    timeoutMs: options.evaluateTimeoutMs,
    execute: async (args, exec) => {
      const owner = requireOwner(exec.agent)
      await approveBrowserAction({
        mode: options.approval === 'never' ? 'never' : 'always',
        kind: 'agent-tab',
        ...approval !== undefined ? { approval } : {},
        agent: owner,
        toolName: 'browser_evaluate',
        callId: exec.callId,
        reason: `evaluate JavaScript on tab ${args.tabId}`,
        signal: exec.signal,
      })
      const cdp = cdpClient(ctx.browser, owner, BrowserTabId(args.tabId), exec.signal)
      const result = await cdp.send('Runtime.evaluate', {
        expression: args.expression,
        returnByValue: true,
        awaitPromise: true,
      }) as { result?: { value?: unknown }; exceptionDetails?: { text?: string } }
      if (result.exceptionDetails !== undefined) {
        throw new Error(result.exceptionDetails.text ?? 'evaluate threw')
      }
      return { tabId: args.tabId, value: (result.result?.value ?? null) as JsonValue }
    },
    presentCall: args => presentBrowserCall(`Evaluate ${args.expression}`, 'execute'),
    presentResult: () => presentBrowserResult('Evaluated'),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_console',
    description: 'Read recent console messages from an attached tab.',
    parameters: { tabId: { type: 'string', required: true } },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          messages: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                level: { type: 'string', required: true },
                text: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.messages.map(message => `[${message.level}] ${message.text}`).join('\n') || '(no console messages)',
      }],
    },
    timeoutMs: options.timeoutMs,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      const cdp = cdpClient(ctx.browser, requireOwner(exec.agent), BrowserTabId(args.tabId), exec.signal)
      await cdp.send('Runtime.enable')
      await cdp.send('Console.enable')
      const messages: { level: string; text: string }[] = []
      const stop = ctx.browser.onCdpEvent((event) => {
        if (event.tabId !== args.tabId) return
        if (event.method === 'Runtime.consoleAPICalled') {
          const params = event.params as { type?: string; args?: { value?: unknown }[] }
          messages.push({
            level: params.type ?? 'log',
            text: (params.args ?? []).map(arg => typeof arg.value === 'string' ? arg.value : '').join(' '),
          })
        }
      })
      await new Promise(resolve => setTimeout(resolve, 50))
      stop()
      return { messages }
    },
    presentCall: () => presentBrowserCall('Console', 'fetch'),
    presentResult: () => presentBrowserResult('Console'),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_close',
    description: 'Close an attached Chrome tab.',
    parameters: { tabId: { type: 'string', required: true } },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { tabId: { type: 'string', required: true }, closed: { type: 'boolean', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: `Closed tab ${value.tabId}` }],
    },
    timeoutMs: options.timeoutMs,
    execute: async (args, exec) => {
      const owner = requireOwner(exec.agent)
      await ctx.browser.closeTab(owner, BrowserTabId(args.tabId), exec.signal)
      states.delete(args.tabId)
      return { tabId: args.tabId, closed: true }
    },
    presentCall: args => presentBrowserCall(`Close ${args.tabId}`, 'execute'),
    presentResult: () => presentBrowserResult('Closed'),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_hover',
    description: 'Hover a snapshot ref or viewport coordinates without clicking.',
    parameters: {
      tabId: { type: 'string', required: true },
      ref: { type: 'string' },
      x: { type: 'number' },
      y: { type: 'number' },
    },
    output: { schema: interactSchema, render: (_args, value) => [{ type: 'text', text: formatSnapshot(value) }], presentationMeta: commonMeta },
    timeoutMs: options.timeoutMs,
    execute: async (args, exec) => {
      const owner = requireOwner(exec.agent)
      const tabId = BrowserTabId(args.tabId)
      const cdp = cdpClient(ctx.browser, owner, tabId, exec.signal)
      let x = args.x
      let y = args.y
      if (args.ref !== undefined) {
        const state = tabState(args.tabId)
        if (state.snapshot === undefined) throw new Error('take a browser_snapshot before hovering a ref')
        const node = resolveRef(args.ref, state.snapshot)
        if (node.backendNodeId !== undefined) {
          const center = await nodeCenter(cdp, node.backendNodeId)
          if (center !== undefined) {
            x = center.x
            y = center.y
          }
        }
      }
      if (x === undefined || y === undefined) throw new Error('browser_hover needs a ref or x/y')
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
      return snapshotValue(owner, args.tabId, await snapshotTab(owner, tabId, exec.signal), exec.signal)
    },
    presentCall: () => presentBrowserCall('Hover', 'execute'),
    presentResult: () => presentBrowserResult('Hovered'),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_handle_dialog',
    description: 'Accept or dismiss a JavaScript alert, confirm, or prompt.',
    parameters: {
      tabId: { type: 'string', required: true },
      accept: { type: 'boolean', required: true },
      promptText: { type: 'string' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { tabId: { type: 'string', required: true }, handled: { type: 'boolean', required: true } },
      },
      render: () => [{ type: 'text', text: 'Handled dialog' }],
    },
    timeoutMs: options.timeoutMs,
    execute: async (args, exec) => {
      const cdp = cdpClient(ctx.browser, requireOwner(exec.agent), BrowserTabId(args.tabId), exec.signal)
      await cdp.send('Page.handleJavaScriptDialog', {
        accept: args.accept,
        ...args.promptText !== undefined ? { promptText: args.promptText } : {},
      })
      return { tabId: args.tabId, handled: true }
    },
    presentCall: args => presentBrowserCall(args.accept ? 'Accept dialog' : 'Dismiss dialog', 'execute'),
    presentResult: () => presentBrowserResult('Dialog'),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_upload',
    description: 'Set files on a file input identified by a snapshot ref.',
    parameters: {
      tabId: { type: 'string', required: true },
      ref: { type: 'string', required: true },
      paths: { type: 'array', required: true, items: { type: 'string' } },
    },
    output: { schema: interactSchema, render: (_args, value) => [{ type: 'text', text: formatSnapshot(value) }], presentationMeta: commonMeta },
    timeoutMs: options.timeoutMs,
    execute: async (args, exec) => {
      const owner = requireOwner(exec.agent)
      const tabId = BrowserTabId(args.tabId)
      const state = tabState(args.tabId)
      if (state.snapshot === undefined) throw new Error('take a browser_snapshot before uploading')
      const node = resolveRef(args.ref, state.snapshot)
      if (node.backendNodeId === undefined) throw new Error(`snapshot ref "${args.ref}" has no backend node`)
      const cdp = cdpClient(ctx.browser, owner, tabId, exec.signal)
      await cdp.send('DOM.setFileInputFiles', { backendNodeId: node.backendNodeId, files: args.paths })
      return snapshotValue(owner, args.tabId, await snapshotTab(owner, tabId, exec.signal), exec.signal)
    },
    presentCall: () => presentBrowserCall('Upload', 'execute'),
    presentResult: () => presentBrowserResult('Uploaded'),
  }))

  if (options.allowRawCdp) {
    ctx.tools.register(defineTool({
      name: 'browser_cdp',
      description: 'Send a raw Chrome DevTools Protocol command to an attached tab. Disabled unless allowRawCdp is true.',
      parameters: {
        tabId: { type: 'string', required: true },
        method: { type: 'string', required: true },
        params: { type: 'json' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { tabId: { type: 'string', required: true }, result: { type: 'json' } },
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value.result ?? null, null, 2) }],
      },
      timeoutMs: options.timeoutMs,
      execute: async (args, exec) => {
        const owner = requireOwner(exec.agent)
        await approveBrowserAction({
          mode: options.approval === 'never' ? 'never' : 'always',
          kind: 'agent-tab',
          ...approval !== undefined ? { approval } : {},
          agent: owner,
          toolName: 'browser_cdp',
          callId: exec.callId,
          reason: `raw CDP ${args.method}`,
          signal: exec.signal,
        })
        const result = await ctx.browser.cdp(owner, {
          tabId: BrowserTabId(args.tabId),
          method: args.method,
          ...args.params !== undefined && typeof args.params === 'object' && args.params !== null
            ? { params: args.params as Record<string, unknown> }
            : {},
        }, exec.signal)
        /* v8 ignore next -- CDP result is null when the host returns undefined. */
        return { tabId: args.tabId, result: (result ?? null) as JsonValue }
      },
      presentCall: args => presentBrowserCall(`CDP ${args.method}`, 'execute'),
      presentResult: () => presentBrowserResult('CDP'),
    }))
  }

  ctx.tools.register(defineTool({
    name: 'browser_history_search',
    description: 'Search the user\'s Chrome browsing history.',
    parameters: { query: { type: 'string', required: true } },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          items: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                url: { type: 'string', required: true },
                title: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.items.map(item => `- ${item.title} — ${item.url}`).join('\n') || '(no history matches)',
      }],
    },
    timeoutMs: options.timeoutMs,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      const items = await ctx.browser.historySearch(args.query, exec.signal)
      return { items: items.map(item => ({ url: item.url, title: item.title })) }
    },
    presentCall: args => presentBrowserCall(`History ${args.query}`, 'fetch'),
    presentResult: () => presentBrowserResult('History'),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_bookmarks',
    description: 'List Chrome bookmarks, or create one when title and url are supplied.',
    parameters: {
      title: { type: 'string' },
      url: { type: 'string' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          items: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                title: { type: 'string', required: true },
                url: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.items.map(item => `- ${item.title}${item.url !== undefined ? ` — ${item.url}` : ''}`).join('\n') || '(no bookmarks)',
      }],
    },
    timeoutMs: options.timeoutMs,
    execute: async (args, exec) => {
      if (args.title !== undefined && args.url !== undefined) {
        const created = await ctx.browser.createBookmark({ title: args.title, url: args.url }, exec.signal)
        return { items: [{ title: created.title, ...created.url !== undefined ? { url: created.url } : {} }] }
      }
      const items = await ctx.browser.listBookmarks(exec.signal)
      return { items: items.map(item => ({ title: item.title, ...item.url !== undefined ? { url: item.url } : {} })) }
    },
    presentCall: () => presentBrowserCall('Bookmarks', 'fetch'),
    presentResult: () => presentBrowserResult('Bookmarks'),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_reading_list',
    description: 'List the Chrome reading list, or add an entry when title and url are supplied.',
    parameters: {
      title: { type: 'string' },
      url: { type: 'string' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          items: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                title: { type: 'string', required: true },
                url: { type: 'string', required: true },
                hasBeenRead: { type: 'boolean', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.items.map(item => `- ${item.title} — ${item.url}${item.hasBeenRead ? ' (read)' : ''}`).join('\n') || '(empty reading list)',
      }],
    },
    timeoutMs: options.timeoutMs,
    execute: async (args, exec) => {
      if (args.title !== undefined && args.url !== undefined) {
        const created = await ctx.browser.addReadingList({ title: args.title, url: args.url }, exec.signal)
        return { items: [created] }
      }
      return { items: [...await ctx.browser.listReadingList(exec.signal)] }
    },
    presentCall: () => presentBrowserCall('Reading list', 'fetch'),
    presentResult: () => presentBrowserResult('Reading list'),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_downloads',
    description: 'List recent Chrome downloads.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          items: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                filename: { type: 'string', required: true },
                url: { type: 'string', required: true },
                state: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.items.map(item => `- ${item.filename} (${item.state}) — ${item.url}`).join('\n') || '(no downloads)',
      }],
    },
    timeoutMs: options.timeoutMs,
    isConcurrencySafe: () => true,
    execute: async (_args, exec) => {
      const items = await ctx.browser.listDownloads(exec.signal)
      return { items: items.map(item => ({ filename: item.filename, url: item.url, state: item.state })) }
    },
    presentCall: () => presentBrowserCall('Downloads', 'fetch'),
    presentResult: () => presentBrowserResult('Downloads'),
  }))
}
