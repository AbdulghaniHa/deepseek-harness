/**
 * Per-OS, per-browser native-messaging host manifest locations.
 * @module @deepseek-ai/dsh-browser-chrome-extension/install/paths
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { NATIVE_HOST_NAME } from '../protocol/constants.ts'

/** Browsers the install library can register a host manifest for. */
export type BrowserKind = 'chrome' | 'chromium' | 'edge' | 'brave'

interface BrowserPathSpec {
  readonly darwin: string[]
  readonly linux: string[]
  /**
   * Vendor/product path each browser opens under `HKCU\Software` on Windows.
   * Every segment is its own registry key, so a flattened product name such as
   * `Google Chrome` or `BraveSoftware Brave-Browser` never matches the key the
   * browser consults.
   */
  readonly win32Key: string
}

const BROWSER_PATHS: Record<BrowserKind, BrowserPathSpec> = {
  chrome: {
    darwin: ['Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts'],
    linux: ['.config', 'google-chrome', 'NativeMessagingHosts'],
    win32Key: 'Google\\Chrome',
  },
  chromium: {
    darwin: ['Library', 'Application Support', 'Chromium', 'NativeMessagingHosts'],
    linux: ['.config', 'chromium', 'NativeMessagingHosts'],
    win32Key: 'Chromium',
  },
  edge: {
    darwin: ['Library', 'Application Support', 'Microsoft Edge', 'NativeMessagingHosts'],
    linux: ['.config', 'microsoft-edge', 'NativeMessagingHosts'],
    win32Key: 'Microsoft\\Edge',
  },
  brave: {
    darwin: ['Library', 'Application Support', 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts'],
    linux: ['.config', 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts'],
    win32Key: 'BraveSoftware\\Brave-Browser',
  },
}

/**
 * Resolve the native-messaging host manifest path for one browser on this OS.
 * @param browser - target browser.
 * @param platform - process.platform override for tests.
 * @param home - home directory override for tests.
 * @returns the JSON file path, or the Windows registry key path.
 */
export function nativeHostManifestPath(
  browser: BrowserKind,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): { readonly kind: 'file'; readonly path: string } | { readonly kind: 'registry'; readonly key: string } {
  const spec = BROWSER_PATHS[browser]
  if (platform === 'win32') {
    return { kind: 'registry', key: windowsHostKey(browser) }
  }
  const segments = platform === 'darwin' ? spec.darwin : spec.linux
  return { kind: 'file', path: join(home, ...segments, `${NATIVE_HOST_NAME}.json`) }
}

/**
 * Windows registry value path that stores the JSON manifest file location.
 * Chrome on Windows reads the host path from this value, not from a file in
 * the profile directory.
 * @param browser - target browser.
 * @returns the HKCU key Chrome consults.
 */
export function windowsRegistryKey(browser: BrowserKind): string {
  return windowsHostKey(browser)
}

function windowsHostKey(browser: BrowserKind): string {
  return `HKCU\\Software\\${BROWSER_PATHS[browser].win32Key}\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`
}

/** Closed browser kind list for CLI validation. */
export const BROWSER_KINDS: readonly BrowserKind[] = ['chrome', 'chromium', 'edge', 'brave']
