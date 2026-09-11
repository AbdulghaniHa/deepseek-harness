/**
 * Register every `browser_*` tool on `ctx.tools`.
 * @module @deepseek-ai/dsh-tool-browser/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { BrowserDownloadId, BrowserError, BrowserFrameId, BrowserTabId, type BrowserFrame } from '@deepseek-ai/dsh-browser'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { BrowserSnapshot, SnapshotNode } from './snapshot.ts'
import { buildSnapshot, resolveRef } from './snapshot.ts'
import { flattenFrameTree, assertSameFrame, type FrameTreeNode } from './frames.ts'
import { boundResponseBody, createNetworkCapture, type NetworkRequestEntry } from './network.ts'
import { approveBrowserAction, type BrowserApprovalMode } from './approval.ts'
import {
  browserMetaFromValue,
  formatNetworkBody,
  formatNetworkList,
  formatSnapshot,
  presentBrowserCall,
  presentBrowserResult,
} from './present.ts'
import { cdpClient, clickAt, dragAt, nodeCenter, pageIdentity, typeText, type CdpClient } from './cdp.ts'
import type { BrowserApprover } from './approval.ts'

/** Resolved tool-browser config used while registering tools. */
export interface ToolBrowserOptions {
  readonly approval: BrowserApprovalMode
  readonly snapshotMaxNodes: number
  readonly screenshotMaxBytes: number
  readonly evaluateTimeoutMs: number
  readonly allowRawCdp: boolean
  readonly networkMaxRequests: number
  readonly networkMaxBodyBytes: number
  readonly timeoutMs: number
}

/** Default entry ceiling when the caller omits `limit`. */
const DEFAULT_NETWORK_LIMIT = 50

interface AttachedTarget {
  sessionId: string
  targetId: string
  url: string
  type: string
}

interface TabState {
  epoch: number
  snapshot: BrowserSnapshot | undefined
  frames: BrowserFrame[]
  targets: AttachedTarget[]
}

/**
 * Result of a tool that reports page identity and completion, with an optional
 * capture and an optional observation error after a completed interaction.
 */
interface BrowserPageValue {
  tabId: string
  url: string
  title: string
  text: string
  truncated: boolean
  screenshot?: string
  previewError?: string
  frameId?: string
  observationError?: string
}

/**
 * Register Phase 1 and Phase 2 browser tools.
 * @param ctx - host context with tools + browser.
 * @param options - resolved config.
 */
export function registerBrowserTools(ctx: Context, options: ToolBrowserOptions): void {
  const states = new Map<string, TabState>()
  const approval = ctx.get('approval') as BrowserApprover | undefined
  const capture = createNetworkCapture({ maxRequests: options.networkMaxRequests })
  ctx.effect(() => ctx.browser.onCdpEvent((event) => {
    capture.record(event)
    const tabKey = String(event.tabId)
    if (event.method === 'Target.attachedToTarget') {
      const info = event.params.targetInfo
      const sessionId = typeof event.params.sessionId === 'string' ? event.params.sessionId : event.sessionId
      if (typeof sessionId === 'string' && sessionId.length > 0 && info !== null && typeof info === 'object') {
        const target = info as { targetId?: unknown; url?: unknown; type?: unknown }
        tabState(tabKey).targets.push({
          sessionId,
          targetId: typeof target.targetId === 'string' ? target.targetId : '',
          url: typeof target.url === 'string' ? target.url : '',
          type: typeof target.type === 'string' ? target.type : '',
        })
      }
    }
    if (event.method === 'Target.detachedFromTarget') {
      const sessionId = typeof event.params.sessionId === 'string' ? event.params.sessionId : event.sessionId
      const current = tabState(tabKey)
      current.targets = current.targets.filter(item => item.sessionId !== sessionId)
      bumpEpoch(tabKey)
    }
    if (event.method === 'Page.frameNavigated' || event.method === 'Page.frameDetached') {
      bumpEpoch(tabKey)
    }
  }), 'tool-browser network capture')

  const requireOwner = (agent: Agent | undefined): Agent => {
    if (agent === undefined) throw new Error('browser tools require an agent')
    return agent
  }

  /**
   * Turn on request capture for one tab. Chrome accepts `Network.enable` only
   * while the caller is attached, so a rejected enable leaves the tab unarmed
   * and the next call retries instead of reporting a silent empty capture.
   */
  const armNetwork = async (cdp: CdpClient, tabId: string): Promise<void> => {
    if (capture.isArmed(tabId)) return
    await cdp.send('Network.enable')
    capture.arm(tabId)
  }

  /** Map one buffered entry to the canonical tool value. */
  const requestValue = (entry: NetworkRequestEntry): {
    requestId: string
    method: string
    url: string
    resourceType: string
    status?: number
    statusText?: string
    mimeType?: string
    failed?: string
    encodedDataLength?: number
  } => ({
    requestId: entry.requestId,
    method: entry.method,
    url: entry.url,
    resourceType: entry.resourceType,
    ...entry.status !== undefined ? { status: entry.status } : {},
    ...entry.statusText !== undefined ? { statusText: entry.statusText } : {},
    ...entry.mimeType !== undefined ? { mimeType: entry.mimeType } : {},
    ...entry.failed !== undefined ? { failed: entry.failed } : {},
    ...entry.encodedDataLength !== undefined ? { encodedDataLength: entry.encodedDataLength } : {},
  })

  const tabState = (tabId: string): TabState => {
    const existing = states.get(tabId)
    if (existing !== undefined) return existing
    const created: TabState = { epoch: 1, snapshot: undefined, frames: [], targets: [] }
    states.set(tabId, created)
    return created
  }

  const bumpEpoch = (tabId: string): TabState => {
    const state = tabState(tabId)
    state.epoch += 1
    state.snapshot = undefined
    return state
  }

  const cdpFor = (
    owner: Agent,
    tabId: ReturnType<typeof BrowserTabId>,
    signal: AbortSignal | undefined,
    frame?: BrowserFrame,
  ): CdpClient => cdpClient(ctx.browser, owner, tabId, signal, frame === undefined ? undefined : {
    ...frame.sessionId !== undefined ? { sessionId: frame.sessionId } : {},
    ...frame.targetId !== undefined ? { targetId: frame.targetId } : {},
  })

  const refreshFrames = async (
    owner: Agent,
    tabId: ReturnType<typeof BrowserTabId>,
    signal?: AbortSignal,
  ): Promise<readonly BrowserFrame[]> => {
    const cdp = cdpClient(ctx.browser, owner, tabId, signal)
    await cdp.send('Page.enable')
    const tree = await cdp.send('Page.getFrameTree') as { frameTree?: FrameTreeNode }
    const state = tabState(tabId)
    const frames = tree.frameTree === undefined ? [] : flattenFrameTree(tree.frameTree)
    const byFrameId = await associateTargets(owner, tabId, frames, state.targets, signal)
    state.frames = frames.map((frame) => {
      const target = byFrameId.get(frame.frameId)
      return {
        ...frame,
        ...target !== undefined ? { sessionId: target.sessionId, targetId: target.targetId } : {},
      }
    })
    return state.frames
  }

  /**
   * Bind each frame to the flattened target that owns it. A URL that only one
   * attached iframe reports is unambiguous; a URL several report is resolved
   * by asking each candidate which frame its own tree roots at, so a duplicate
   * iframe src never silently routes input to a sibling frame.
   */
  const associateTargets = async (
    owner: Agent,
    tabId: ReturnType<typeof BrowserTabId>,
    frames: readonly BrowserFrame[],
    targets: readonly AttachedTarget[],
    signal?: AbortSignal,
  ): Promise<Map<string, AttachedTarget>> => {
    const iframes = targets.filter(item => item.type === 'iframe')
    const bound = new Map<string, AttachedTarget>()
    for (const frame of frames) {
      const candidates = iframes.filter(item => item.url === frame.url)
      const [only] = candidates
      if (only === undefined) continue
      if (candidates.length === 1) {
        bound.set(frame.frameId, only)
        continue
      }
      for (const candidate of candidates) {
        if (await childRootFrame(owner, tabId, candidate, signal) === frame.frameId) {
          bound.set(frame.frameId, candidate)
          break
        }
      }
    }
    return bound
  }

  /** Root frame id of one attached child target's own frame tree, when it reports one. */
  const childRootFrame = async (
    owner: Agent,
    tabId: ReturnType<typeof BrowserTabId>,
    target: AttachedTarget,
    signal?: AbortSignal,
  ): Promise<string | undefined> => {
    try {
      const cdp = cdpClient(ctx.browser, owner, tabId, signal, {
        sessionId: target.sessionId,
        targetId: target.targetId,
      })
      const tree = await cdp.send('Page.getFrameTree') as { frameTree?: FrameTreeNode }
      return tree.frameTree?.frame.id
    } catch {
      // A session that cannot report its own tree stays unbound; guessing from
      // the URL would route input to whichever same-URL sibling attached first.
      return undefined
    }
  }

  const requireFrame = async (
    owner: Agent,
    tabId: ReturnType<typeof BrowserTabId>,
    frameId: string | undefined,
    signal?: AbortSignal,
  ): Promise<BrowserFrame | undefined> => {
    const frames = await refreshFrames(owner, tabId, signal)
    if (frameId === undefined) return frames.find(frame => frame.parentFrameId === undefined)
    const branded = BrowserFrameId(frameId)
    const frame = frames.find(item => item.frameId === branded)
    if (frame === undefined) {
      throw new BrowserError(`frame "${frameId}" detached or navigated`, 'BROWSER_FRAME_DETACHED')
    }
    return frame
  }

  const thrownMessage = (error: unknown): string => error instanceof Error ? error.message : String(error)

  const resolveNode = (tabId: string, ref: string): SnapshotNode => {
    const state = tabState(tabId)
    if (state.snapshot === undefined) throw new Error('take a browser_snapshot before using a ref')
    try {
      return resolveRef(ref, state.snapshot)
    } catch (error) {
      const message = thrownMessage(error)
      if (message.includes('stale')) throw new BrowserError(message, 'BROWSER_STALE_REF')
      throw error
    }
  }

  const snapshotTab = async (
    owner: Agent,
    tabId: ReturnType<typeof BrowserTabId>,
    signal?: AbortSignal,
    frameId?: string,
  ): Promise<BrowserSnapshot> => {
    const frame = await requireFrame(owner, tabId, frameId, signal)
    const treeCdp = frame?.sessionId !== undefined || frame === undefined
      ? cdpFor(owner, tabId, signal, frame)
      : cdpClient(ctx.browser, owner, tabId, signal)
    const identityCdp = cdpFor(owner, tabId, signal, frame)
    const identity = await pageIdentity(identityCdp)
    const tree = await treeCdp.send(
      'Accessibility.getFullAXTree',
      frame !== undefined && frame.parentFrameId !== undefined && frame.sessionId === undefined
        ? { frameId: frame.frameId }
        : undefined,
    ) as { nodes?: unknown[] }
    const state = tabState(tabId)
    const snapshot = buildSnapshot((tree.nodes ?? []) as never, {
      url: identity.url,
      title: identity.title,
      epoch: state.epoch,
      maxNodes: options.snapshotMaxNodes,
      ...frame !== undefined ? { frameId: frame.frameId } : {},
    })
    state.snapshot = snapshot
    return snapshot
  }

  const afterAction = async (
    owner: Agent,
    tabId: string,
    signal?: AbortSignal,
    frameId?: string,
  ): Promise<BrowserPageValue> => {
    bumpEpoch(tabId)
    try {
      const snapshot = await snapshotTab(owner, BrowserTabId(tabId), signal, frameId)
      return await snapshotValue(owner, tabId, snapshot, signal, frameId)
    } catch (error) {
      return {
        tabId,
        url: '',
        title: '',
        text: '',
        truncated: false,
        observationError: thrownMessage(error),
        ...frameId !== undefined ? { frameId } : {},
      }
    }
  }

  const pointFromNode = async (cdp: CdpClient, node: SnapshotNode, ref: string): Promise<{ x: number; y: number }> => {
    if (node.backendNodeId === undefined) throw new Error(`snapshot ref "${ref}" has no backend node`)
    const center = await nodeCenter(cdp, node.backendNodeId)
    if (center === undefined) throw new Error(`snapshot ref "${ref}" has no box model`)
    return center
  }

  const cdpForNode = async (
    owner: Agent,
    tabId: ReturnType<typeof BrowserTabId>,
    node: SnapshotNode,
    signal?: AbortSignal,
  ): Promise<CdpClient> => {
    const frame = node.frameId === undefined
      ? undefined
      : await requireFrame(owner, tabId, node.frameId, signal)
    return cdpFor(owner, tabId, signal, frame)
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
      return { url: '', title: '', media: { previewError: thrownMessage(error) } }
    }
  }

  const snapshotValue = async (
    owner: Agent,
    tabId: string,
    snapshot: BrowserSnapshot,
    signal?: AbortSignal,
    frameId?: string,
  ): Promise<BrowserPageValue> => {
    // Snapshot results carry their own page identity; only the capture is added.
    const preview = await previewValue(owner, BrowserTabId(tabId), signal)
    return {
      tabId,
      url: snapshot.url,
      title: snapshot.title,
      text: snapshot.text,
      truncated: snapshot.truncated,
      ...frameId !== undefined ? { frameId } : {},
      ...preview.media,
    }
  }

  const commonMeta = (_args: unknown, value: Record<string, unknown>) => browserMetaFromValue(value)

  ctx.tools.register(defineTool({
    name: 'browser_status',
    description: 'Report the selected browser provider, whether a live probe reached Chrome, supported operations, and recovery steps. Does not require a tab grant.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          selectedProvider: { type: 'string' },
          configuredProvider: { type: 'string' },
          available: { type: 'boolean', required: true },
          connection: { type: 'string', required: true },
          capabilities: { type: 'array', required: true, items: { type: 'string' } },
          operations: { type: 'array', required: true, items: { type: 'string' } },
          unsupportedOperations: { type: 'array', required: true, items: { type: 'string' } },
          issues: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                code: { type: 'string', required: true },
                message: { type: 'string', required: true },
                recovery: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const lines = [
          `provider: ${value.selectedProvider ?? value.configuredProvider ?? '(none)'} (${value.connection})`,
          `operations: ${value.operations.join(', ') || '(none)'}`,
          ...value.unsupportedOperations.length > 0 ? [`unsupported: ${value.unsupportedOperations.join(', ')}`] : [],
          ...value.issues.map(issue => `issue ${issue.code}: ${issue.message} — ${issue.recovery}`),
        ]
        return [{ type: 'text', text: lines.join('\n') }]
      },
      presentationMeta: commonMeta,
    },
    timeoutMs: options.timeoutMs,
    isConcurrencySafe: () => true,
    execute: async (_args, exec) => {
      const status = await ctx.browser.status(exec.signal)
      return {
        ...status.selectedProvider !== undefined ? { selectedProvider: status.selectedProvider } : {},
        ...status.configuredProvider !== undefined ? { configuredProvider: status.configuredProvider } : {},
        available: status.available,
        connection: status.connection,
        capabilities: [...status.capabilities],
        operations: [...status.operations],
        unsupportedOperations: [...status.unsupportedOperations],
        issues: status.issues.map(issue => ({ ...issue })),
      }
    },
    presentCall: () => presentBrowserCall('Browser status', 'fetch'),
    presentResult: () => presentBrowserResult('Status'),
  }))

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
    name: 'browser_frames',
    description: 'List document frames in an attached tab. Use a returned frameId with snapshot, text, evaluate, and wait tools; default is the main frame.',
    parameters: { tabId: { type: 'string', required: true } },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tabId: { type: 'string', required: true },
          frames: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                frameId: { type: 'string', required: true },
                parentFrameId: { type: 'string' },
                url: { type: 'string', required: true },
                name: { type: 'string' },
                securityOrigin: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.frames.map(frame => `- [${frame.frameId}] ${frame.name !== undefined ? `${frame.name} ` : ''}${frame.url}${frame.parentFrameId === undefined ? ' (main)' : ''}`).join('\n') || '(no frames)',
      }],
      presentationMeta: commonMeta,
    },
    timeoutMs: options.timeoutMs,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      const owner = requireOwner(exec.agent)
      const tabId = BrowserTabId(args.tabId)
      const frames = await refreshFrames(owner, tabId, exec.signal)
      return {
        tabId: args.tabId,
        frames: frames.map(frame => ({
          frameId: frame.frameId,
          ...frame.parentFrameId !== undefined ? { parentFrameId: frame.parentFrameId } : {},
          url: frame.url,
          ...frame.name !== undefined ? { name: frame.name } : {},
          ...frame.securityOrigin !== undefined ? { securityOrigin: frame.securityOrigin } : {},
        })),
      }
    },
    presentCall: args => presentBrowserCall(`Frames ${args.tabId}`, 'fetch'),
    presentResult: () => presentBrowserResult('Frames'),
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
    description: 'Capture a ref-annotated accessibility outline of the attached tab. Optional frameId selects a child document; default is the main frame.',
    parameters: {
      tabId: { type: 'string', required: true },
      frameId: { type: 'string', description: 'Frame id from browser_frames; defaults to the main frame.' },
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
          frameId: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatSnapshot(value) }],
      presentationMeta: commonMeta,
    },
    timeoutMs: options.timeoutMs,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      const owner = requireOwner(exec.agent)
      return snapshotValue(
        owner,
        args.tabId,
        await snapshotTab(owner, BrowserTabId(args.tabId), exec.signal, args.frameId),
        exec.signal,
        args.frameId,
      )
    },
    presentCall: args => presentBrowserCall(`Snapshot ${args.tabId}`, 'fetch'),
    presentResult: () => presentBrowserResult('Snapshot'),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_text',
    description: 'Read visible text from an attached tab or a selected frame.',
    parameters: {
      tabId: { type: 'string', required: true },
      frameId: { type: 'string', description: 'Frame id from browser_frames; defaults to the main frame.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tabId: { type: 'string', required: true },
          text: { type: 'string', required: true },
          frameId: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    timeoutMs: options.timeoutMs,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      const owner = requireOwner(exec.agent)
      const tabId = BrowserTabId(args.tabId)
      const frame = await requireFrame(owner, tabId, args.frameId, exec.signal)
      const cdp = cdpFor(owner, tabId, exec.signal, frame)
      const result = await cdp.send('Runtime.evaluate', {
        expression: 'document.body?.innerText ?? ""',
        returnByValue: true,
      }) as { result?: { value?: string } }
      return {
        tabId: args.tabId,
        text: result.result?.value ?? '',
        ...args.frameId !== undefined ? { frameId: args.frameId } : {},
      }
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
      frameId: { type: 'string' },
      observationError: { type: 'string' },
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
      let frameId: string | undefined
      if (args.ref !== undefined) {
        const node = resolveNode(args.tabId, args.ref)
        frameId = node.frameId
        const nodeCdp = await cdpForNode(owner, tabId, node, exec.signal)
        const center = await pointFromNode(nodeCdp, node, args.ref)
        x = center.x
        y = center.y
        await clickAt(nodeCdp, x, y)
        return afterAction(owner, args.tabId, exec.signal, frameId)
      }
      if (x === undefined || y === undefined) throw new Error('browser_click needs a ref or x/y')
      await clickAt(cdp, x, y)
      return afterAction(owner, args.tabId, exec.signal)
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
      let cdp = cdpClient(ctx.browser, owner, tabId, exec.signal)
      let frameId: string | undefined
      if (args.ref !== undefined) {
        const node = resolveNode(args.tabId, args.ref)
        frameId = node.frameId
        cdp = await cdpForNode(owner, tabId, node, exec.signal)
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
      return afterAction(owner, args.tabId, exec.signal, frameId)
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
      return afterAction(owner, args.tabId, exec.signal)
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
      return afterAction(owner, args.tabId, exec.signal)
    },
    presentCall: () => presentBrowserCall('Scroll', 'execute'),
    presentResult: () => presentBrowserResult('Scrolled'),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_drag',
    description: 'Drag from a snapshot ref or viewport point to another in the same frame using trusted pointer input.',
    parameters: {
      tabId: { type: 'string', required: true },
      fromRef: { type: 'string', description: 'Snapshot ref for the press point.' },
      fromX: { type: 'number', description: 'Viewport x for the press point when not using fromRef.' },
      fromY: { type: 'number' },
      toRef: { type: 'string', description: 'Snapshot ref for the release point.' },
      toX: { type: 'number', description: 'Viewport x for the release point when not using toRef.' },
      toY: { type: 'number' },
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
        toolName: 'browser_drag',
        callId: exec.callId,
        reason: `drag on tab ${args.tabId}`,
        signal: exec.signal,
      })
      let from = args.fromX !== undefined && args.fromY !== undefined ? { x: args.fromX, y: args.fromY } : undefined
      let to = args.toX !== undefined && args.toY !== undefined ? { x: args.toX, y: args.toY } : undefined
      // Raw viewport coordinates are main-frame coordinates, so an endpoint
      // without a ref starts in the main frame; a ref replaces it with its own.
      const mainFrame = await requireFrame(owner, tabId, undefined, exec.signal)
      let fromFrame: string | undefined = mainFrame?.frameId
      let toFrame: string | undefined = mainFrame?.frameId
      let cdp = cdpClient(ctx.browser, owner, tabId, exec.signal)
      if (args.fromRef !== undefined) {
        const node = resolveNode(args.tabId, args.fromRef)
        fromFrame = node.frameId
        cdp = await cdpForNode(owner, tabId, node, exec.signal)
        from = await pointFromNode(cdp, node, args.fromRef)
      }
      if (args.toRef !== undefined) {
        const node = resolveNode(args.tabId, args.toRef)
        toFrame = node.frameId
        const nodeCdp = await cdpForNode(owner, tabId, node, exec.signal)
        to = await pointFromNode(nodeCdp, node, args.toRef)
      }
      assertSameFrame(fromFrame, toFrame)
      if (from === undefined || to === undefined) throw new Error('browser_drag needs fromRef/fromX,fromY and toRef/toX,toY')
      await dragAt(cdp, from, to)
      return afterAction(owner, args.tabId, exec.signal, fromFrame)
    },
    presentCall: args => presentBrowserCall(`Drag ${args.fromRef ?? `${args.fromX},${args.fromY}`}`, 'execute'),
    presentResult: () => presentBrowserResult('Dragged'),
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
      const node = resolveNode(args.tabId, args.ref)
      const cdp = await cdpForNode(owner, tabId, node, exec.signal)
      if (node.backendNodeId !== undefined) {
        await cdp.send('DOM.focus', { backendNodeId: node.backendNodeId })
      }
      await cdp.send('Runtime.evaluate', {
        expression: `document.activeElement && [...document.activeElement.options].some(o => { if (o.text === ${JSON.stringify(args.value)} || o.value === ${JSON.stringify(args.value)}) { o.selected = true; document.activeElement.dispatchEvent(new Event('change', { bubbles: true })); return true } return false })`,
        returnByValue: true,
      })
      return afterAction(owner, args.tabId, exec.signal, node.frameId)
    },
    presentCall: args => presentBrowserCall(`Select ${args.value}`, 'execute'),
    presentResult: () => presentBrowserResult('Selected'),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_wait_for',
    description: 'Wait until text appears or a JS expression is truthy on an attached tab or selected frame.',
    parameters: {
      tabId: { type: 'string', required: true },
      text: { type: 'string' },
      expression: { type: 'string' },
      timeoutMs: { type: 'integer' },
      frameId: { type: 'string', description: 'Frame id from browser_frames; defaults to the main frame.' },
    },
    output: { schema: interactSchema, render: (_args, value) => [{ type: 'text', text: formatSnapshot(value) }], presentationMeta: commonMeta },
    timeoutMs: options.timeoutMs,
    execute: async (args, exec) => {
      const owner = requireOwner(exec.agent)
      const tabId = BrowserTabId(args.tabId)
      const frame = await requireFrame(owner, tabId, args.frameId, exec.signal)
      const cdp = cdpFor(owner, tabId, exec.signal, frame)
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
      return afterAction(owner, args.tabId, exec.signal, args.frameId)
    },
    presentCall: args => presentBrowserCall(`Wait ${args.text ?? args.expression ?? ''}`, 'fetch'),
    presentResult: () => presentBrowserResult('Waited'),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_evaluate',
    description: 'Run a JavaScript expression in the attached tab or selected frame and return a JSON value. Requires approval.',
    parameters: {
      tabId: { type: 'string', required: true },
      expression: { type: 'string', required: true },
      frameId: { type: 'string', description: 'Frame id from browser_frames; defaults to the main frame.' },
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
      const cdp = cdpFor(
        owner,
        BrowserTabId(args.tabId),
        exec.signal,
        await requireFrame(owner, BrowserTabId(args.tabId), args.frameId, exec.signal),
      )
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
    name: 'browser_network',
    description: 'List the HTTP requests captured from an attached tab. Capture starts at the first call for a tab, so call this before the interaction to inspect and again after it.',
    parameters: {
      tabId: { type: 'string', required: true, description: 'Attached tab id.' },
      filter: { type: 'string', description: 'Return only requests whose URL contains this text, ignoring case.' },
      limit: { type: 'integer', description: `Maximum entries to return, newest kept. Defaults to ${DEFAULT_NETWORK_LIMIT}.` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tabId: { type: 'string', required: true },
          requests: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                requestId: { type: 'string', required: true },
                method: { type: 'string', required: true },
                url: { type: 'string', required: true },
                resourceType: { type: 'string', required: true },
                status: { type: 'integer' },
                statusText: { type: 'string' },
                mimeType: { type: 'string' },
                failed: { type: 'string' },
                encodedDataLength: { type: 'integer' },
              },
            },
          },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatNetworkList(value) }],
      presentationMeta: commonMeta,
    },
    timeoutMs: options.timeoutMs,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      const owner = requireOwner(exec.agent)
      const tabId = BrowserTabId(args.tabId)
      if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1)) {
        throw new Error('browser_network limit must be a positive integer')
      }
      const cdp = cdpClient(ctx.browser, owner, tabId, exec.signal)
      await armNetwork(cdp, args.tabId)
      const matched = capture.list(args.tabId)
        .filter(entry => args.filter === undefined || entry.url.toLowerCase().includes(args.filter.toLowerCase()))
      const limit = Math.min(args.limit ?? DEFAULT_NETWORK_LIMIT, options.networkMaxRequests)
      const requests = (matched.length > limit ? matched.slice(-limit) : matched).map(requestValue)
      return { tabId: args.tabId, requests, truncated: matched.length > limit }
    },
    presentCall: args => presentBrowserCall(`Network ${args.tabId}`, 'fetch'),
    presentResult: () => presentBrowserResult('Network'),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_network_body',
    description: 'Read the response body of a request captured by browser_network. A binary body is reported by size instead of being inlined.',
    parameters: {
      tabId: { type: 'string', required: true, description: 'Attached tab id.' },
      requestId: { type: 'string', required: true, description: 'requestId from a browser_network result.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tabId: { type: 'string', required: true },
          requestId: { type: 'string', required: true },
          encoding: { type: 'string', required: true, enum: ['utf8', 'base64'] },
          bytes: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
          body: { type: 'string' },
          url: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatNetworkBody(value) }],
      presentationMeta: commonMeta,
    },
    timeoutMs: options.timeoutMs,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      const owner = requireOwner(exec.agent)
      const tabId = BrowserTabId(args.tabId)
      const cdp = cdpClient(ctx.browser, owner, tabId, exec.signal)
      await armNetwork(cdp, args.tabId)
      const bounded = boundResponseBody(
        await cdp.send('Network.getResponseBody', { requestId: args.requestId }),
        options.networkMaxBodyBytes,
      )
      const captured = capture.list(args.tabId).find(entry => entry.requestId === args.requestId)
      return {
        tabId: args.tabId,
        requestId: args.requestId,
        encoding: bounded.encoding,
        bytes: bounded.bytes,
        truncated: bounded.truncated,
        ...bounded.body !== undefined ? { body: bounded.body } : {},
        ...captured !== undefined ? { url: captured.url } : {},
      }
    },
    presentCall: args => presentBrowserCall(`Body ${args.requestId}`, 'fetch'),
    presentResult: () => presentBrowserResult('Body'),
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
      capture.drop(args.tabId)
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
      let cdp = cdpClient(ctx.browser, owner, tabId, exec.signal)
      let x = args.x
      let y = args.y
      let frameId: string | undefined
      if (args.ref !== undefined) {
        const node = resolveNode(args.tabId, args.ref)
        frameId = node.frameId
        cdp = await cdpForNode(owner, tabId, node, exec.signal)
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
      return afterAction(owner, args.tabId, exec.signal, frameId)
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
      const node = resolveNode(args.tabId, args.ref)
      if (node.backendNodeId === undefined) throw new Error(`snapshot ref "${args.ref}" has no backend node`)
      const cdp = await cdpForNode(owner, tabId, node, exec.signal)
      await cdp.send('DOM.setFileInputFiles', { backendNodeId: node.backendNodeId, files: args.paths })
      return afterAction(owner, args.tabId, exec.signal, node.frameId)
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
                id: { type: 'string', required: true },
                filename: { type: 'string', required: true },
                url: { type: 'string', required: true },
                state: { type: 'string', required: true },
                bytesReceived: { type: 'number' },
                totalBytes: { type: 'number' },
                exists: { type: 'boolean' },
                error: { type: 'string' },
                filePath: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.items.map(item => `- [${item.id}] ${item.filename} (${item.state}) — ${item.url}`).join('\n') || '(no downloads)',
      }],
    },
    timeoutMs: options.timeoutMs,
    isConcurrencySafe: () => true,
    execute: async (_args, exec) => {
      const items = await ctx.browser.listDownloads(exec.signal)
      return {
        items: items.map(item => ({
          id: item.id,
          filename: item.filename,
          url: item.url,
          state: item.state,
          ...item.bytesReceived !== undefined ? { bytesReceived: item.bytesReceived } : {},
          ...item.totalBytes !== undefined ? { totalBytes: item.totalBytes } : {},
          ...item.exists !== undefined ? { exists: item.exists } : {},
          ...item.error !== undefined ? { error: item.error } : {},
          ...item.filePath !== undefined ? { filePath: item.filePath } : {},
        })),
      }
    },
    presentCall: () => presentBrowserCall('Downloads', 'fetch'),
    presentResult: () => presentBrowserResult('Downloads'),
  }))

  ctx.tools.register(defineTool({
    name: 'browser_wait_for_download',
    description: 'Wait until a Chrome download identified by browser_downloads completes. Returns the local path without reading or opening the file.',
    parameters: {
      downloadId: { type: 'string', required: true, description: 'Download id from browser_downloads.' },
      timeoutMs: { type: 'number', description: 'How long to poll. Defaults to the tool timeout.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          state: { type: 'string', required: true },
          filename: { type: 'string', required: true },
          url: { type: 'string', required: true },
          filePath: { type: 'string' },
          error: { type: 'string' },
          bytesReceived: { type: 'number' },
          totalBytes: { type: 'number' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.state === 'complete'
          ? `Download complete: ${value.filePath ?? value.filename}`
          : `Download ${value.state}: ${value.error ?? value.filename}`,
      }],
    },
    timeoutMs: options.timeoutMs,
    execute: async (args, exec) => {
      const deadline = Date.now() + (args.timeoutMs ?? options.timeoutMs)
      const id = BrowserDownloadId(args.downloadId)
      let last: Awaited<ReturnType<typeof ctx.browser.getDownload>>
      while (Date.now() <= deadline) {
        last = await ctx.browser.getDownload(id, exec.signal)
        if (last === undefined) {
          throw new Error(`download "${args.downloadId}" is gone`)
        }
        if (last.state === 'complete') {
          return {
            id: last.id,
            state: last.state,
            filename: last.filename,
            url: last.url,
            ...last.filePath !== undefined ? { filePath: last.filePath } : {},
            ...last.bytesReceived !== undefined ? { bytesReceived: last.bytesReceived } : {},
            ...last.totalBytes !== undefined ? { totalBytes: last.totalBytes } : {},
          }
        }
        if (last.state === 'interrupted') {
          throw new BrowserError(last.error ?? `download "${args.downloadId}" was interrupted`, 'BROWSER_DOWNLOAD_INTERRUPTED')
        }
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      throw new Error(`timed out waiting for download "${args.downloadId}"`)
    },
    presentCall: args => presentBrowserCall(`Wait for download ${args.downloadId}`, 'fetch'),
    presentResult: () => presentBrowserResult('Download'),
  }))
}
