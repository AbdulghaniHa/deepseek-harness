/**
 * Deterministic ctx.computer provider for the text-only screenshot refusal
 * snapshot. Replay re-executes computer_screenshot against this backend.
 */
import { ComputerAppId, ComputerWindowId } from '@deepseek-ai/dsh-computer-use'

/** Cordis plugin name. */
export const name = 'computer-apps-fixture'

/** Service used by the fixture provider. */
export const inject = ['computer']

const APP = {
  id: ComputerAppId('notes'),
  name: 'Notes',
  pid: 4000,
}

const WINDOW = {
  id: ComputerWindowId('w1'),
  appId: APP.id,
  title: 'Untitled',
  bounds: { x: 0, y: 0, width: 800, height: 600 },
  focused: true,
}

/**
 * Register the deterministic provider.
 * @param ctx - Cordis context that owns ctx.computer.
 */
export function apply(ctx) {
  ctx.computer.registerProvider({
    id: 'fake',
    available: () => true,
    capabilities: () => ['a11y', 'screenshot'],
    permissions: () => Promise.resolve({
      accessibility: 'granted',
      screenRecording: 'granted',
      inputInjection: 'granted',
    }),
    listApps: () => Promise.resolve([APP]),
    listWindows: () => Promise.resolve([WINDOW]),
    launchApp: request => Promise.resolve({ ...APP, name: request.name }),
    focusWindow: () => Promise.resolve(),
    windowAtPoint: () => Promise.resolve(WINDOW),
    snapshot: request => Promise.resolve({
      windowId: request.windowId,
      appId: APP.id,
      title: WINDOW.title,
      truncated: false,
      nodes: [],
    }),
    screenshot: () => Promise.resolve({
      png: new Uint8Array([137, 80, 78, 71]),
      width: 10,
      height: 10,
      scale: 1,
      bounds: WINDOW.bounds,
    }),
    press: () => Promise.resolve(),
    setValue: () => Promise.resolve(),
    click: () => Promise.resolve(),
    type: () => Promise.resolve(),
    key: () => Promise.resolve(),
    scroll: () => Promise.resolve(),
    drag: () => Promise.resolve(),
    move: () => Promise.resolve(),
    clipboardRead: () => Promise.resolve(''),
    clipboardWrite: () => Promise.resolve(),
  })
}
