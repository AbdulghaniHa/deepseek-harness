/**
 * Self-skipping Chromium e2e for the unpacked MV3 extension. Skips unless
 * `DSH_BROWSER_E2E=1` and a Chromium-family binary is on the machine. Does not
 * add Playwright: the probe launches Chromium with `--load-extension` and
 * asserts the process starts against a local fixture page.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const extensionDir = join(packageRoot, 'extension')

function findChromium(): string | undefined {
  const env = process.env.DSH_BROWSER_CHROMIUM
  if (env !== undefined && env.length > 0 && existsSync(env)) return env
  const named = ['chromium', 'google-chrome', 'chromium-browser', 'chrome']
  for (const candidate of [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ...named,
  ]) {
    if (candidate.startsWith('/') && existsSync(candidate)) return candidate
    const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [candidate], {
      encoding: 'utf8',
      timeout: 5_000,
    })
    const line = probe.stdout.trim().split('\n')[0]
    if (probe.status === 0 && line !== undefined && line.length > 0) return line
  }
  return undefined
}

const enabled = process.env.DSH_BROWSER_E2E === '1'
const chromium = enabled ? findChromium() : undefined
const skip = !enabled || chromium === undefined

let userData: string | undefined

afterEach(async () => {
  if (userData !== undefined) await rm(userData, { recursive: true, force: true })
  userData = undefined
})

describe.skipIf(skip)('chrome extension e2e', () => {
  it('starts Chromium with the unpacked extension and a local fixture page', async () => {
    expect(existsSync(join(extensionDir, 'manifest.json'))).toBe(true)
    userData = await mkdtemp(join(tmpdir(), 'dsh-browser-e2e-'))
    const page = join(userData, 'fixture.html')
    await writeFile(page, '<!doctype html><title>Fixture</title><button id="go">Go</button>\n')
    const child = spawn(chromium as string, [
      `--user-data-dir=${userData}`,
      `--load-extension=${extensionDir}`,
      '--disable-extensions-except=' + extensionDir,
      '--no-first-run',
      '--no-default-browser-check',
      '--headless=new',
      `file://${page}`,
    ], { stdio: 'ignore' })
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { resolve() }, 2_000)
        child.once('exit', (code, signal) => {
          clearTimeout(timer)
          reject(new Error(`Chromium exited early: code=${code} signal=${signal}`))
        })
        child.once('error', (error) => {
          clearTimeout(timer)
          reject(error)
        })
      })
    } finally {
      child.kill('SIGKILL')
    }
  }, 15_000)
})
