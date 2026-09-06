/**
 * Chrome Native Messaging provider plugin. Registers on `ctx.browser` and
 * connects lazily to the host socket Chrome launches.
 * @module @deepseek-ai/dsh-browser-chrome-extension
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-browser'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { DEFAULT_EXTENSION_ID } from './install/manifest.ts'
import { ChromeExtensionProvider } from './provider.ts'

/**
 * Default host socket: a Windows named pipe, otherwise `$DSH_HOME/browser/host.sock`.
 * @param platform - `process.platform` override for tests.
 * @returns the path the provider connects to.
 */
export function defaultBrowserSocketPath(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? '\\\\.\\pipe\\dsh-browser-host' : dshHomePath('browser', 'host.sock')
}

export {
  CHROME_EXTENSION_PROVIDER_ID,
  ChromeExtensionProvider,
} from './provider.ts'
export type { ChromeExtensionProviderOptions } from './provider.ts'
export {
  BROWSER_KINDS,
  DEFAULT_EXTENSION_ID,
  extensionDirectory,
  installNativeHost,
  nativeHostLauncherPath,
  nativeHostManifest,
  nativeHostManifestPath,
  nativeHostStatus,
  probeHostArtifacts,
  uninstallNativeHost,
  windowsRegistryKey,
} from './install/index.ts'
export type { BrowserInstallResult, BrowserKind } from './install/index.ts'
export {
  ChunkAssembler,
  FRAME_HEADER_BYTES,
  MAX_NATIVE_MESSAGE_BYTES,
  NATIVE_HOST_NAME,
  PROTOCOL_VERSION,
  chunkNativePayload,
  decodeFrames,
  encodeFrame,
  isRpcNotification,
  isRpcRequest,
  isRpcResponse,
  protocolMismatch,
  rpcFailure,
  rpcNotify,
  rpcRequest,
  rpcSuccess,
} from './protocol/index.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'browser-chrome-extension'

/** The browser seam this provider registers into. */
export const inject = ['browser']

/** Plugin config: socket path, timeouts, tab-group title, and extension id. */
export interface Config {
  /** Absolute socket or named-pipe path. Defaults to `$DSH_HOME/browser/host.sock`. */
  socketPath?: string
  /** Connect timeout in milliseconds. */
  connectTimeoutMs?: number
  /** Per-RPC timeout in milliseconds. */
  requestTimeoutMs?: number
  /** Title of the Chrome tab group used for agent-opened tabs. */
  tabGroupTitle?: string
  /** Chrome extension id pinned in install manifests. */
  extensionId?: string
}

export const Config: z<Config> = z.object({
  socketPath: z.string(),
  connectTimeoutMs: z.number().default(2000),
  requestTimeoutMs: z.number().default(30_000),
  tabGroupTitle: z.string().default('DeepSeek'),
  extensionId: z.string().default(DEFAULT_EXTENSION_ID),
})

/** Complete config after schemastery applies every field default. */
type ResolvedConfig = {
  socketPath?: string
  connectTimeoutMs: number
  requestTimeoutMs: number
  tabGroupTitle: string
  extensionId: string
}

/** A timeout must be a positive finite number. */
function assertPositiveFinite(field: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`browser-chrome-extension: ${field} must be a positive finite number`)
  }
}

/**
 * Register the Chrome-extension provider with `ctx.browser`.
 * @param ctx - the host context that owns `ctx.browser`.
 * @param config - validated plugin config.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  assertPositiveFinite('connectTimeoutMs', resolved.connectTimeoutMs)
  assertPositiveFinite('requestTimeoutMs', resolved.requestTimeoutMs)
  const socketPath = resolved.socketPath ?? defaultBrowserSocketPath()
  ctx.browser.registerProvider(new ChromeExtensionProvider({
    socketPath,
    connectTimeoutMs: resolved.connectTimeoutMs,
    requestTimeoutMs: resolved.requestTimeoutMs,
    tabGroupTitle: resolved.tabGroupTitle,
    clientId: `dsh-${process.pid}`,
  }))
}
