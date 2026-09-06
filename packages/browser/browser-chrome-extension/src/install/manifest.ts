/**
 * Native-messaging host manifest JSON and host-binary path resolution.
 * @module @deepseek-ai/dsh-browser-chrome-extension/install/manifest
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NATIVE_HOST_NAME } from '../protocol/constants.ts'

/** Default unpacked-extension origin used until a Web Store id exists. */
export const DEFAULT_EXTENSION_ID = 'comdeepseekdshbrowserxxxxxxxxxxx'

/**
 * Resolve the native-host launcher shipped next to this package.
 * @param packageRoot - package root override for tests.
 * @param platform - process.platform override for tests.
 * @returns absolute path to the POSIX wrapper or the Windows `.cmd`.
 */
export function nativeHostLauncherPath(
  packageRoot: string = packageDir(),
  platform: NodeJS.Platform = process.platform,
): string {
  const name = platform === 'win32' ? 'dsh-browser-host.cmd' : 'dsh-browser-host'
  return join(packageRoot, 'bin', name)
}

/**
 * Build the Chrome native-messaging host manifest.
 * @param hostPath - absolute path to the launcher Chrome will exec.
 * @param extensionId - Chrome extension id pinned in `allowed_origins`.
 * @returns the manifest object Chrome expects.
 */
export function nativeHostManifest(hostPath: string, extensionId: string = DEFAULT_EXTENSION_ID): {
  name: string
  description: string
  path: string
  type: 'stdio'
  allowed_origins: string[]
} {
  return {
    name: NATIVE_HOST_NAME,
    description: 'DeepSeek Harness Chrome native messaging host',
    path: hostPath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`],
  }
}

/**
 * Resolve the unpacked MV3 extension directory shipped with this package.
 * @param packageRoot - package root override for tests.
 * @returns the directory Chrome Load unpacked should open.
 */
export function extensionDirectory(packageRoot: string = packageDir()): string {
  return join(packageRoot, 'extension')
}

/**
 * Probe whether the launcher and extension directory exist.
 * @param packageRoot - package root override for tests.
 * @param platform - process.platform override for tests.
 * @returns existence flags.
 */
export function probeHostArtifacts(
  packageRoot: string = packageDir(),
  platform: NodeJS.Platform = process.platform,
): { readonly host: boolean; readonly extension: boolean } {
  return {
    host: existsSync(nativeHostLauncherPath(packageRoot, platform)),
    extension: existsSync(join(extensionDirectory(packageRoot), 'manifest.json')),
  }
}

function packageDir(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [join(here, '..'), join(here, '..', '..'), join(here, '..', '..', '..')]
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'package.json')) && existsSync(join(candidate, 'extension', 'manifest.json'))) {
      return candidate
    }
  }
  /* v8 ignore next -- reached only when this module is copied away from the package root. */
  return join(here, '..', '..')
}
