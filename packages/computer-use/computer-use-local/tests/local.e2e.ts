/**
 * Self-skipping local e2e for the computer-use helper. Skips unless
 * `DSH_COMPUTER_E2E=1`. On macOS it launches TextEdit and lists it. A
 * screenshot is required when Screen Recording is granted; otherwise a
 * capture denial is the observed path (CI and headless agents often lack TCC).
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { createPlatformBackend, doctor } from '@deepseek-ai/dsh-computer-use-local'

const execFileAsync = promisify(execFile)
const enabled = process.env.DSH_COMPUTER_E2E === '1'
const skip = !enabled

let launchedTextEdit = false

afterEach(async () => {
  if (!launchedTextEdit || process.platform !== 'darwin') return
  launchedTextEdit = false
  try {
    await execFileAsync('osascript', ['-e', 'tell application "TextEdit" to quit'], { timeout: 10_000 })
  } catch {
    // TextEdit may already have quit or the permission probe failed first.
  }
})

describe.skipIf(skip)('computer-use-local e2e', () => {
  it('probes permissions and drives TextEdit on macOS', async () => {
    const report = await doctor({ request: false })
    expect(report.platform).toBe(process.platform)
    expect(report.backend === 'platform' || report.backend === 'simulang').toBe(true)
    if (process.platform !== 'darwin') return
    const backend = createPlatformBackend({ platform: 'darwin' })
    await backend.launchApp({ name: 'TextEdit' })
    launchedTextEdit = true
    const apps = await backend.listApps()
    expect(apps.some(app => app.name === 'TextEdit')).toBe(true)
    if (report.permissions.screenRecording === 'granted') {
      const shot = await backend.screenshot({})
      expect(shot.png.byteLength).toBeGreaterThan(0)
      return
    }
    const failure = await backend.screenshot({}).catch((error: unknown) => error)
    expect((failure as { code?: string }).code).toMatch(/^COMPUTER_(UNSUPPORTED|PERMISSION_DENIED)$/)
  }, 30_000)
})
