/**
 * Helper command-line flags: the plugin forwards backend knobs to the spawned
 * helper on argv because the helper has no other configuration channel.
 * @module @deepseek-ai/dsh-computer-use-local/flags
 */

import { ComputerError } from '@deepseek-ai/dsh-computer-use'

/** Helper argv flag carrying the plugin's `windowCacheMs` to the simulang backend. */
export const WINDOW_CACHE_FLAG = '--window-cache-ms='

/** Backend knobs that cross the helper process boundary. */
export interface HostBackendOptions {
  readonly windowCacheMs?: number
}

/**
 * Backend knobs the plugin forwards on the helper command line.
 * @param windowCacheMs - simulang window-enumeration cache lifetime.
 * @returns argv flags appended after the helper entry.
 */
export function hostBackendFlags(windowCacheMs: number): readonly string[] {
  return [`${WINDOW_CACHE_FLAG}${windowCacheMs}`]
}

/**
 * Parse {@link hostBackendFlags} back out of the helper's argv.
 * @param argv - `process.argv` of the helper.
 * @returns backend options; an absent flag leaves the option undefined.
 */
export function parseHostBackendFlags(argv: readonly string[]): HostBackendOptions {
  const flag = argv.find(item => item.startsWith(WINDOW_CACHE_FLAG))
  if (flag === undefined) return {}
  const value = Number(flag.slice(WINDOW_CACHE_FLAG.length))
  if (!Number.isFinite(value) || value < 0) {
    throw new ComputerError(`invalid helper flag ${flag}`, 'COMPUTER_UNSUPPORTED')
  }
  return { windowCacheMs: value }
}
