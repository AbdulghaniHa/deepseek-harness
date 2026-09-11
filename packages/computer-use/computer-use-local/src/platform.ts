/**
 * OS fallback desktop backend: list/launch/screenshot/clipboard without a
 * native addon. Accessibility trees and synthesized input throw
 * `COMPUTER_UNSUPPORTED` except for a small macOS System Events path.
 * @module @deepseek-ai/dsh-computer-use-local/platform
 */

import { execFile, spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  ComputerAppId,
  ComputerError,
  ComputerWindowId,
  type ComputerApp,
  type ComputerCapability,
  type ComputerClickRequest,
  type ComputerKeyRequest,
  type ComputerLaunchRequest,
  type ComputerPermissions,
  type ComputerScreenshot,
  type ComputerScreenshotRequest,
  type ComputerSnapshot,
  type ComputerWindow,
} from '@deepseek-ai/dsh-computer-use'
import type { DesktopBackend } from './backend.ts'

const execFileAsync = promisify(execFile)

/** Injectable command runner used by tests to avoid live GUI binaries. */
export interface PlatformIo {
  run(argv: readonly string[], signal?: AbortSignal): Promise<string>
  write(argv: readonly string[], input: string, signal?: AbortSignal): Promise<void>
  capturePng(argv: readonly string[], signal?: AbortSignal): Promise<Uint8Array>
}

async function defaultRun(argv: readonly string[], signal?: AbortSignal): Promise<string> {
  const [bin, ...args] = argv
  if (bin === undefined) throw new ComputerError('empty command', 'COMPUTER_UNSUPPORTED')
  try {
    const result = await execFileAsync(bin, args, { signal, timeout: 15_000, encoding: 'utf8' })
    return result.stdout.trim()
  } catch (error) {
    /* v8 ignore next -- execFile rejects with Error. */
    const message = error instanceof Error ? error.message : String(error)
    throw new ComputerError(message, 'COMPUTER_UNSUPPORTED', { cause: error })
  }
}

async function defaultWrite(argv: readonly string[], input: string, signal?: AbortSignal): Promise<void> {
  const [bin, ...args] = argv
  if (bin === undefined) throw new ComputerError('empty command', 'COMPUTER_UNSUPPORTED')
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(bin, args, { signal, timeout: 15_000, stdio: ['pipe', 'ignore', 'pipe'] })
      child.once('error', reject)
      child.once('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`${bin} exited ${String(code)}`))
      })
      child.stdin.end(input)
    })
  } catch (error) {
    /* v8 ignore next -- spawn rejects with Error. */
    const message = error instanceof Error ? error.message : String(error)
    throw new ComputerError(message, 'COMPUTER_UNSUPPORTED', { cause: error })
  }
}

async function defaultCapturePng(argv: readonly string[], signal?: AbortSignal): Promise<Uint8Array> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-computer-shot-'))
  const path = join(dir, 'shot.png')
  try {
    await defaultRun([...argv, path], signal)
    return new Uint8Array(await readFile(path))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const DEFAULT_IO: PlatformIo = {
  run: defaultRun,
  write: defaultWrite,
  capturePng: defaultCapturePng,
}

/** Real process I/O used when tests do not inject a runner. */
export const defaultPlatformIo: PlatformIo = DEFAULT_IO

function unsupported(action: string, platform: NodeJS.Platform): never {
  throw new ComputerError(`${action} is not supported by the platform backend on ${platform}`, 'COMPUTER_UNSUPPORTED')
}

/**
 * Reject a backend method the platform cannot serve. Whole-method stubs use
 * this so a caller awaiting the declared promise sees a rejection rather than
 * a synchronous throw.
 */
function unsupportedRejection(action: string, platform: NodeJS.Platform): Promise<never> {
  return Promise.reject(new ComputerError(
    `${action} is not supported by the platform backend on ${platform}`,
    'COMPUTER_UNSUPPORTED',
  ))
}

/** Options for {@link createPlatformBackend}. */
export interface PlatformBackendOptions {
  readonly platform?: NodeJS.Platform
  readonly wayland?: boolean
  readonly io?: PlatformIo
}

/**
 * Create the OS fallback backend.
 * @param options - platform, Wayland flag, and optional command runner.
 * @returns a DesktopBackend.
 */
export function createPlatformBackend(options: PlatformBackendOptions = {}): DesktopBackend {
  const platform = options.platform ?? process.platform
  const wayland = options.wayland ?? Boolean(process.env.WAYLAND_DISPLAY)
  const io = options.io ?? DEFAULT_IO

  return {
    capabilities(): readonly ComputerCapability[] {
      if (platform === 'darwin') return ['screenshot', 'clipboard', 'input']
      return ['screenshot', 'clipboard']
    },

    permissions(): Promise<ComputerPermissions> {
      if (platform === 'darwin') {
        return Promise.resolve({ accessibility: 'unknown', screenRecording: 'unknown', inputInjection: 'unknown' })
      }
      if (platform === 'linux') {
        return Promise.resolve({
          accessibility: 'unknown',
          screenRecording: 'unknown',
          inputInjection: wayland ? 'denied' : 'unknown',
        })
      }
      return Promise.resolve({ accessibility: 'not-required', screenRecording: 'not-required', inputInjection: 'not-required' })
    },

    async listApps(signal?: AbortSignal): Promise<readonly ComputerApp[]> {
      if (platform === 'darwin') {
        const stdout = await io.run(['osascript', '-e', 'tell application "System Events" to get name of every process whose background only is false'], signal)
        const names = stdout.length === 0 ? [] : stdout.split(', ')
        return names.map((name, index) => ({
          id: ComputerAppId(name),
          name,
          pid: 10_000 + index,
        }))
      }
      if (platform === 'win32') {
        const stdout = await io.run(['tasklist', '/fo', 'csv', '/nh'], signal)
        return stdout.split(/\r?\n/u).filter(line => line.length > 0).slice(0, 50).map((line, index) => {
          const cols = line.split(',')
          /* v8 ignore next -- String#split of a non-empty line always has index 0. */
          const name = (cols[0] ?? 'unknown').replaceAll('"', '')
          const pid = Number((cols[1] ?? '0').replaceAll('"', ''))
          return { id: ComputerAppId(`${name}:${pid || index}`), name, pid: Number.isFinite(pid) ? pid : index }
        })
      }
      const stdout = await io.run(['ps', '-eo', 'pid,comm'], signal)
      return stdout.split('\n').slice(1).filter(line => line.trim().length > 0).slice(0, 50).map((line) => {
        const trimmed = line.trim()
        const space = trimmed.indexOf(' ')
        const pid = Number(trimmed.slice(0, space))
        const name = trimmed.slice(space).trim()
        return { id: ComputerAppId(`${name}:${pid}`), name, pid }
      })
    },

    async listWindows(appId?: ComputerAppId, signal?: AbortSignal): Promise<readonly ComputerWindow[]> {
      if (platform !== 'darwin') return []
      const names = appId === undefined
        ? (await this.listApps(signal)).map(item => item.name)
        : [String(appId)]
      const windows: ComputerWindow[] = []
      for (const name of names.slice(0, 20)) {
        try {
          const stdout = await io.run(['osascript', '-e', `tell application "System Events" to tell process ${JSON.stringify(name)} to get name of every window`], signal)
          const titles = stdout.length === 0 ? [name] : stdout.split(', ')
          for (const [index, title] of titles.entries()) {
            windows.push({
              id: ComputerWindowId(`${name}:${index}`),
              appId: ComputerAppId(name),
              title,
              bounds: { x: 0, y: 0, width: 800, height: 600 },
              focused: index === 0,
            })
          }
        } catch {
          // The process may have no windows; skip it.
        }
      }
      return windows
    },

    async launchApp(request: ComputerLaunchRequest, signal?: AbortSignal): Promise<ComputerApp> {
      if (platform === 'darwin') await io.run(['open', '-a', request.name], signal)
      else if (platform === 'win32') await io.run(['cmd', '/c', 'start', '', request.name], signal)
      else await io.run(['xdg-open', request.name], signal)
      return { id: ComputerAppId(request.name), name: request.name, pid: 0 }
    },

    async focusWindow(windowId: ComputerWindowId, signal?: AbortSignal): Promise<void> {
      if (platform !== 'darwin') unsupported('focusWindow', platform)
      /* v8 ignore next -- String#split always yields at least one element. */
      const name = String(windowId).split(':')[0] ?? String(windowId)
      await io.run(['osascript', '-e', `tell application ${JSON.stringify(name)} to activate`], signal)
    },

    windowAtPoint(): Promise<ComputerWindow | undefined> {
      return Promise.resolve(undefined)
    },

    snapshot(): Promise<ComputerSnapshot> {
      return unsupportedRejection('snapshot', platform)
    },

    async screenshot(request: ComputerScreenshotRequest, signal?: AbortSignal): Promise<ComputerScreenshot> {
      if (platform === 'win32') unsupported('screenshot', platform)
      const argv = platform === 'darwin'
        ? ['screencapture', '-x', '-t', 'png']
        : wayland
          ? ['grim']
          : ['import', '-window', 'root']
      const png = await io.capturePng(argv, signal)
      return { png, width: 0, height: 0, scale: 1, bounds: request.region ?? { x: 0, y: 0, width: 0, height: 0 } }
    },

    press(): Promise<void> {
      return unsupportedRejection('press', platform)
    },

    setValue(): Promise<void> {
      return unsupportedRejection('setValue', platform)
    },

    action(): Promise<void> {
      return unsupportedRejection('action', platform)
    },

    async click(request: ComputerClickRequest, signal?: AbortSignal): Promise<void> {
      if (platform !== 'darwin') unsupported('click', platform)
      await io.run(['osascript', '-e', `tell application "System Events" to click at {${Math.round(request.x)}, ${Math.round(request.y)}}`], signal)
    },

    async type(text: string, signal?: AbortSignal): Promise<void> {
      if (platform !== 'darwin') unsupported('type', platform)
      await io.run(['osascript', '-e', `tell application "System Events" to keystroke ${JSON.stringify(text)}`], signal)
    },

    async key(request: ComputerKeyRequest, signal?: AbortSignal): Promise<void> {
      if (platform !== 'darwin') unsupported('key', platform)
      await io.run(['osascript', '-e', 'tell application "System Events" to key code 36'], signal)
      void request
    },

    scroll(): Promise<void> {
      return unsupportedRejection('scroll', platform)
    },

    move(): Promise<void> {
      return unsupportedRejection('move', platform)
    },

    drag(): Promise<void> {
      return unsupportedRejection('drag', platform)
    },

    async clipboardRead(signal?: AbortSignal): Promise<string> {
      if (platform === 'darwin') return io.run(['pbpaste'], signal)
      if (platform === 'win32') return io.run(['powershell', '-NoProfile', '-Command', 'Get-Clipboard'], signal)
      return io.run(['xclip', '-selection', 'clipboard', '-o'], signal)
    },

    async clipboardWrite(text: string, signal?: AbortSignal): Promise<void> {
      if (platform === 'darwin') {
        await io.write(['pbcopy'], text, signal)
        return
      }
      if (platform === 'win32') {
        await io.write(['powershell', '-NoProfile', '-Command', 'Set-Clipboard', '-Value', text], text, signal)
        return
      }
      await io.write(['xclip', '-selection', 'clipboard'], text, signal)
    },
  }
}
