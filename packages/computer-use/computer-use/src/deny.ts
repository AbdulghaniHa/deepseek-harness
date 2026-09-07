/**
 * Fixed deny list for computer-use targets: terminal emulators and the
 * harness's own process tree. Deployment-varying extras come from Config.
 * @module @deepseek-ai/dsh-computer-use/deny
 */

import type { ComputerApp } from './types.ts'

/** Terminal bundle ids, process names, and executable basenames that are never automatable. */
export const TERMINAL_DENY_IDS: readonly string[] = [
  'com.apple.terminal',
  'com.googlecode.iterm2',
  'dev.warp.warp-terminal',
  'io.alacritty',
  'net.kovidgoyal.kitty',
  'com.mitchellh.ghostty',
  'com.github.wez.wezterm',
  'org.gnu.emacs',
  'com.microsoft.windowsterminal',
  'terminal',
  'iterm2',
  'iterm',
  'warp',
  'alacritty',
  'kitty',
  'ghostty',
  'wezterm',
  'windowsterminal',
  'windowsterminal.exe',
  'wt.exe',
  'cmd.exe',
  'powershell.exe',
  'pwsh.exe',
  'conhost.exe',
  'gnome-terminal',
  'gnome-terminal-server',
  'konsole',
  'xfce4-terminal',
  'tilix',
  'terminator',
  'xterm',
  'urxvt',
  'rxvt',
]

/**
 * Normalize an identity token for deny matching.
 * @param value - bundle id, process name, or path.
 * @returns lowercase basename without a trailing `.app`.
 */
export function normalizeDenyToken(value: string): string {
  const trimmed = value.trim().toLowerCase().replace(/\/+$/u, '')
  const parts = trimmed.split(/[/\\]/u)
  /* v8 ignore next -- String#split always yields at least the original string. */
  const base = parts.at(-1) ?? trimmed
  return base.replace(/\.app$/u, '')
}

/**
 * Whether `app` matches the fixed terminal deny list or an extra configured token.
 * @param app - running application.
 * @param extra - additional deny tokens from Config.
 * @returns true when the app must not be automated.
 */
export function isDeniedApp(app: ComputerApp, extra: readonly string[] = []): boolean {
  const tokens = new Set([...TERMINAL_DENY_IDS, ...extra.map(normalizeDenyToken)])
  const candidates = [app.name, app.bundleId, app.path]
    .filter((value): value is string => value !== undefined && value.length > 0)
    .map(normalizeDenyToken)
  return candidates.some(token => tokens.has(token))
}

/**
 * Whether `pid` belongs to this process or its reported parent.
 * @param pid - candidate process id.
 * @param selfPid - this process id.
 * @param parentPid - this process's parent id.
 * @returns true when the pid is the harness or its parent.
 */
export function isHarnessPid(pid: number, selfPid = process.pid, parentPid = process.ppid): boolean {
  return pid === selfPid || pid === parentPid
}
