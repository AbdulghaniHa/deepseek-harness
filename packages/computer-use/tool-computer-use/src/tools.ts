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

/** Resolved tool-computer-use config used while registering tools. */
export interface ToolComputerUseOptions {
  readonly approval: ComputerApprovalMode
  readonly grantScope: 'once' | 'session'
  readonly snapshotMaxNodes: number
  readonly screenshotMaxBytes: number
  readonly timeoutMs: number
  readonly allowScreenCapture: boolean
}

/**
 * Ratio of a screenshot's delivered pixels to the logical units it covers.
 * The attachment store owns image sizing, so the stored width can differ from
 * the capture width. Screenshot-space coordinates map through the delivered
 * width, so this reports that same delivered image rather than an intended
 * resize the tool never performs.
 * @param bounds - logical bounds of the captured window.
 * @param deliveredWidth - intrinsic pixel width of the stored image.
 * @returns delivered image pixels per logical unit.
 */
function deliveredScale(bounds: ComputerRect, deliveredWidth: number): number {
  return bounds.width > 0 ? deliveredWidth / bounds.width : 1
}

interface Observation {
  readonly id: string
  readonly windowId: string
  readonly title: string
  readonly windowBounds: ComputerRect
  readonly snapshot: ComputerToolSnapshot
  screenshot?: {
    readonly bounds: ComputerRect
    readonly width: number
    readonly height: number
    readonly scale: number
  }
}

/** Tool result for a window whose observation succeeded. */
interface SnapshotValue {
  windowId: string
  app: string
  windowTitle: string
  truncated: boolean
  text: string
  observationId: string
}

/** Tool result after input completed but the follow-up observation failed. */
interface SnapshotFailure {
  windowId: string
  app: string
  windowTitle: string
  truncated: boolean
  text: string
  observationError: string
}

interface WindowState {
  epoch: number
  snapshot: ComputerToolSnapshot | undefined
  screenshot: {
    readonly bounds: ComputerRect
    readonly width: number
    readonly height: number
  } | undefined
  observation: Observation | undefined
}

/**
 * Register computer-use tools.
 * @param ctx - host context with tools + computer.
 * @param options - resolved config.
 */
export function registerComputerTools(ctx: Context, options: ToolComputerUseOptions): void {
  const states = new Map<string, WindowState>()
  const approval = ctx.get('approval') as ComputerApprover | undefined
  const userQuestions = ctx.get('userQuestions')

  const requireOwner = (agent: Agent | undefined): Agent => {
    if (agent === undefined) throw new Error('computer tools require an agent')
    return agent
  }

  const windowState = (windowId: string): WindowState => {
    const existing = states.get(windowId)
    if (existing !== undefined) return existing
    const created: WindowState = { epoch: 1, snapshot: undefined, screenshot: undefined, observation: undefined }
    states.set(windowId, created)
    return created
  }

  const bumpEpoch = (windowId: string): WindowState => {
    const state = windowState(windowId)
    state.epoch += 1
    state.snapshot = undefined
    state.observation = undefined
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

  const takeSnapshot = async (
    owner: Agent,
    windowId: string,
    query: string | undefined,
    signal?: AbortSignal,
    extra: { maxDepth?: number; ref?: string } = {},
  ) => {
    const window = await grantWindow(owner, windowId, 'computer_snapshot', undefined, signal)
    let rootHandle: string | undefined
    if (extra.ref !== undefined) {
      const current = windowState(windowId).snapshot
      if (current === undefined) throw new ComputerError('no snapshot is loaded for this window; call computer_snapshot first', 'COMPUTER_STALE_REF')
      rootHandle = resolveRef(extra.ref, current).handle
    }
    const raw = await ctx.computer.snapshot(owner, {
      windowId: ComputerWindowId(windowId),
      maxNodes: options.snapshotMaxNodes,
      ...query !== undefined ? { query } : {},
      ...extra.maxDepth !== undefined ? { maxDepth: extra.maxDepth } : {},
      ...rootHandle !== undefined ? { rootHandle } : {},
    }, signal)
    const state = windowState(windowId)
    const snapshot = buildComputerSnapshot(raw, {
      epoch: state.epoch,
      maxNodes: options.snapshotMaxNodes,
      ...query !== undefined ? { query } : {},
      ...extra.maxDepth !== undefined ? { maxDepth: extra.maxDepth } : {},
      ...rootHandle !== undefined ? { rootHandle } : {},
    })
    state.snapshot = snapshot
    const observation: Observation = {
      id: `${windowId}:${state.epoch}`,
      windowId,
      title: window.title,
      windowBounds: window.bounds,
      snapshot,
      ...state.screenshot !== undefined ? { screenshot: { ...state.screenshot, scale: 1 } } : {},
    }
    state.observation = observation
    return { window, snapshot, observation }
  }

  const sameRect = (left: ComputerRect, right: ComputerRect): boolean =>
    left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height

  const requireObservation = (windowId: string, observationId: string | undefined): Observation => {
    const state = windowState(windowId)
    const observation = observationId === undefined
      ? state.observation
      : state.observation?.id === observationId ? state.observation : undefined
    if (observation === undefined) {
      throw new ComputerError(
        'screenshot-space coordinates require a current computer_observe (or computer_snapshot) for this window',
        'COMPUTER_STALE_REF',
      )
    }
    return observation
  }

  const assertGeometry = async (windowId: string, observation: Observation, signal?: AbortSignal): Promise<void> => {
    const window = await findWindow(windowId, signal)
    if (!sameRect(window.bounds, observation.windowBounds) || window.title !== observation.title) {
      throw new ComputerError(
        `window geometry changed since observation "${observation.id}"; take another computer_observe`,
        'COMPUTER_GEOMETRY_CHANGED',
      )
    }
  }

  const mapPoint = async (
    windowId: string,
    x: number,
    y: number,
    space: 'screenshot' | 'screen' | undefined,
    observationId: string | undefined,
    signal?: AbortSignal,
  ): Promise<{ x: number; y: number }> => {
    if (space === 'screen') return { x, y }
    const observation = requireObservation(windowId, observationId)
    await assertGeometry(windowId, observation, signal)
    const shot = observation.screenshot ?? windowState(windowId).screenshot
    if (shot === undefined || shot.width === 0 || shot.height === 0) return { x, y }
    return {
      x: shot.bounds.x + (x / shot.width) * shot.bounds.width,
      y: shot.bounds.y + (y / shot.height) * shot.bounds.height,
    }
  }

  const snapshotValue = <E extends Record<string, unknown>>(
    window: ComputerWindow,
    app: ComputerApp,
    snapshot: ComputerToolSnapshot,
    observation: Observation,
    extra?: E,
  ): SnapshotValue & E => ({
    windowId: window.id,
    app: app.name,
    windowTitle: window.title,
    truncated: snapshot.truncated,
    text: snapshot.text,
    observationId: observation.id,
    ...extra ?? {} as E,
  })

  const afterAction = async <E extends Record<string, unknown>>(
    owner: Agent,
    window: ComputerWindow,
    extra: E,
    signal?: AbortSignal,
  ): Promise<(SnapshotValue & E) | (SnapshotFailure & E)> => {
    bumpEpoch(window.id)
    const app = await findApp(window.appId, signal)
    try {
      const { snapshot, observation } = await takeSnapshot(owner, window.id, undefined, signal)
      return snapshotValue(window, app, snapshot, observation, extra)
    } catch (error) {
      return {
        windowId: window.id,
        app: app.name,
        windowTitle: window.title,
        truncated: false,
        text: '',
        observationError: error instanceof Error ? error.message : String(error),
        ...extra,
      }
    }
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
    name: 'computer_status',
    description: 'Report the selected computer-use provider, whether a live probe succeeded, supported operations, permission failures, and recovery steps. Does not require a grant.',
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
          permissions: {
            type: 'object',
            additionalProperties: false,
            properties: {
              accessibility: { type: 'string', required: true },
              screenRecording: { type: 'string', required: true },
              inputInjection: { type: 'string', required: true },
            },
          },
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
      const status = await ctx.computer.status(exec.signal)
      return {
        ...status.selectedProvider !== undefined ? { selectedProvider: status.selectedProvider } : {},
        ...status.configuredProvider !== undefined ? { configuredProvider: status.configuredProvider } : {},
        available: status.available,
        connection: status.connection,
        capabilities: [...status.capabilities],
        operations: [...status.operations],
        unsupportedOperations: [...status.unsupportedOperations],
        ...status.permissions !== undefined ? { permissions: { ...status.permissions } } : {},
        issues: status.issues.map(issue => ({ ...issue })),
      }
    },
    presentCall: () => presentComputerCall('Computer status', 'fetch'),
    presentResult: () => presentComputerResult('Status'),
  }))

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
    description: 'Read the accessibility tree of a window as an epoch-scoped outline. Primary observation on text-only model routes. maxDepth and a current snapshot ref select a subtree; node states and supported actions are included.',
    parameters: {
      windowId: { type: 'string', required: true, description: 'Window id from computer_apps.' },
      query: { type: 'string', description: 'Optional role or name substring filter.' },
      maxDepth: { type: 'number', description: 'Include nodes through this depth (root is 0). Output caps do not bound native full-tree traversal.' },
      ref: { type: 'string', description: 'Optional current snapshot ref whose node becomes the subtree root.' },
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
          observationId: { type: 'string', required: true },
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
      const { window, snapshot, observation } = await takeSnapshot(owner, args.windowId, args.query, exec.signal, {
        ...args.maxDepth !== undefined ? { maxDepth: args.maxDepth } : {},
        ...args.ref !== undefined ? { ref: args.ref } : {},
      })
      const app = await findApp(window.appId, exec.signal)
      return snapshotValue(window, app, snapshot, observation)
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
          observationId: { type: 'string' },
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
      const saved = await attachments.saveImage({ data: shot.png, mediaType: 'image/png', name: 'computer-screenshot.png' })
      const scale = deliveredScale(shot.bounds, saved.width)
      if (args.windowId === undefined) {
        return {
          width: saved.width,
          height: saved.height,
          scale,
          attachmentId: saved.attachmentId,
          mediaType: saved.mediaType,
          bytes: saved.bytes,
        }
      }
      const window = await findWindow(args.windowId, exec.signal)
      const state = windowState(args.windowId)
      // Screenshot-space coordinates are mapped through the stored image's own
      // pixel dimensions, which are also the dimensions reported to the model.
      const captured = { bounds: shot.bounds, width: saved.width, height: saved.height, scale }
      state.screenshot = { bounds: shot.bounds, width: saved.width, height: saved.height }
      if (state.observation === undefined) {
        state.observation = {
          id: `${args.windowId}:${state.epoch}:shot`,
          windowId: args.windowId,
          title: window.title,
          windowBounds: window.bounds,
          snapshot: state.snapshot ?? {
            epoch: state.epoch,
            windowId: args.windowId,
            appId: window.appId,
            title: window.title,
            truncated: false,
            nodes: [],
            text: '',
          },
          screenshot: captured,
        }
      } else {
        state.observation.screenshot = captured
      }
      const app = await findApp(window.appId, exec.signal)
      return {
        windowId: window.id,
        windowTitle: window.title,
        app: app.name,
        observationId: state.observation.id,
        width: saved.width,
        height: saved.height,
        scale,
        attachmentId: saved.attachmentId,
        mediaType: saved.mediaType,
        bytes: saved.bytes,
      }
    },
    presentCall: () => presentComputerCall('Screenshot', 'fetch'),
    presentResult: () => presentComputerResult('Screenshot'),
  }))

  ctx.tools.register(defineTool({
    name: 'computer_observe',
    description: 'Capture a bounded accessibility snapshot plus an optional screenshot with explicit pixel dimensions, logical bounds, and scale. Text-only model routes receive the snapshot without an image. Bind later screenshot-space coordinates to the returned observationId.',
    parameters: {
      windowId: { type: 'string', required: true, description: 'Window id from computer_apps.' },
      query: { type: 'string', description: 'Optional role or name substring filter.' },
      maxDepth: { type: 'number', description: 'Include nodes through this depth (root is 0).' },
      ref: { type: 'string', description: 'Optional current snapshot ref whose node becomes the subtree root.' },
      screenshot: { type: 'boolean', description: 'Include a screenshot when the route accepts images. Defaults to true on image-capable routes.' },
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
          observationId: { type: 'string', required: true },
          width: { type: 'number' },
          height: { type: 'number' },
          scale: { type: 'number' },
          bounds: {
            type: 'object',
            additionalProperties: false,
            properties: {
              x: { type: 'number', required: true },
              y: { type: 'number', required: true },
              width: { type: 'number', required: true },
              height: { type: 'number', required: true },
            },
          },
          attachmentId: { type: 'string' },
          mediaType: { type: 'string' },
          bytes: { type: 'number' },
        },
      },
      render: (_args, value) => {
        const { attachmentId, mediaType, bytes, width, height } = value
        const captured = attachmentId !== undefined && mediaType !== undefined
          && bytes !== undefined && width !== undefined && height !== undefined
        return [
          {
            type: 'text',
            text: formatComputerSnapshot({ app: value.app, windowTitle: value.windowTitle, text: value.text, truncated: value.truncated }),
          },
          ...captured
            ? [{
              type: 'image' as const,
              attachment: {
                attachmentId: AttachmentId(attachmentId),
                mediaType: mediaType as 'image/png',
                bytes,
                width,
                height,
              },
            }]
            : [],
        ]
      },
      presentationMeta: commonMeta,
    },
    timeoutMs: options.timeoutMs,
    execute: async (args, exec) => {
      const owner = requireOwner(exec.agent)
      const { window, snapshot, observation } = await takeSnapshot(owner, args.windowId, args.query, exec.signal, {
        ...args.maxDepth !== undefined ? { maxDepth: args.maxDepth } : {},
        ...args.ref !== undefined ? { ref: args.ref } : {},
      })
      const app = await findApp(window.appId, exec.signal)
      const wantShot = args.screenshot !== false && options.allowScreenCapture
      let image: {
        width: number
        height: number
        scale: number
        bounds: ComputerRect
        attachmentId: string
        mediaType: string
        bytes: number
      } | undefined
      if (wantShot) {
        try {
          await assertImageCapableRoute(ctx, exec)
          const attachments = ctx.get('attachments')
          if (attachments !== undefined) {
            const shot = await ctx.computer.screenshot(owner, { windowId: ComputerWindowId(args.windowId) }, exec.signal)
            if (shot.png.byteLength <= options.screenshotMaxBytes) {
              const saved = await attachments.saveImage({ data: shot.png, mediaType: 'image/png', name: 'computer-observe.png' })
              // Same coordinate space as computer_screenshot: the stored image's
              // own pixel dimensions, which are what the result declares.
              const captured = {
                bounds: shot.bounds,
                width: saved.width,
                height: saved.height,
                scale: deliveredScale(shot.bounds, saved.width),
              }
              windowState(args.windowId).screenshot = { bounds: shot.bounds, width: saved.width, height: saved.height }
              observation.screenshot = captured
              image = {
                width: saved.width,
                height: saved.height,
                scale: captured.scale,
                bounds: shot.bounds,
                attachmentId: saved.attachmentId,
                mediaType: saved.mediaType,
                bytes: saved.bytes,
              }
            }
          }
        } catch {
          // Text-only routes and capture failures still return the snapshot.
        }
      }
      return {
        ...snapshotValue(window, app, snapshot, observation),
        ...image !== undefined
          ? {
            width: image.width,
            height: image.height,
            scale: image.scale,
            bounds: image.bounds,
            attachmentId: image.attachmentId,
            mediaType: image.mediaType,
            bytes: image.bytes,
          }
          : {
            bounds: window.bounds,
          },
      }
    },
    presentCall: args => presentComputerCall(`Observe ${args.windowId}`, 'fetch'),
    presentResult: () => presentComputerResult('Observe'),
  }))

  ctx.tools.register(defineTool({
    name: 'computer_action',
    description: 'Invoke an accessibility action already advertised on a captured node: activate, toggle, select, expandCollapse, or setValue.',
    parameters: {
      windowId: { type: 'string', required: true, description: 'Window id from computer_apps.' },
      ref: { type: 'string', required: true, description: 'Epoch-scoped snapshot ref.' },
      action: { type: 'string', required: true, description: 'activate, toggle, select, expandCollapse, or setValue.' },
      value: { type: 'string', description: 'Replacement value when action is setValue.' },
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
          observationId: { type: 'string' },
          observationError: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.observationError !== undefined
          ? `Action completed; observation failed: ${value.observationError}`
          : formatComputerSnapshot({ app: value.app, windowTitle: value.windowTitle, text: value.text, truncated: value.truncated }),
      }],
      presentationMeta: commonMeta,
    },
    timeoutMs: options.timeoutMs,
    execute: async (args, exec) => {
      const owner = requireOwner(exec.agent)
      const window = await grantWindow(owner, args.windowId, 'computer_action', exec.callId, exec.signal)
      await perAction(owner, 'computer_action', `${args.action} in ${window.title}`, exec.callId, exec.signal)
      const snapshot = windowState(args.windowId).snapshot
      if (snapshot === undefined) throw new ComputerError('no snapshot is loaded for this window; call computer_snapshot first', 'COMPUTER_STALE_REF')
      const node = resolveRef(args.ref, snapshot)
      const action = args.action === 'activate' || args.action === 'toggle' || args.action === 'select'
        || args.action === 'expandCollapse' || args.action === 'setValue'
        ? args.action
        : undefined
      if (action === undefined) throw new ComputerError(`unsupported accessibility action "${args.action}"`, 'COMPUTER_UNSUPPORTED')
      if (!node.actions.includes(action)) {
        throw new ComputerError(
          `node "${args.ref}" does not support ${action} (supported: ${node.actions.length === 0 ? 'none' : node.actions.join(', ')})`,
          'COMPUTER_UNSUPPORTED',
        )
      }
      if (action === 'setValue' && args.value === undefined) throw new Error('computer_action setValue requires value')
      await ctx.computer.action(owner, ComputerWindowId(args.windowId), {
        handle: node.handle,
        action,
        ...args.value !== undefined ? { value: args.value } : {},
      }, exec.signal)
      return afterAction(owner, window, {}, exec.signal)
    },
    presentCall: args => presentComputerCall(`${args.action} ${args.ref}`, 'execute'),
    presentResult: () => presentComputerResult('Action'),
  }))

  ctx.tools.register(defineTool({
    name: 'computer_click',
    description: 'Click a snapshot ref or coordinates in a window. Refs prefer an accessibility press when the node supports it. Screenshot-space coordinates bind to observationId.',
    parameters: {
      windowId: { type: 'string', required: true, description: 'Window id from computer_apps.' },
      ref: { type: 'string', description: 'Epoch-scoped snapshot ref.' },
      x: { type: 'number', description: 'X coordinate when not using ref.' },
      y: { type: 'number', description: 'Y coordinate when not using ref.' },
      space: { type: 'string', description: 'screenshot (default) or screen.' },
      observationId: { type: 'string', description: 'Observation that produced screenshot-space coordinates.' },
      button: { type: 'string', description: 'left, right, or middle.' },
      count: { type: 'number', description: 'Click count. Defaults to 1.' },
      modifiers: { type: 'array', items: { type: 'string' }, description: 'alt, ctrl, meta, and/or shift.' },
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
          observationId: { type: 'string' },
          observationError: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.observationError !== undefined
          ? `Click completed; observation failed: ${value.observationError}`
          : formatComputerSnapshot({ app: value.app, windowTitle: value.windowTitle, text: value.text, truncated: value.truncated }),
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
            ...args.modifiers !== undefined ? { modifiers: args.modifiers } : {},
          }, exec.signal)
        }
      } else {
        if (args.x === undefined || args.y === undefined) {
          throw new Error('computer_click requires ref or x and y')
        }
        const point = await mapPoint(
          args.windowId, args.x, args.y,
          args.space === 'screen' ? 'screen' : 'screenshot',
          args.observationId, exec.signal,
        )
        await ctx.computer.click(owner, ComputerWindowId(args.windowId), {
          ...point,
          button: args.button === 'right' || args.button === 'middle' ? args.button : 'left',
          count: args.count ?? 1,
          ...args.modifiers !== undefined ? { modifiers: args.modifiers } : {},
        }, exec.signal)
      }
      return afterAction(owner, window, {}, exec.signal)
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
        properties: {
          windowId: { type: 'string', required: true },
          app: { type: 'string', required: true },
          windowTitle: { type: 'string', required: true },
          truncated: { type: 'boolean', required: true },
          text: { type: 'string', required: true },
          observationId: { type: 'string' },
          observationError: { type: 'string' },
          typed: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.observationError !== undefined
          ? `Typed; observation failed: ${value.observationError}`
          : formatComputerSnapshot({ app: value.app, windowTitle: value.windowTitle, text: value.text, truncated: value.truncated }),
      }],
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
      return afterAction(owner, window, { typed: true }, exec.signal)
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
        properties: {
          windowId: { type: 'string', required: true },
          app: { type: 'string', required: true },
          windowTitle: { type: 'string', required: true },
          truncated: { type: 'boolean', required: true },
          text: { type: 'string', required: true },
          observationId: { type: 'string' },
          observationError: { type: 'string' },
          key: { type: 'string', required: true },
        },
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
      return afterAction(owner, window, { key: args.key }, exec.signal)
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
      observationId: { type: 'string', description: 'Observation that produced screenshot-space coordinates.' },
      direction: { type: 'string', required: true, description: 'up, down, left, or right.' },
      amount: { type: 'number', required: true, description: 'Scroll amount in provider units.' },
      modifiers: { type: 'array', items: { type: 'string' }, description: 'alt, ctrl, meta, and/or shift.' },
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
          observationId: { type: 'string' },
          observationError: { type: 'string' },
          scrolled: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.observationError !== undefined
          ? `Scrolled; observation failed: ${value.observationError}`
          : 'Scrolled',
      }],
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
        const point = await mapPoint(
          args.windowId, x, y,
          args.space === 'screen' ? 'screen' : 'screenshot',
          args.observationId, exec.signal,
        )
        x = point.x
        y = point.y
      }
      const direction = args.direction === 'up' || args.direction === 'left' || args.direction === 'right' ? args.direction : 'down'
      await ctx.computer.scroll(owner, ComputerWindowId(args.windowId), {
        x, y, direction, amount: args.amount,
        ...args.modifiers !== undefined ? { modifiers: args.modifiers } : {},
      }, exec.signal)
      return afterAction(owner, window, { scrolled: true }, exec.signal)
    },
    presentCall: () => presentComputerCall('Scroll', 'execute'),
    presentResult: () => presentComputerResult('Scrolled'),
  }))

  ctx.tools.register(defineTool({
    name: 'computer_drag',
    description: 'Drag from one snapshot ref or point to another in a window.',
    parameters: {
      windowId: { type: 'string', required: true, description: 'Window id from computer_apps.' },
      from: {
        type: 'object',
        required: true,
        additionalProperties: false,
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          ref: { type: 'string' },
        },
      },
      to: {
        type: 'object',
        required: true,
        additionalProperties: false,
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          ref: { type: 'string' },
        },
      },
      space: { type: 'string', description: 'screenshot (default) or screen.' },
      observationId: { type: 'string', description: 'Observation that produced screenshot-space coordinates.' },
      modifiers: { type: 'array', items: { type: 'string' }, description: 'alt, ctrl, meta, and/or shift.' },
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
          observationId: { type: 'string' },
          observationError: { type: 'string' },
          dragged: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.observationError !== undefined
          ? `Dragged; observation failed: ${value.observationError}`
          : 'Dragged',
      }],
      presentationMeta: commonMeta,
    },
    timeoutMs: options.timeoutMs,
    execute: async (args, exec) => {
      const owner = requireOwner(exec.agent)
      const window = await grantWindow(owner, args.windowId, 'computer_drag', exec.callId, exec.signal)
      await perAction(owner, 'computer_drag', `drag in ${window.title}`, exec.callId, exec.signal)
      const space = args.space === 'screen' ? 'screen' : 'screenshot'
      const resolveEndpoint = async (endpoint: { x?: number; y?: number; ref?: string }): Promise<{ x: number; y: number }> => {
        if (endpoint.ref !== undefined) {
          const snapshot = windowState(args.windowId).snapshot
          if (snapshot === undefined) throw new ComputerError('no snapshot is loaded for this window; call computer_snapshot first', 'COMPUTER_STALE_REF')
          const node = resolveRef(endpoint.ref, snapshot)
          return {
            x: node.bounds.x + node.bounds.width / 2,
            y: node.bounds.y + node.bounds.height / 2,
          }
        }
        if (endpoint.x === undefined || endpoint.y === undefined) {
          throw new Error('computer_drag endpoints require ref or x and y')
        }
        return mapPoint(args.windowId, endpoint.x, endpoint.y, space, args.observationId, exec.signal)
      }
      const from = await resolveEndpoint(args.from)
      const to = await resolveEndpoint(args.to)
      await ctx.computer.drag(owner, ComputerWindowId(args.windowId), {
        fromX: from.x,
        fromY: from.y,
        toX: to.x,
        toY: to.y,
        ...args.modifiers !== undefined ? { modifiers: args.modifiers } : {},
      }, exec.signal)
      return afterAction(owner, window, { dragged: true }, exec.signal)
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
      observationId: { type: 'string', description: 'Observation that produced screenshot-space coordinates.' },
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
      const point = await mapPoint(
        args.windowId, args.x, args.y,
        args.space === 'screen' ? 'screen' : 'screenshot',
        args.observationId, exec.signal,
      )
      await ctx.computer.move(owner, ComputerWindowId(args.windowId), point, exec.signal)
      return { windowId: args.windowId, x: point.x, y: point.y }
    },
    presentCall: () => presentComputerCall('Move pointer', 'execute'),
    presentResult: () => presentComputerResult('Moved'),
  }))

  ctx.tools.register(defineTool({
    name: 'computer_wait_for',
    description: 'Poll a window accessibility tree until text appears or disappears, the title matches, or a captured node reaches a state.',
    parameters: {
      windowId: { type: 'string', required: true, description: 'Window id from computer_apps.' },
      text: { type: 'string', description: 'Substring to find in the snapshot outline, or to wait until gone when gone is true.' },
      gone: { type: 'boolean', description: 'When true, succeed once text is absent from the outline.' },
      title: { type: 'string', description: 'Substring to find in the window title.' },
      ref: { type: 'string', description: 'Optional snapshot ref whose states are polled.' },
      state: { type: 'string', description: 'enabled, disabled, selected, expanded, or collapsed.' },
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
          observationId: { type: 'string' },
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
      let lastObservationId: string | undefined
      let handle: string | undefined
      if (args.ref !== undefined) {
        const current = windowState(args.windowId).snapshot
        if (current !== undefined) handle = resolveRef(args.ref, current).handle
      }
      const wantedState = args.state === 'enabled' || args.state === 'disabled' || args.state === 'selected'
        || args.state === 'expanded' || args.state === 'collapsed'
        ? args.state
        : undefined
      while (Date.now() <= deadline) {
        const query = args.gone === true ? undefined : args.text
        const { window, snapshot, observation } = await takeSnapshot(owner, args.windowId, query, exec.signal)
        lastTitle = window.title
        lastText = snapshot.text
        lastObservationId = observation.id
        if (args.ref !== undefined && handle === undefined) {
          handle = resolveRef(args.ref, snapshot).handle
        }
        const textPresent = args.text === undefined || snapshot.text.includes(args.text)
        const textOk = args.gone === true ? !textPresent : textPresent
        const titleOk = args.title === undefined || window.title.includes(args.title)
        let stateOk = wantedState === undefined
        if (wantedState !== undefined) {
          const node = handle === undefined ? undefined : snapshot.nodes.find(item => item.handle === handle)
          stateOk = node !== undefined && node.states.includes(wantedState)
        }
        if (textOk && titleOk && stateOk) {
          return {
            windowId: args.windowId,
            matched: true,
            windowTitle: window.title,
            text: snapshot.text,
            observationId: observation.id,
          }
        }
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      return {
        windowId: args.windowId,
        matched: false,
        windowTitle: lastTitle,
        text: lastText,
        ...lastObservationId !== undefined ? { observationId: lastObservationId } : {},
      }
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
