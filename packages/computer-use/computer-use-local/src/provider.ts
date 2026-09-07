/**
 * `ctx.computer` provider that talks to the crash-isolated helper over stdio.
 * @module @deepseek-ai/dsh-computer-use-local/provider
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  ComputerError,
  type ComputerApp,
  type ComputerAppId,
  type ComputerCapability,
  type ComputerClickRequest,
  type ComputerDragRequest,
  type ComputerKeyRequest,
  type ComputerLaunchRequest,
  type ComputerPermissions,
  type ComputerProvider,
  type ComputerScreenshot,
  type ComputerScreenshotRequest,
  type ComputerScrollRequest,
  type ComputerSnapshot,
  type ComputerSnapshotRequest,
  type ComputerWindow,
  type ComputerWindowId,
} from '@deepseek-ai/dsh-computer-use'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { ComputerHostClient, resolveHostArgv } from './client.ts'
import { hostBackendFlags } from './flags.ts'

/** Shipped provider id. */
export const LOCAL_COMPUTER_PROVIDER_ID = 'local'

/** Runtime knobs the plugin resolved from Config. */
export interface LocalComputerProviderOptions {
  readonly requestTimeoutMs: number
  readonly graceMs: number
  /** Forwarded to the helper; see {@link hostBackendFlags}. */
  readonly windowCacheMs: number
  readonly client?: ComputerHostClient
}

function asScreenshot(value: unknown): ComputerScreenshot {
  if (typeof value !== 'object' || value === null) {
    throw new ComputerError('computer helper returned an invalid screenshot', 'COMPUTER_UNSUPPORTED')
  }
  const record = value as {
    pngBase64?: unknown
    width?: unknown
    height?: unknown
    scale?: unknown
    bounds?: ComputerScreenshot['bounds']
  }
  if (typeof record.pngBase64 !== 'string') {
    throw new ComputerError('computer helper returned an invalid screenshot', 'COMPUTER_UNSUPPORTED')
  }
  return {
    png: new Uint8Array(Buffer.from(record.pngBase64, 'base64')),
    width: typeof record.width === 'number' ? record.width : 0,
    height: typeof record.height === 'number' ? record.height : 0,
    scale: typeof record.scale === 'number' ? record.scale : 1,
    bounds: record.bounds ?? { x: 0, y: 0, width: 0, height: 0 },
  }
}

/**
 * Local desktop backend. Connects lazily on first use; a helper crash fails
 * that call with `COMPUTER_HOST_CRASHED` and the next call starts a new helper.
 */
export class LocalComputerProvider implements ComputerProvider {
  readonly id = LOCAL_COMPUTER_PROVIDER_ID
  private readonly client: ComputerHostClient

  constructor(ctx: Context, options: LocalComputerProviderOptions) {
    this.client = options.client ?? new ComputerHostClient({
      requestTimeoutMs: options.requestTimeoutMs,
      spawn: (argv) => {
        const handle: SubprocessHandle = ctx.subprocess.spawn({
          argv,
          cwd: process.cwd(),
          stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
          graceMs: options.graceMs,
        })
        return handle
      },
      argv: [...resolveHostArgv(), ...hostBackendFlags(options.windowCacheMs)],
    })
  }

  /**
   * The shipped backend is always selectable. The helper starts on first use.
   * @returns true.
   */
  available(): boolean {
    return true
  }

  /**
   * Facets this backend advertises before the helper reports otherwise.
   * @returns the full facet list.
   */
  capabilities(): readonly ComputerCapability[] {
    return ['a11y', 'screenshot', 'input', 'clipboard', 'background-actions']
  }

  async permissions(signal?: AbortSignal): Promise<ComputerPermissions> {
    return await this.client.call('permissions', undefined, signal) as ComputerPermissions
  }

  async listApps(signal?: AbortSignal): Promise<readonly ComputerApp[]> {
    return await this.client.call('listApps', undefined, signal) as readonly ComputerApp[]
  }

  async listWindows(appId?: ComputerAppId, signal?: AbortSignal): Promise<readonly ComputerWindow[]> {
    return await this.client.call('listWindows', appId === undefined ? undefined : { appId }, signal) as readonly ComputerWindow[]
  }

  async launchApp(request: ComputerLaunchRequest, signal?: AbortSignal): Promise<ComputerApp> {
    return await this.client.call('launchApp', request, signal) as ComputerApp
  }

  async focusWindow(windowId: ComputerWindowId, signal?: AbortSignal): Promise<void> {
    await this.client.call('focusWindow', { windowId }, signal)
  }

  async windowAtPoint(x: number, y: number, signal?: AbortSignal): Promise<ComputerWindow | undefined> {
    const result = await this.client.call('windowAtPoint', { x, y }, signal)
    return result === null || result === undefined ? undefined : result as ComputerWindow
  }

  async snapshot(request: ComputerSnapshotRequest, signal?: AbortSignal): Promise<ComputerSnapshot> {
    return await this.client.call('snapshot', request, signal) as ComputerSnapshot
  }

  async screenshot(request: ComputerScreenshotRequest, signal?: AbortSignal): Promise<ComputerScreenshot> {
    return asScreenshot(await this.client.call('screenshot', request, signal))
  }

  async press(handle: string, signal?: AbortSignal): Promise<void> {
    await this.client.call('press', { handle }, signal)
  }

  async setValue(handle: string, text: string, signal?: AbortSignal): Promise<void> {
    await this.client.call('setValue', { handle, text }, signal)
  }

  async click(request: ComputerClickRequest, signal?: AbortSignal): Promise<void> {
    await this.client.call('click', request, signal)
  }

  async type(text: string, signal?: AbortSignal): Promise<void> {
    await this.client.call('type', { text }, signal)
  }

  async key(request: ComputerKeyRequest, signal?: AbortSignal): Promise<void> {
    await this.client.call('key', request, signal)
  }

  async scroll(request: ComputerScrollRequest, signal?: AbortSignal): Promise<void> {
    await this.client.call('scroll', request, signal)
  }

  async drag(request: ComputerDragRequest, signal?: AbortSignal): Promise<void> {
    await this.client.call('drag', request, signal)
  }

  async move(request: { readonly x: number; readonly y: number }, signal?: AbortSignal): Promise<void> {
    await this.client.call('move', request, signal)
  }

  async clipboardRead(signal?: AbortSignal): Promise<string> {
    return await this.client.call('clipboardRead', undefined, signal) as string
  }

  async clipboardWrite(text: string, signal?: AbortSignal): Promise<void> {
    await this.client.call('clipboardWrite', { text }, signal)
  }

  /**
   * Tear down the helper process.
   * @param signal - optional bound for the wait.
   */
  async dispose(signal?: AbortSignal): Promise<void> {
    await this.client.dispose(signal)
  }
}
