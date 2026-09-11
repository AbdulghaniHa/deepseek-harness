/**
 * Desktop backend contract implemented by the simulang adapter and the OS fallback.
 * @module @deepseek-ai/dsh-computer-use-local/backend
 */

import type {
  ComputerActionRequest,
  ComputerApp,
  ComputerAppId,
  ComputerCapability,
  ComputerClickRequest,
  ComputerDragRequest,
  ComputerKeyRequest,
  ComputerLaunchRequest,
  ComputerPermissions,
  ComputerScreenshot,
  ComputerScreenshotRequest,
  ComputerScrollRequest,
  ComputerSnapshot,
  ComputerSnapshotRequest,
  ComputerWindow,
  ComputerWindowId,
} from '@deepseek-ai/dsh-computer-use'

/** One OS/GUI implementation the helper process dispatches into. */
export interface DesktopBackend {
  capabilities(): readonly ComputerCapability[]
  permissions(signal?: AbortSignal): Promise<ComputerPermissions>
  listApps(signal?: AbortSignal): Promise<readonly ComputerApp[]>
  listWindows(appId?: ComputerAppId, signal?: AbortSignal): Promise<readonly ComputerWindow[]>
  launchApp(request: ComputerLaunchRequest, signal?: AbortSignal): Promise<ComputerApp>
  focusWindow(windowId: ComputerWindowId, signal?: AbortSignal): Promise<void>
  windowAtPoint(x: number, y: number, signal?: AbortSignal): Promise<ComputerWindow | undefined>
  snapshot(request: ComputerSnapshotRequest, signal?: AbortSignal): Promise<ComputerSnapshot>
  screenshot(request: ComputerScreenshotRequest, signal?: AbortSignal): Promise<ComputerScreenshot>
  press(handle: string, signal?: AbortSignal): Promise<void>
  setValue(handle: string, text: string, signal?: AbortSignal): Promise<void>
  action(request: ComputerActionRequest, signal?: AbortSignal): Promise<void>
  click(request: ComputerClickRequest, signal?: AbortSignal): Promise<void>
  type(text: string, signal?: AbortSignal): Promise<void>
  key(request: ComputerKeyRequest, signal?: AbortSignal): Promise<void>
  scroll(request: ComputerScrollRequest, signal?: AbortSignal): Promise<void>
  move(request: { readonly x: number; readonly y: number }, signal?: AbortSignal): Promise<void>
  drag(request: ComputerDragRequest, signal?: AbortSignal): Promise<void>
  clipboardRead(signal?: AbortSignal): Promise<string>
  clipboardWrite(text: string, signal?: AbortSignal): Promise<void>
}
