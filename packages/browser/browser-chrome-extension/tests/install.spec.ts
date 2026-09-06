import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(() => ({ status: 0, stdout: '', stderr: '' })),
}))

import { spawnSync } from 'node:child_process'
import {
  BROWSER_KINDS,
  DEFAULT_EXTENSION_ID,
  defaultBrowserSocketPath,
  extensionDirectory,
  installNativeHost,
  nativeHostLauncherPath,
  nativeHostManifest,
  nativeHostManifestPath,
  nativeHostStatus,
  probeHostArtifacts,
  uninstallNativeHost,
  windowsRegistryKey,
} from '@deepseek-ai/dsh-browser-chrome-extension'

let root: string | undefined

afterEach(() => {
  vi.mocked(spawnSync).mockClear()
  root = undefined
})

describe('native host paths and manifest', () => {
  it('resolves per-OS file and registry locations', () => {
    expect(nativeHostManifestPath('chrome', 'darwin', '/Users/me')).toMatchObject({
      path: expect.stringContaining('Google/Chrome/NativeMessagingHosts/com.deepseek.dsh.browser.json'),
    })
    expect(nativeHostManifestPath('chromium', 'linux', '/home/me')).toMatchObject({
      path: expect.stringContaining('.config/chromium/NativeMessagingHosts'),
    })
    expect(nativeHostManifestPath('edge', 'linux', '/home/me')).toMatchObject({
      path: expect.stringContaining('microsoft-edge'),
    })
    expect(nativeHostManifestPath('brave', 'darwin', '/Users/me')).toMatchObject({
      path: expect.stringContaining('Brave-Browser'),
    })
    expect(nativeHostManifestPath('chrome', 'win32', 'C:\\Users\\me')).toEqual({
      kind: 'registry',
      key: windowsRegistryKey('chrome'),
    })
    expect(BROWSER_KINDS).toContain('chrome')
  })

  it('pins allowed_origins to the extension id and picks the platform launcher', () => {
    const manifest = nativeHostManifest('/opt/host', 'abc')
    expect(manifest.allowed_origins).toEqual(['chrome-extension://abc/'])
    expect(manifest.name).toBe('com.deepseek.dsh.browser')
    expect(nativeHostLauncherPath('/pkg', 'darwin')).toBe(join('/pkg', 'bin', 'dsh-browser-host'))
    expect(nativeHostLauncherPath('/pkg', 'win32')).toBe(join('/pkg', 'bin', 'dsh-browser-host.cmd'))
    expect(extensionDirectory('/pkg')).toBe(join('/pkg', 'extension'))
    expect(nativeHostLauncherPath()).toContain('dsh-browser-host')
    expect(extensionDirectory()).toContain('extension')
    expect(nativeHostManifest('/opt/host').allowed_origins[0]).toContain(DEFAULT_EXTENSION_ID)
    expect(defaultBrowserSocketPath('win32')).toBe('\\\\.\\pipe\\dsh-browser-host')
    expect(defaultBrowserSocketPath('darwin')).toContain('browser')
    expect(defaultBrowserSocketPath()).toEqual(defaultBrowserSocketPath(process.platform))
  })

  it('probes missing artifacts as false and existing ones as true', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-browser-art-'))
    expect(probeHostArtifacts(root, 'darwin')).toEqual({ host: false, extension: false })
    await mkdir(join(root, 'bin'), { recursive: true })
    await mkdir(join(root, 'extension'), { recursive: true })
    await writeFile(join(root, 'bin', 'dsh-browser-host'), '')
    await writeFile(join(root, 'extension', 'manifest.json'), '{}')
    expect(probeHostArtifacts(root, 'darwin')).toEqual({ host: true, extension: true })
    expect(probeHostArtifacts().extension).toBe(true)
  })
})

describe('install and uninstall', () => {
  it('writes and removes a POSIX host manifest', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-browser-home-'))
    const [installed] = await installNativeHost({
      browsers: ['chrome'],
      home: root,
      platform: 'darwin',
      hostPath: '/opt/dsh-browser-host',
      extensionId: DEFAULT_EXTENSION_ID,
    })
    const text = await readFile(installed!.location, 'utf8')
    expect(JSON.parse(text).path).toBe('/opt/dsh-browser-host')
    const status = await nativeHostStatus({ browsers: ['chrome'], home: root, platform: 'darwin', packageRoot: root })
    expect(status.browsers[0]?.registered).toBe(true)
    await uninstallNativeHost({ browsers: ['chrome'], home: root, platform: 'darwin' })
    const after = await nativeHostStatus({ browsers: ['chrome'], home: root, platform: 'darwin', packageRoot: root })
    expect(after.browsers[0]?.registered).toBe(false)
    const empty = await nativeHostStatus({ browsers: ['chrome'], home: root, platform: 'darwin', packageRoot: root })
    expect(empty.browsers[0]?.registered).toBe(false)
    await mkdir(join(root, 'Library/Application Support/Google/Chrome/NativeMessagingHosts'), { recursive: true })
    await writeFile(
      join(root, 'Library/Application Support/Google/Chrome/NativeMessagingHosts/com.deepseek.dsh.browser.json'),
      '{}\n',
    )
    const foreign = await nativeHostStatus({ browsers: ['chrome'], home: root, platform: 'darwin', packageRoot: root })
    expect(foreign.browsers[0]?.registered).toBe(false)
    await installNativeHost({ home: root, platform: 'darwin', hostPath: '/opt/h' })
  })

  it('uses reg add/delete on Windows and reports registry status', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-browser-win-'))
    await installNativeHost({
      browsers: ['chrome'],
      platform: 'win32',
      hostPath: join(root, 'host.exe'),
    })
    expect(vi.mocked(spawnSync)).toHaveBeenCalledWith(
      'reg',
      expect.arrayContaining(['add', windowsRegistryKey('chrome')]),
      expect.any(Object),
    )
    const status = await nativeHostStatus({ browsers: ['chrome'], platform: 'win32', packageRoot: root })
    expect(status.browsers[0]?.registered).toBe(true)
    vi.mocked(spawnSync).mockReturnValueOnce({ status: 1, stdout: '', stderr: '' } as ReturnType<typeof spawnSync>)
    const missing = await nativeHostStatus({ browsers: ['edge'], platform: 'win32', packageRoot: root })
    expect(missing.browsers[0]?.registered).toBe(false)
    await uninstallNativeHost({ browsers: ['chrome'], platform: 'win32' })
    expect(vi.mocked(spawnSync)).toHaveBeenCalledWith(
      'reg',
      expect.arrayContaining(['delete', windowsRegistryKey('chrome')]),
      expect.any(Object),
    )
  })

  it('throws when reg fails', async () => {
    const hostPath = join(await mkdtemp(join(tmpdir(), 'dsh-browser-reg-')), 'h.exe')
    vi.mocked(spawnSync).mockReturnValueOnce({ status: 1, stdout: '', stderr: 'denied' } as ReturnType<typeof spawnSync>)
    await expect(installNativeHost({ browsers: ['chrome'], platform: 'win32', hostPath }))
      .rejects.toThrow('reg add failed')
    vi.mocked(spawnSync).mockReturnValueOnce({ status: 2, stdout: '', stderr: '' } as ReturnType<typeof spawnSync>)
    await expect(installNativeHost({ browsers: ['chrome'], platform: 'win32', hostPath }))
      .rejects.toThrow('exit 2')
  })

  it('rethrows a non-ENOENT status read error', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-browser-eisdir-'))
    const target = nativeHostManifestPath('chrome', 'darwin', root)
    if (target.kind !== 'file') throw new Error('expected a file manifest path')
    await mkdir(target.path, { recursive: true })
    await expect(nativeHostStatus({ browsers: ['chrome'], home: root, platform: 'darwin', packageRoot: root }))
      .rejects.toThrow()
  })
})
