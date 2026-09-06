/**
 * Install, uninstall, and status for the Chrome native-messaging host.
 * @module @deepseek-ai/dsh-browser-chrome-extension/install
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { NATIVE_HOST_NAME } from '../protocol/constants.ts'
import { DEFAULT_EXTENSION_ID, nativeHostLauncherPath, nativeHostManifest, probeHostArtifacts } from './manifest.ts'
import type { BrowserKind } from './paths.ts'
import { BROWSER_KINDS, nativeHostManifestPath } from './paths.ts'

export {
  DEFAULT_EXTENSION_ID,
  extensionDirectory,
  nativeHostLauncherPath,
  nativeHostManifest,
  probeHostArtifacts,
} from './manifest.ts'
export { BROWSER_KINDS, nativeHostManifestPath, windowsRegistryKey } from './paths.ts'
export type { BrowserKind } from './paths.ts'

/** Result of writing or removing one browser's host registration. */
export interface BrowserInstallResult {
  readonly browser: BrowserKind
  readonly location: string
  readonly kind: 'file' | 'registry'
}

/**
 * Register the native host for one or more browsers.
 * @param options - browsers, extension id, and path overrides.
 * @returns one result per registered browser.
 */
export async function installNativeHost(options: {
  readonly browsers?: readonly BrowserKind[]
  readonly extensionId?: string
  readonly packageRoot?: string
  readonly platform?: NodeJS.Platform
  readonly home?: string
  readonly hostPath?: string
} = {}): Promise<readonly BrowserInstallResult[]> {
  /* v8 ignore next -- default chrome when the caller omits browsers. */
  const browsers = options.browsers ?? ['chrome']
  /* v8 ignore next -- tests pass hostPath; the launcher path is the shipped default. */
  const hostPath = options.hostPath ?? nativeHostLauncherPath(options.packageRoot, options.platform)
  const manifest = nativeHostManifest(hostPath, options.extensionId ?? DEFAULT_EXTENSION_ID)
  const body = `${JSON.stringify(manifest, null, 2)}\n`
  const results: BrowserInstallResult[] = []
  for (const browser of browsers) {
    const target = nativeHostManifestPath(browser, options.platform, options.home)
    if (target.kind === 'file') {
      await mkdir(dirname(target.path), { recursive: true })
      await writeFile(target.path, body)
      results.push({ browser, location: target.path, kind: 'file' })
      continue
    }
    const manifestPath = `${hostPath}.manifest.json`
    await writeFile(manifestPath, body)
    runReg(['add', target.key, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'])
    results.push({ browser, location: target.key, kind: 'registry' })
  }
  return results
}

/**
 * Remove the native host registration for one or more browsers.
 * @param options - browsers and path overrides.
 * @returns one result per removed registration.
 */
export async function uninstallNativeHost(options: {
  readonly browsers?: readonly BrowserKind[]
  readonly platform?: NodeJS.Platform
  readonly home?: string
} = {}): Promise<readonly BrowserInstallResult[]> {
  /* v8 ignore next -- default chrome when the caller omits browsers. */
  const browsers = options.browsers ?? ['chrome']
  const results: BrowserInstallResult[] = []
  for (const browser of browsers) {
    const target = nativeHostManifestPath(browser, options.platform, options.home)
    if (target.kind === 'file') {
      await rm(target.path, { force: true })
      results.push({ browser, location: target.path, kind: 'file' })
      continue
    }
    runReg(['delete', target.key, '/f'])
    results.push({ browser, location: target.key, kind: 'registry' })
  }
  return results
}

/**
 * Probe whether each requested browser has a host manifest that names this host.
 * @param options - browsers and path overrides.
 * @returns per-browser registered flag plus artifact presence.
 */
export async function nativeHostStatus(options: {
  readonly browsers?: readonly BrowserKind[]
  readonly packageRoot?: string
  readonly platform?: NodeJS.Platform
  readonly home?: string
} = {}): Promise<{
  readonly artifacts: { readonly host: boolean; readonly extension: boolean }
  readonly browsers: readonly { readonly browser: BrowserKind; readonly registered: boolean; readonly location: string }[]
}> {
  /* v8 ignore next -- default every known browser when the caller omits the list. */
  const browsers = options.browsers ?? BROWSER_KINDS
  const listed: { browser: BrowserKind; registered: boolean; location: string }[] = []
  for (const browser of browsers) {
    const target = nativeHostManifestPath(browser, options.platform, options.home)
    if (target.kind === 'file') {
      let registered = false
      try {
        const text = await readFile(target.path, 'utf8')
        registered = text.includes(NATIVE_HOST_NAME)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      listed.push({ browser, registered, location: target.path })
      continue
    }
    const probe = spawnSync('reg', ['query', target.key], { encoding: 'utf8' })
    listed.push({ browser, registered: probe.status === 0, location: target.key })
  }
  return {
    artifacts: probeHostArtifacts(options.packageRoot, options.platform),
    browsers: listed,
  }
}

function runReg(args: string[]): void {
  const result = spawnSync('reg', args, { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`reg ${args[0]} failed: ${result.stderr || result.stdout || `exit ${result.status}`}`)
  }
}
