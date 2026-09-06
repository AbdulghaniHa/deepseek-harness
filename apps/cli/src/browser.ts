/**
 * `dsh browser install|uninstall|status` — register the Chrome native-messaging
 * host and print the one manual Load-unpacked step until a Web Store id exists.
 * @module @deepseek-ai/dsh/browser
 */

import {
  BROWSER_KINDS,
  extensionDirectory,
  installNativeHost,
  nativeHostStatus,
  uninstallNativeHost,
  type BrowserKind,
} from '@deepseek-ai/dsh-browser-chrome-extension'

const NAME = 'dsh'

/**
 * Run one `dsh browser` invocation.
 * @param action - install, uninstall, or status.
 * @param browser - which Chromium-family browser to touch.
 * @param extensionId - unpacked Chrome extension id to pin in `allowed_origins`.
 * @returns process exit code.
 */
export async function runBrowser(
  action: 'install' | 'uninstall' | 'status',
  browser: BrowserKind,
  extensionId?: string,
): Promise<number> {
  if (!(BROWSER_KINDS as readonly string[]).includes(browser)) {
    process.stderr.write(`${NAME}: unknown browser ${JSON.stringify(browser)} (use ${BROWSER_KINDS.join('|')})\n`)
    return 1
  }
  if (action === 'install') {
    const results = await installNativeHost({
      browsers: [browser],
      ...extensionId === undefined ? {} : { extensionId },
    })
    const extension = extensionDirectory()
    for (const result of results) {
      process.stdout.write(`registered native host for ${result.browser} at ${result.location}\n`)
    }
    process.stdout.write(
      `Load the unpacked extension in ${browser}: chrome://extensions → Developer mode → Load unpacked → ${extension}\n`,
    )
    if (extensionId === undefined) {
      process.stdout.write(
        'If the popup stays Disconnected, copy the extension ID from chrome://extensions and re-run: dsh browser install --browser chrome --extension-id <id>\n',
      )
    }
    return 0
  }
  if (action === 'uninstall') {
    const results = await uninstallNativeHost({ browsers: [browser] })
    for (const result of results) {
      process.stdout.write(`removed native host for ${result.browser} at ${result.location}\n`)
    }
    return 0
  }
  const status = await nativeHostStatus({ browsers: [browser] })
  process.stdout.write(`host launcher: ${status.artifacts.host ? 'present' : 'missing'}\n`)
  process.stdout.write(`extension: ${status.artifacts.extension ? 'present' : 'missing'}\n`)
  for (const entry of status.browsers) {
    process.stdout.write(`${entry.browser}: ${entry.registered ? 'registered' : 'not registered'} (${entry.location})\n`)
  }
  return status.artifacts.host && status.artifacts.extension ? 0 : 1
}
