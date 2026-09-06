import { afterEach, describe, expect, it, vi } from 'vitest'

const installNativeHost = vi.fn()
const uninstallNativeHost = vi.fn()
const nativeHostStatus = vi.fn()
const extensionDirectory = vi.fn(() => '/ext/path')

vi.mock('@deepseek-ai/dsh-browser-chrome-extension', () => ({
  BROWSER_KINDS: ['chrome', 'chromium', 'edge', 'brave'],
  installNativeHost,
  uninstallNativeHost,
  nativeHostStatus,
  extensionDirectory,
}))

const { runBrowser } = await import('../src/browser.ts')

afterEach(() => {
  vi.restoreAllMocks()
  installNativeHost.mockReset()
  uninstallNativeHost.mockReset()
  nativeHostStatus.mockReset()
})

describe('runBrowser', () => {
  it('rejects an unknown browser kind', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    await expect(runBrowser('status', 'safari' as 'chrome')).resolves.toBe(1)
    expect(write).toHaveBeenCalled()
  })

  it('installs the native host and prints the Load-unpacked path', async () => {
    installNativeHost.mockResolvedValue([{ browser: 'chrome', location: '/manifest.json' }])
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    await expect(runBrowser('install', 'chrome')).resolves.toBe(0)
    expect(installNativeHost).toHaveBeenCalledWith({ browsers: ['chrome'] })
    expect(write.mock.calls.map(call => String(call[0])).join('')).toContain('--extension-id')
    expect(write.mock.calls.map(call => String(call[0])).join('')).toContain('Load unpacked')
    expect(write.mock.calls.map(call => String(call[0])).join('')).toContain('/ext/path')
  })

  it('pins allowed_origins when an unpacked extension id is supplied', async () => {
    installNativeHost.mockResolvedValue([{ browser: 'chrome', location: '/manifest.json' }])
    vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const id = 'abcdefghijklmnopabcdefghijklmnop'
    await expect(runBrowser('install', 'chrome', id)).resolves.toBe(0)
    expect(installNativeHost).toHaveBeenCalledWith({ browsers: ['chrome'], extensionId: id })
  })

  it('uninstalls the native host', async () => {
    uninstallNativeHost.mockResolvedValue([{ browser: 'edge', location: '/manifest.json' }])
    vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    await expect(runBrowser('uninstall', 'edge')).resolves.toBe(0)
    expect(uninstallNativeHost).toHaveBeenCalledWith({ browsers: ['edge'] })
  })

  it('reports status and fails when artifacts are missing', async () => {
    nativeHostStatus.mockResolvedValue({
      artifacts: { host: false, extension: true },
      browsers: [{ browser: 'chrome', registered: false, location: '/manifest.json' }],
    })
    vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    await expect(runBrowser('status', 'chrome')).resolves.toBe(1)
  })

  it('reports status success when host and extension artifacts exist', async () => {
    nativeHostStatus.mockResolvedValue({
      artifacts: { host: true, extension: true },
      browsers: [{ browser: 'brave', registered: true, location: '/manifest.json' }],
    })
    vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    await expect(runBrowser('status', 'brave')).resolves.toBe(0)
  })
})
