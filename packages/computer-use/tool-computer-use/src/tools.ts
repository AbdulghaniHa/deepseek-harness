/**
 * Register every `computer_*` tool on `ctx.tools`.
 * @module @deepseek-ai/dsh-tool-computer-use/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  ComputerError,
  ComputerWindowId,
  type ComputerApp,
  type ComputerRect,
  type ComputerWindow,
} from '@deepseek-ai/dsh-computer-use'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { approveComputerAction, ensureAppGrant, type ComputerApprovalMode, type ComputerApprover } from './approval.ts'
import { computerMetaFromValue, formatComputerSnapshot, presentComputerCall, presentComputerResult } from './present.ts'
import { assertImageCapableRoute } from './route.ts'
import { buildComputerSnapshot, resolveRef, type ComputerToolSnapshot } from './snapshot.ts'
import type { UserQuestionService } from '@deepseek-ai/dsh-user-questions'

/** Resolved tool-computer-use config used while registering tools. */
export interface ToolComputerUseOptions {
  readonly approval: ComputerApprovalMode
  readonly grantScope: 'once' | 'session'
  readonly snapshotMaxNodes: number
  readonly screenshotMaxWidth: number
  readonly screenshotMaxBytes: number
  readonly timeoutMs: number
  readonly allowScreenCapture: boolean
}

interface WindowState {
  epoch: number
  snapshot: ComputerToolSnapshot | undefined
  screenshot: {
    readonly bounds: ComputerRect
    readonly width: number
    readonly height: number
  } | undefined
}

/**
 * Register computer-use tools.
 * @param ctx - host context with tools + computer.
 * @param options - resolved config.
 */
export function registerComputerTools(ctx: Context, options: ToolComputerUseOptions): void {
  const states = new Map<string, WindowState>()
  const approval = ctx.get('approval') as ComputerApprover | undefined
  const userQuestions = ctx.get('userQuestions') as UserQuestionService | undefined

  const requireOwner = (agent: Agent | undefined): Agent => {
    if (agent === undefined) throw new Error('computer tools require an agent')
    return agent
  }

  const windowState = (windowId: string): WindowState => {
    const existing = states.get(windowId)
    if (existing !== undefined) return existing
    const created: WindowState = { epoch: 1, snapshot: undefined, screenshot: undefined }
    states.set(windowId, created)
    return created
  }

  const bumpEpoch = (windowId: string): WindowState => {
    const state = windowState(windowId)
    state.epoch += 1
    state.snapshot = undefined
    return state
  }

  const findWindow = async (windowId: string, signal?: AbortSignal): Promise<ComputerWindow> => {
    const windows = await ctx.computer.listWindows(undefined, signal)
    const window = windows.find(item => item.id === windowId)
    if (window === undefined) throw new ComputerError(`window "${windowId}" is gone`, 'COMPUTER_WINDOW_GONE')
    return window
  }

  const findApp = async (appId: ComputerApp['id'], signal?: AbortSignal): Promise<ComputerApp> => {
    const apps = await ctx.computer.listApps(signal)
    const app = apps.find(item => item.id === appId)
    if (app === undefined) throw new ComputerError(`application "${appId}" is gone`, 'COMPUTER_WINDOW_GONE')
    return app
  }

  const grantWindow = async (owner: Agent, windowId: string, toolName: string, callId: Parameters<typeof ensureAppGrant>[0]['callId'], signal?: AbortSignal): Promise<ComputerWindow> => {
    const window = await findWindow(windowId, signal)
    const app = await findApp(window.appId, signal)
    await ensureAppGrant({
      computer: ctx.computer,
      owner,
      app,
      mode: options.approval,
      grantScope: options.grantScope,
      ...userQuestions !== undefined ? { userQuestions } : {},
      ...approval !== undefined ? { approval } : {},
      toolName,
      /* v8 ignore next -- computer_snapshot passes undefined; mutating tools pass exec.callId. */
      ...callId !== undefined ? { callId } : {},
      /* v8 ignore next -- execute always supplies the AbortSignal from the tools runtime. */
      ...signal !== undefined ? { signal } : {},
    })
    return window
  }

  const mapPoint = (windowId: string, x: number, y: number, space: 'screenshot' | 'screen' | undefined): { x: number; y: number } => {
    if (space === 'screen') return { x, y }
    const shot = windowState(windowId).screenshot
    if (shot === undefined || shot.width === 0 || shot.height === 0) return { x, y }
    return {
      x: shot.bounds.x + (x / shot.width) * shot.bounds.width,
      y: shot.bounds.y + (y / shot.height) * shot.bounds.height,
    }
  }

  const takeSnapshot = async (owner: Agent, windowId: string, query: string | undefined, signal?: AbortSignal) => {
    const window = await grantWindow(owner, windowId, 'computer_snapshot', undefined, signal)
    const raw = await ctx.computer.snapshot(owner, {
      windowId: ComputerWindowId(windowId),
      maxNodes: options.snapshotMaxNodes,
      ...query !== undefined ? { query } : {},
    }, signal)
    const state = windowState(windowId)
    const snapshot = buildComputerSnapshot(raw, {
      epoch: state.epoch,
      maxNodes: options.snapshotMaxNodes,
      ...query !== undefined ? { query } : {},
    })
    state.snapshot = snapshot
    return { window, snapshot }
  }

  const commonMeta = (_args: unknown, value: Record<string, unknown>): JsonValue => computerMetaFromValue(value)

  const perAction = async (owner: Agent, toolName: string, reason: string, callId: Parameters<typeof approveComputerAction>[0]['callId'], signal?: AbortSignal): Promise<void> => {
    await approveComputerAction({
      mode: options.approval,
      ...approval !== undefined ? { approval } : {},
      agent: owner,
      toolName,
      reason,
      /* v8 ignore next -- execute always supplies callId from the tools runtime. */
      ...callId !== undefined ? { callId } : {},
      /* v8 ignore next -- execute always supplies the AbortSignal from the tools runtime. */
      ...signal !== undefined ? { signal } : {},
    })
  }

  ctx.tools.register(defineTool({
    name: 'computer_apps',
    description: 'List running GUI applications and their windows, including whether this agent currently holds a grant.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          apps: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                appId: { type: 'string', required: true },
                name: { type: 'string', required: true },
                granted: { type: 'boolean', required: true },
                windows: {
                  type: 'array',
                  required: true,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      windowId: { type: 'string', required: true },
                      title: { type: 'string', required: true },
                      focused: { type: 'boolean', required: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.apps.map(app => `- ${app.name} [${app.appId}]${app.granted ? ' (granted)' : ''}\n${app.windows.map(window => `  - ${window.title} [${window.windowId}]${window.focused ? ' (focused)' : ''}`).join('\n')}`).join('\n') || '(no apps)',
      }],
      presentationMeta: commonMeta,
    },
    timeoutMs: options.timeoutMs,
    isConcurrencySafe: () => true,
    execute: async (_args, exec) => {
      const owner = requireOwner(exec.agent)
      const apps = await ctx.computer.listApps(exec.signal)
      const windows = await ctx.computer.listWindows(undefined, exec.signal)
      const grants = new Set(ctx.computer.listGrants(owner).map(item => item.appId))
      return {
        apps: apps.map(app => ({
          appId: app.id,
          name: app.name,
          granted: grants.has(app.id),
          windows: windows.filter(window => window.appId === app.id).map(window => ({
            windowId: window.id,
            title: window.title,
            focused: window.focused,
          })),
        })),
      }
    },
    presentCall: () => presentComputerCall('List apps', 'fetch'),
    presentResult: () => presentComputerResult('Apps'),
  }))

  ctx.tools.register(defineTool({
    name: 'computer_launch',
    description: 'Launch a GUI application by name, bundle id, or executable and return its windows.',
    parameters: {
      app: { type: 'string', required: true, description: 'Application name, bundle id, or executable.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          appId: { type: 'string', required: true },
          app: { type: 'string', required: true },
          windows: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                windowId: { type: 'string', required: true },
                title: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Launched ${value.app} [${value.appId}]` }],
      presentationMeta: commonMeta,
    },
    timeoutMs: options.timeoutMs,
    execute: async (args, exec) => {
      const owner = requireOwner(exec.agent)
      await perAction(owner, 'computer_launch', `launch ${args.app}`, exec.callId, exec.signal)
      const launched = await ctx.computer.launchApp(owner, { name: args.app }, exec.signal)
      await ensureAppGrant({
        computer: ctx.computer,
        owner,
        app: launched,
        mode: options.approval,
        grantScope: options.grantScope,
        ...userQuestions !== undefined ? { userQuestions } : {},
        ...approval !== undefined ? { approval } : {},
        toolName: 'computer_launch',
        callId: exec.callId,
        signal: exec.signal,
      })
      const windows = await ctx.computer.listWindows(launched.id, exec.signal)
      return {
        appId: launched.id,
        app: launched.name,
        windows: windows.map(window => ({ windowId: window.id, title: window.title })),
      }
    },
    presentCall: args => presentComputerCall(`Launch ${args.app}`, 'execute'),
    presentResult: () => presentComputerResult('Launched'),
  }))

  ctx.tools.register(defineTool({
    name: 'computer_focus',
    description: 'Bring a window to the front.',
    parameters: {
      windowId: { type: 'string', required: true, description: 'Window id from computer_apps.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          windowId: { type: 'string', required: true },
          app: { type: 'string', required: true },
          windowTitle: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Focused ${value.windowTitle}` }],
      presentationMeta: commonMeta,
    },
    timeoutMs: options.timeoutMs,
    execute: async (args, exec) => {
      const owner = requireOwner(exec.agent)
      const window = await grantWindow(owner, args.windowId, 'computer_focus', exec.callId, exec.signal)
      await perAction(owner, 'computer_focus', `focus ${window.title}`, exec.callId, exec.signal)
      await ctx.computer.focusWindow(owner, ComputerWindowId(args.windowId), exec.signal)
      const app = await findApp(window.appId, exec.signal)
      return { windowId: window.id, app: app.name, windowTitle: window.title }
    },
    presentCall: args => presentComputerCall(`Focus ${args.windowId}`, 'execute'),
    presentResult: () => presentComputerResult('Focused'),
  }))

  ctx.tools.register(defineTool({
    name: 'computer_snapshot',
    description: 'Read the accessibility tree of a window as an epoch-scoped outline. Primary observation on text-only model routes.',
    parameters: {
      windowId: { type: 'string', required: true, description: 'Window id from computer_apps.' },
      query: { type: 'string', description: 'Optional role or name substring filter.' },
      maxDepth: { type: 'number', description: 'Unused depth hint reserved for providers; the node cap is snapshotMaxNodes.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          windowId: { type: 'string', required: true },
          app: { type: 'string', required: true },
          windowTitle: { type: 'string', required: true },
          truncated: { type: 'boolean', required: true },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: formatComputerSnapshot({ app: value.app, windowTitle: value.windowTitle, text: value.text, truncated: value.truncated }),
      }],
      presentationMeta: commonMeta,
    },
    timeoutMs: options.timeoutMs,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      const owner = requireOwner(exec.agent)
      const { window, snapshot } = await takeSnapshot(owner, args.windowId, args.query, exec.signal)
      const app = await findApp(window.appId, exec.signal)
      return {
        windowId: window.id,
        app: app.name,
        windowTitle: window.title,
        truncated: snapshot.truncated,
        text: snapshot.text,
      }
    },
    presentCall: args => presentComputerCall(`Snapshot ${args.windowId}`, 'fetch'),
    presentResult: () => presentComputerResult('Snapshot'),
  }))

  ctx.tools.register(defineTool({
    name: 'computer_screenshot',
    description: 'Capture a window or display as an image attachment. Requires an image-capable model route; prefer computer_snapshot on text-only routes.',
    parameters: {
      windowId: { type: 'string', description: 'Window to capture; omit for the full display.' },
      region: {
        type: 'object',
        description: 'Optional crop in logical screen coordinates (Anthropic zoom).',
        additionalProperties: false,
        properties: {
          x: { type: 'number', required: true },
          y: { type: 'number', required: true },
          width: { type: 'number', required: true },
          height: { type: 'number', required: true },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          windowId: { type: 'string' },
          app: { type: 'string' },
          windowTitle: { type: 'string' },
          width: { type: 'number', required: true },
          height: { type: 'number', required: true },
          scale: { type: 'number', required: true },
          attachmentId: { type: 'string', required: true },
          mediaType: { type: 'string', required: true },
          bytes: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: `Screenshot ${value.width}x${value.height} px, scale ${value.scale}` },
        {
          type: 'image',
          attachment: {
            attachmentId: AttachmentId(value.attachmentId),
            mediaType: value.mediaType as 'image/png',
            bytes: value.bytes,
            width: value.width,
            height: value.height,
          },
        },
      ],
      presentationMeta: commonMeta,
    },
    timeoutMs: options.timeoutMs,
    execute: async (args, exec) => {
      if (!options.allowScreenCapture) {
        throw new Error('computer_screenshot is disabled by allowScreenCapture: false; use computer_snapshot')
      }
      const owner = requireOwner(exec.agent)
      await assertImageCapableRoute(ctx, exec)
      const attachments = ctx.get('attachments')
      if (attachments === undefined) {
        throw new Error('computer_screenshot requires an attachment service')
      }
      if (args.windowId !== undefined) {
        await grantWindow(owner, args.windowId, 'computer_screenshot', exec.callId, exec.signal)
      }
      const shot = await ctx.computer.screenshot(owner, {
        ...args.windowId !== undefined ? { windowId: ComputerWindowId(args.windowId) } : {},
        ...args.region !== undefined ? { region: args.region } : {},
      }, exec.signal)
      if (shot.png.byteLength > options.screenshotMaxBytes) {
        throw new Error(`computer_screenshot exceeded screenshotMaxBytes (${options.screenshotMaxBytes})`)
      }
      const scale = shot.width > options.screenshotMaxWidth && shot.width > 0
        ? options.screenshotMaxWidth / shot.width
        : 1
      const width = Math.max(1, Math.round(shot.width * scale) || shot.width)
      const height = Math.max(1, Math.round(shot.height * scale) || shot.height)
      if (args.windowId !== undefined) {
        windowState(args.windowId).screenshot = { bounds: shot.bounds, width, height }
      }
      const saved = await attachments.saveImage({ data: shot.png, mediaType: 'image/png', name: 'computer-screenshot.png' })
      const window = args.windowId === undefined ? undefined : await findWindow(args.windowId, exec.signal)
      const app = window === undefined ? undefined : await findApp(window.appId, exec.signal)
      return {
        ...window !== undefined ? { windowId: window.id, windowTitle: window.title } : {},
        ...app !== undefined ? { app: app.name } : {},
        width: saved.width,
        height: saved.height,
        scale: shot.scale * scale,
        attachmentId: saved.attachmentId,
        mediaType: saved.mediaType,
        bytes: saved.bytes,
      }
    },
    presentCall: () => presentComputerCall('Screenshot', 'fetch'),
    presentResult: () => presentComputerResult('Screenshot'),
  }))

  ctx.tools.register(defineTool({
    name: 'computer_click',
    description: 'Click a snapshot ref or coordinates in a window. Refs prefer an accessibility press when the node supports it.',
    parameters: {
      windowId: { type: 'string', required: true, description: 'Window id from computer_apps.' },
      ref: { type: 'string', description: 'Epoch-scoped snapshot ref.' },
      x: { type: 'number', description: 'X coordinate when not using ref.' },
      y: { type: 'number', description: 'Y coordinate when not using ref.' },
      space: { type: 'string', description: 'screenshot (default) or screen.' },
      button: { type: 'string', description: 'left, right, or middle.' },
      count: { type: 'number', description: 'Click count. Defaults to 1.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          windowId: { type: 'string', required: true },
          app: { type: 'string', required: true },
          windowTitle: { type: 'string', required: true },
          truncated: { type: 'boolean', required: true },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: formatComputerSnapshot({ app: value.app, windowTitle: value.windowTitle, text: value.text, truncated: value.truncated }),
      }],
      presentationMeta: commonMeta,
    },
    timeoutMs: options.timeoutMs,
    execute: async (args, exec) => {
      const owner = requireOwner(exec.agent)
      const window = await grantWindow(owner, args.windowId, 'computer_click', exec.callId, exec.signal)
      await perAction(owner, 'computer_click', `click in ${window.title}`, exec.callId, exec.signal)
      if (args.ref !== undefined) {
        const snapshot = windowState(args.windowId).snapshot
        if (snapshot === undefined) throw new ComputerError('no snapshot is loaded for this window; call computer_snapshot first', 'COMPUTER_STALE_REF')
        const node = resolveRef(args.ref, snapshot)
        if (node.supportsPress) {
          await ctx.computer.press(owner, ComputerWindowId(args.windowId), node.handle, exec.signal)
        } else {
          const center = {
            x: node.bounds.x + node.bounds.width / 2,
            y: node.bounds.y + node.bounds.height / 2,
          }
          await ctx.computer.click(owner, ComputerWindowId(args.windowId), {
            ...center,
            button: args.button === 'right' || args.button === 'middle' ? args.button : 'left',
            count: args.count ?? 1,
          }, exec.signal)
        }
      } else {
        if (args.x === undefined || args.y === undefined) {
          throw new Error('computer_click requires ref or x and y')
        }
        const point = mapPoint(args.windowId, args.x, args.y, args.space === 'screen' ? 'screen' : 'screenshot')
        await ctx.computer.click(owner, ComputerWindowId(args.windowId), {
          ...point,
          button: args.button === 'right' || args.button === 'middle' ? args.button : 'left',
          count: args.count ?? 1,
        }, exec.signal)
      }
      bumpEpoch(args.windowId)
      const { snapshot } = await takeSnapshot(owner, args.windowId, undefined, exec.signal)
      const app = await findApp(window.appId, exec.signal)
      return {
        windowId: window.id,
        app: app.name,
        windowTitle: window.title,
        truncated: snapshot.truncated,
        text: snapshot.text,
      }
    },
    presentCall: args => presentComputerCall(`Click ${args.ref ?? `${args.x},${args.y}`}`, 'execute'),
    presentResult: () => presentComputerResult('Clicked'),
  }))

  ctx.tools.register(defineTool({
    name: 'computer_type',
    description: 'Type text into a window. A ref with setValue support uses the accessibility action; otherwise keystrokes are synthesized.',
    parameters: {
      windowId: { type: 'string', required: true, description: 'Window id from computer_apps.' },
      text: { type: 'string', required: true, description: 'Literal text to type.' },
      ref: { type: 'string', description: 'Optional snapshot ref of the target field.' },
      submit: { type: 'boolean', description: 'Press Enter after typing.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { windowId: { type: 'string', required: true }, typed: { type: 'boolean', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: value.typed ? 'Typed' : 'Not typed' }],
      presentationMeta: commonMeta,
    },
    timeoutMs: options.timeoutMs,
    execute: async (args, exec) => {
      const owner = requireOwner(exec.agent)
      const window = await grantWindow(owner, args.windowId, 'computer_type', exec.callId, exec.signal)
      await perAction(owner, 'computer_type', `type in ${window.title}`, exec.callId, exec.signal)
      if (args.ref !== undefined) {
        const snapshot = windowState(args.windowId).snapshot
        if (snapshot === undefined) throw new ComputerError('no snapshot is loaded for this window; call computer_snapshot first', 'COMPUTER_STALE_REF')
        const node = resolveRef(args.ref, snapshot)
        if (node.supportsSetValue) {
          await ctx.computer.setValue(owner, ComputerWindowId(args.windowId), node.handle, args.text, exec.signal)
        } else {
          await ctx.computer.type(owner, ComputerWindowId(args.windowId), args.text, exec.signal)
        }
      } else {
        await ctx.computer.type(owner, ComputerWindowId(args.windowId), args.text, exec.signal)
      }
      if (args.submit === true) {
        await ctx.computer.key(owner, ComputerWindowId(args.windowId), { key: 'Enter' }, exec.signal)
      }
      bumpEpoch(args.windowId)
      return { windowId: args.windowId, typed: true }
    },
    presentCall: () => presentComputerCall('Type', 'execute'),
    presentResult: () => presentComputerResult('Typed'),
  }))

  ctx.tools.register(defineTool({
    name: 'computer_press_key',
    description: 'Press a key in a window, with optional modifiers and repeat.',
    parameters: {
      windowId: { type: 'string', required: true, description: 'Window id from computer_apps.' },
      key: { type: 'string', required: true, description: 'Key name, for example Enter or a.' },
      modifiers: { type: 'array', items: { type: 'string' }, description: 'alt, ctrl, meta, and/or shift.' },
      repeat: { type: 'number', description: 'How many times to press. Defaults to 1.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { windowId: { type: 'string', required: true }, key: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: `Pressed ${value.key}` }],
      presentationMeta: commonMeta,
    },
    timeoutMs: options.timeoutMs,
    execute: async (args, exec) => {
      const owner = requireOwner(exec.agent)
      const window = await grantWindow(owner, args.windowId, 'computer_press_key', exec.callId, exec.signal)
      await perAction(owner, 'computer_press_key', `key ${args.key} in ${window.title}`, exec.callId, exec.signal)
      await ctx.computer.key(owner, ComputerWindowId(args.windowId), {
        key: args.key,
        ...args.modifiers !== undefined ? { modifiers: args.modifiers } : {},
        ...args.repeat !== undefined ? { repeat: args.repeat } : {},
      }, exec.signal)
      bumpEpoch(args.windowId)
      return { windowId: args.windowId, key: args.key }
    },
    presentCall: args => presentComputerCall(`Key ${args.key}`, 'execute'),
    presentResult: () => presentComputerResult('Key'),
  }))

  ctx.tools.register(defineTool({
    name: 'computer_scroll',
    description: 'Scroll at a snapshot ref or coordinates.',
    parameters: {
      windowId: { type: 'string', required: true, description: 'Window id from computer_apps.' },
      ref: { type: 'string', description: 'Optional snapshot ref whose center is the scroll origin.' },
      x: { type: 'number', description: 'X coordinate when not using ref.' },
      y: { type: 'number', description: 'Y coordinate when not using ref.' },
      space: { type: 'string', description: 'screenshot (default) or screen.' },
      direction: { type: 'string', required: true, description: 'up, down, left, or right.' },
      amount: { type: 'number', required: true, description: 'Scroll amount in provider units.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { windowId: { type: 'string', required: true }, scrolled: { type: 'boolean', required: true } },
      },
      render: () => [{ type: 'text', text: 'Scrolled' }],
      presentationMeta: commonMeta,
    },
    timeoutMs: options.timeoutMs,
    execute: async (args, exec) => {
      const owner = requireOwner(exec.agent)
      const window = await grantWindow(owner, args.windowId, 'computer_scroll', exec.callId, exec.signal)
      await perAction(owner, 'computer_scroll', `scroll in ${window.title}`, exec.callId, exec.signal)
      let x = args.x ?? 0
      let y = args.y ?? 0
      if (args.ref !== undefined) {
        const snapshot = windowState(args.windowId).snapshot
        if (snapshot === undefined) throw new ComputerError('no snapshot is loaded for this window; call computer_snapshot first', 'COMPUTER_STALE_REF')
        const node = resolveRef(args.ref, snapshot)
        x = node.bounds.x + node.bounds.width / 2
        y = node.bounds.y + node.bounds.height / 2
      } else {
        const point = mapPoint(args.windowId, x, y, args.space === 'screen' ? 'screen' : 'screenshot')
        x = point.x
        y = point.y
      }
      const direction = args.direction === 'up' || args.direction === 'left' || args.direction === 'right' ? args.direction : 'down'
      await ctx.computer.scroll(owner, ComputerWindowId(args.windowId), { x, y, direction, amount: args.amount }, exec.signal)
      bumpEpoch(args.windowId)
      return { windowId: args.windowId, scrolled: true }
    },
    presentCall: () => presentComputerCall('Scroll', 'execute'),
    presentResult: () => presentComputerResult('Scrolled'),
  }))

  ctx.tools.register(defineTool({
    name: 'computer_drag',
    description: 'Drag from one point to another in a window.',
    parameters: {
      windowId: { type: 'string', required: true, description: 'Window id from computer_apps.' },
      from: {
        type: 'object',
        required: true,
        additionalProperties: false,
        properties: { x: { type: 'number', required: true }, y: { type: 'number', required: true } },
      },
      to: {
        type: 'object',
        required: true,
        additionalProperties: false,
        properties: { x: { type: 'number', required: true }, y: { type: 'number', required: true } },
      },
      space: { type: 'string', description: 'screenshot (default) or screen.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { windowId: { type: 'string', required: true }, dragged: { type: 'boolean', required: true } },
      },
      render: () => [{ type: 'text', text: 'Dragged' }],
      presentationMeta: commonMeta,
    },
    timeoutMs: options.timeoutMs,
    execute: async (args, exec) => {
      const owner = requireOwner(exec.agent)
      const window = await grantWindow(owner, args.windowId, 'computer_drag', exec.callId, exec.signal)
      await perAction(owner, 'computer_drag', `drag in ${window.title}`, exec.callId, exec.signal)
      const space = args.space === 'screen' ? 'screen' : 'screenshot'
      const from = mapPoint(args.windowId, args.from.x, args.from.y, space)
      const to = mapPoint(args.windowId, args.to.x, args.to.y, space)
      await ctx.computer.drag(owner, ComputerWindowId(args.windowId), {
        fromX: from.x,
        fromY: from.y,
        toX: to.x,
        toY: to.y,
      }, exec.signal)
      bumpEpoch(args.windowId)
      return { windowId: args.windowId, dragged: true }
    },
    presentCall: () => presentComputerCall('Drag', 'execute'),
    presentResult: () => presentComputerResult('Dragged'),
  }))

  ctx.tools.register(defineTool({
    name: 'computer_mouse_move',
    description: 'Move the pointer to coordinates in a window without clicking.',
    parameters: {
      windowId: { type: 'string', required: true, description: 'Window id from computer_apps.' },
      x: { type: 'number', required: true, description: 'X coordinate.' },
      y: { type: 'number', required: true, description: 'Y coordinate.' },
      space: { type: 'string', description: 'screenshot (default) or screen.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { windowId: { type: 'string', required: true }, x: { type: 'number', required: true }, y: { type: 'number', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: `Moved to ${value.x},${value.y}` }],
      presentationMeta: commonMeta,
    },
    timeoutMs: options.timeoutMs,
    execute: async (args, exec) => {
      const owner = requireOwner(exec.agent)
      const window = await grantWindow(owner, args.windowId, 'computer_mouse_move', exec.callId, exec.signal)
      await perAction(owner, 'computer_mouse_move', `move in ${window.title}`, exec.callId, exec.signal)
      const point = mapPoint(args.windowId, args.x, args.y, args.space === 'screen' ? 'screen' : 'screenshot')
      await ctx.computer.move(owner, ComputerWindowId(args.windowId), point, exec.signal)
      return { windowId: args.windowId, x: point.x, y: point.y }
    },
    presentCall: () => presentComputerCall('Move pointer', 'execute'),
    presentResult: () => presentComputerResult('Moved'),
  }))

  ctx.tools.register(defineTool({
    name: 'computer_wait_for',
    description: 'Poll a window accessibility tree until text or the title matches, or the timeout elapses.',
    parameters: {
      windowId: { type: 'string', required: true, description: 'Window id from computer_apps.' },
      text: { type: 'string', description: 'Substring to find in the snapshot outline.' },
      title: { type: 'string', description: 'Substring to find in the window title.' },
      timeoutMs: { type: 'number', description: 'How long to poll. Defaults to the tool timeout.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          windowId: { type: 'string', required: true },
          matched: { type: 'boolean', required: true },
          windowTitle: { type: 'string', required: true },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.matched ? `Matched in ${value.windowTitle}` : `Timed out waiting in ${value.windowTitle}` }],
      presentationMeta: commonMeta,
    },
    timeoutMs: options.timeoutMs,
    execute: async (args, exec) => {
      const owner = requireOwner(exec.agent)
      const deadline = Date.now() + (args.timeoutMs ?? options.timeoutMs)
      let lastTitle = ''
      let lastText = ''
      while (Date.now() <= deadline) {
        const { window, snapshot } = await takeSnapshot(owner, args.windowId, args.text, exec.signal)
        lastTitle = window.title
        lastText = snapshot.text
        const textOk = args.text === undefined || snapshot.text.includes(args.text)
        const titleOk = args.title === undefined || window.title.includes(args.title)
        if (textOk && titleOk) {
          return { windowId: args.windowId, matched: true, windowTitle: window.title, text: snapshot.text }
        }
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      return { windowId: args.windowId, matched: false, windowTitle: lastTitle, text: lastText }
    },
    presentCall: () => presentComputerCall('Wait', 'fetch'),
    presentResult: () => presentComputerResult('Wait'),
  }))

  ctx.tools.register(defineTool({
    name: 'computer_clipboard',
    description: 'Read or write the system clipboard. Writes require a granted app.',
    parameters: {
      action: { type: 'string', required: true, description: 'read or write.' },
      text: { type: 'string', description: 'Clipboard replacement when action is write.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          text: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.action === 'read' ? (value.text ?? '') : 'Wrote clipboard' }],
      presentationMeta: commonMeta,
    },
    timeoutMs: options.timeoutMs,
    execute: async (args, exec) => {
      const owner = requireOwner(exec.agent)
      if (args.action === 'write') {
        if (args.text === undefined) throw new Error('computer_clipboard write requires text')
        await perAction(owner, 'computer_clipboard', 'write clipboard', exec.callId, exec.signal)
        await ctx.computer.clipboardWrite(owner, args.text, exec.signal)
        return { action: 'write' }
      }
      const text = await ctx.computer.clipboardRead(exec.signal)
      return { action: 'read', text }
    },
    presentCall: args => presentComputerCall(`Clipboard ${args.action}`, args.action === 'read' ? 'fetch' : 'execute'),
    presentResult: () => presentComputerResult('Clipboard'),
  }))
}
