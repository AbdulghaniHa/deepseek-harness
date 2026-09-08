/**
 * Deterministic ctx.browser provider for the browser-tabs snapshot. Replay
 * re-executes browser_tabs against this in-process backend.
 */
import { BrowserTabId } from '@deepseek-ai/dsh-browser'

/** Cordis plugin name. */
export const name = 'browser-tabs-fixture'

/** Service used by the fixture provider. */
export const inject = ['browser']

const TAB = {
  id: BrowserTabId('1'),
  url: 'https://example.com/home',
  title: 'Home',
  active: true,
  windowId: 1,
  grouped: false,
}

/**
 * Register the deterministic provider.
 * @param ctx - Cordis context that owns ctx.browser.
 */
export function apply(ctx) {
  ctx.browser.registerProvider({
    id: 'fake',
    available: () => true,
    capabilities: () => ['tabs', 'cdp'],
    listTabs: () => Promise.resolve([TAB]),
    openTab: request => Promise.resolve({ ...TAB, active: false, url: request.url, grouped: request.group === true }),
    attach: () => Promise.resolve(),
    detach: () => Promise.resolve(),
    closeTab: () => Promise.resolve(),
    cdp: request => Promise.resolve(request.method === 'Page.captureScreenshot' ? { data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8xkAAAAASUVORK5CYII=' } : {}),
    onCdpEvent: () => () => {},
  })
}
