/**
 * Status-report helpers for `ctx.browser`: operation lists and recovery copy.
 * @module @deepseek-ai/dsh-browser/status
 */

import type {
  BrowserCapability,
  BrowserConnectionState,
  BrowserOperation,
  BrowserStatusIssue,
} from './types.ts'

/** Operations every selected provider is expected to serve. */
export const BASE_BROWSER_OPERATIONS: readonly BrowserOperation[] = [
  'listTabs',
  'openTab',
  'attach',
  'cdp',
]

/** Operations gated by an advertised capability. */
export const BROWSER_OPERATIONS_BY_CAPABILITY: Readonly<Record<BrowserCapability, readonly BrowserOperation[]>> = {
  tabs: [],
  cdp: [],
  history: ['historySearch'],
  bookmarks: ['listBookmarks'],
  readingList: ['listReadingList'],
  downloads: ['listDownloads'],
  notifications: [],
}

const ALL_OPERATIONS: readonly BrowserOperation[] = [
  ...BASE_BROWSER_OPERATIONS,
  'historySearch',
  'listBookmarks',
  'listReadingList',
  'listDownloads',
]

/**
 * Operations the advertised capabilities currently cover.
 * @param capabilities - selected provider facets.
 * @returns supported operation names, unique and stable-ordered.
 */
export function operationsForBrowserCapabilities(
  capabilities: readonly BrowserCapability[],
): readonly BrowserOperation[] {
  const supported = new Set<BrowserOperation>(BASE_BROWSER_OPERATIONS)
  for (const capability of capabilities) {
    for (const operation of BROWSER_OPERATIONS_BY_CAPABILITY[capability]) supported.add(operation)
  }
  return ALL_OPERATIONS.filter(operation => supported.has(operation))
}

/**
 * Operations the advertised capabilities do not cover.
 * @param capabilities - selected provider facets.
 * @returns unsupported operation names, unique and stable-ordered.
 */
export function unsupportedOperationsForBrowserCapabilities(
  capabilities: readonly BrowserCapability[],
): readonly BrowserOperation[] {
  const supported = new Set(operationsForBrowserCapabilities(capabilities))
  return ALL_OPERATIONS.filter(operation => !supported.has(operation))
}

/**
 * Recovery guidance for a machine-routable browser error code.
 * @param code - `BrowserError.code`.
 * @param detail - optional subject such as a configured provider id.
 * @returns one recovery sentence.
 */
export function recoveryForBrowserCode(code: string, detail?: string): string {
  switch (code) {
    case 'BROWSER_PROVIDER_UNAVAILABLE':
      return 'Mount a browser provider such as @deepseek-ai/dsh-browser-chrome-extension and retry browser_status.'
    case 'BROWSER_PROVIDER_CONFIGURED_MISSING':
      return detail === undefined
        ? 'The configured browser provider is not registered. Mount it, or unset browser.provider.'
        : `Configured provider "${detail}" is not registered. Mount it, or unset browser.provider.`
    case 'BROWSER_PROVIDER_CONFIGURED_UNAVAILABLE':
      return detail === undefined
        ? 'The configured browser provider is registered but unavailable. Restore the Chrome extension host, then retry.'
        : `Configured provider "${detail}" is registered but unavailable. Restore the Chrome extension host, then retry.`
    case 'BROWSER_PROVIDER_AMBIGUOUS':
      return 'Multiple usable browser providers are registered; set browser.provider to one id.'
    case 'BROWSER_NOT_CONNECTED':
      return 'Chrome native host is disconnected. Run dsh browser install, keep Chrome open with the DeepSeek extension loaded, then retry.'
    case 'BROWSER_FACET_UNAVAILABLE':
      return 'The selected provider does not advertise this Chrome-API facet. Use browser_status to list supported operations.'
    case 'BROWSER_FRAME_DETACHED':
      return 'The frame detached or navigated. Call browser_frames and take a new snapshot before using refs from that frame.'
    case 'BROWSER_STALE_REF':
      return 'The snapshot ref is stale. Take a new browser_snapshot of the owning frame before interacting.'
    case 'BROWSER_DOWNLOAD_INTERRUPTED':
      return 'The download was interrupted. Inspect the interruption reason, then retry the download or pick another file.'
    case 'BROWSER_UNSUPPORTED_DRAG':
      return 'browser_drag requires both endpoints in the same frame. Snapshot each frame and drag within it, or use click plus move.'
    default:
      return 'Inspect browser_status issues, then retry after addressing the reported code.'
  }
}

/**
 * Connection label from a cheap available check plus a live-probe outcome.
 * @param available - selected provider `available()`.
 * @param probed - whether a live probe ran.
 * @param live - whether that probe succeeded.
 * @returns the status connection field.
 */
export function browserConnectionState(
  available: boolean,
  probed: boolean,
  live: boolean,
): BrowserConnectionState {
  if (!available) return 'unconfigured'
  if (!probed) return 'configured'
  return live ? 'live' : 'probe-failed'
}

/**
 * Wrap a probe failure as a status issue.
 * @param error - thrown live-probe value.
 * @returns one recovery-bearing issue.
 */
export function browserProbeIssue(error: unknown): BrowserStatusIssue {
  const code = error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : 'BROWSER_NOT_CONNECTED'
  const message = error instanceof Error ? error.message : String(error)
  return { code, message, recovery: recoveryForBrowserCode(code) }
}
