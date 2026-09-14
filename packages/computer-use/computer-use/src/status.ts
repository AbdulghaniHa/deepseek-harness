/**
 * Status-report helpers for `ctx.computer`: operation lists and recovery copy.
 * @module @deepseek-ai/dsh-computer-use/status
 */

import type {
  ComputerCapability,
  ComputerConnectionState,
  ComputerOperation,
  ComputerPermissionState,
  ComputerPermissions,
  ComputerStatusIssue,
} from './types.ts'

/** Operations every selected provider is expected to serve. */
export const BASE_COMPUTER_OPERATIONS: readonly ComputerOperation[] = [
  'listApps',
  'listWindows',
  'launchApp',
  'focusWindow',
  'listDisplays',
  'setWindowBounds',
]

/** Operations gated by a advertised capability. */
export const COMPUTER_OPERATIONS_BY_CAPABILITY: Readonly<Record<ComputerCapability, readonly ComputerOperation[]>> = {
  a11y: ['snapshot', 'action', 'focusElement'],
  screenshot: ['screenshot'],
  input: ['click', 'type', 'key', 'scroll', 'drag', 'move'],
  clipboard: ['clipboardRead', 'clipboardWrite'],
  'background-actions': [],
}

const ALL_OPERATIONS: readonly ComputerOperation[] = [
  ...BASE_COMPUTER_OPERATIONS,
  ...COMPUTER_OPERATIONS_BY_CAPABILITY.a11y,
  ...COMPUTER_OPERATIONS_BY_CAPABILITY.screenshot,
  ...COMPUTER_OPERATIONS_BY_CAPABILITY.input,
  ...COMPUTER_OPERATIONS_BY_CAPABILITY.clipboard,
]

/**
 * Operations the advertised capabilities currently cover.
 * @param capabilities - selected provider facets.
 * @returns supported operation names, unique and stable-ordered.
 */
export function operationsForCapabilities(capabilities: readonly ComputerCapability[]): readonly ComputerOperation[] {
  const supported = new Set<ComputerOperation>(BASE_COMPUTER_OPERATIONS)
  for (const capability of capabilities) {
    for (const operation of COMPUTER_OPERATIONS_BY_CAPABILITY[capability]) supported.add(operation)
  }
  return ALL_OPERATIONS.filter(operation => supported.has(operation))
}

/**
 * Operations the advertised capabilities do not cover.
 * @param capabilities - selected provider facets.
 * @returns unsupported operation names, unique and stable-ordered.
 */
export function unsupportedOperationsForCapabilities(
  capabilities: readonly ComputerCapability[],
): readonly ComputerOperation[] {
  const supported = new Set(operationsForCapabilities(capabilities))
  return ALL_OPERATIONS.filter(operation => !supported.has(operation))
}

/**
 * Recovery guidance for a machine-routable computer error code.
 * @param code - `ComputerError.code`.
 * @param detail - optional subject such as a configured provider id.
 * @returns one recovery sentence.
 */
export function recoveryForComputerCode(code: string, detail?: string): string {
  switch (code) {
    case 'COMPUTER_PROVIDER_UNAVAILABLE':
      return 'Mount a computer-use provider such as @deepseek-ai/dsh-computer-use-local and retry computer_status.'
    case 'COMPUTER_PROVIDER_CONFIGURED_MISSING':
      return detail === undefined
        ? 'The configured computer provider is not registered. Mount it, or unset computer.provider.'
        : `Configured provider "${detail}" is not registered. Mount it, or unset computer.provider.`
    case 'COMPUTER_PROVIDER_CONFIGURED_UNAVAILABLE':
      return detail === undefined
        ? 'The configured computer provider is registered but unavailable. Restore the native helper, then run dsh computer doctor.'
        : `Configured provider "${detail}" is registered but unavailable. Restore the native helper, then run dsh computer doctor.`
    case 'COMPUTER_PROVIDER_AMBIGUOUS':
      return 'Multiple usable computer providers are registered; set computer.provider to one id.'
    case 'COMPUTER_HOST_CRASHED':
      return 'The native helper crashed. Retry the call; if it persists, run dsh computer doctor.'
    case 'COMPUTER_UNSUPPORTED':
      return 'This operation is not supported by the selected provider or platform. Use computer_status to list supported operations.'
    case 'COMPUTER_GEOMETRY_CHANGED':
      return 'Window geometry changed since the last observation. Call computer_observe (or computer_snapshot) again before using screenshot-space coordinates.'
    case 'COMPUTER_TARGET_MISMATCH':
      return 'The pointer or keyboard target is not the declared window. Focus the window and take a new observation before retrying.'
    case 'COMPUTER_INPUT_BUSY':
      return 'Another agent is holding keyboard keys. Wait for that turn to finish, or cancel it, before sending input.'
    default:
      return 'Inspect computer_status issues, then retry after addressing the reported code.'
  }
}

/**
 * Recovery lines for denied or unknown OS permissions.
 * @param permissions - live probe result.
 * @param platform - host OS.
 * @returns issues for each permission that blocks work.
 */
export function permissionIssues(
  permissions: ComputerPermissions,
  platform: NodeJS.Platform,
): readonly ComputerStatusIssue[] {
  const issues: ComputerStatusIssue[] = []
  pushPermissionIssue(issues, 'accessibility', permissions.accessibility, platform)
  pushPermissionIssue(issues, 'screenRecording', permissions.screenRecording, platform)
  pushPermissionIssue(issues, 'inputInjection', permissions.inputInjection, platform)
  return issues
}

function pushPermissionIssue(
  issues: ComputerStatusIssue[],
  name: 'accessibility' | 'screenRecording' | 'inputInjection',
  state: ComputerPermissionState,
  platform: NodeJS.Platform,
): void {
  if (state === 'granted' || state === 'not-required') return
  issues.push({
    code: `COMPUTER_PERMISSION_${name === 'accessibility' ? 'ACCESSIBILITY' : name === 'screenRecording' ? 'SCREEN' : 'INPUT'}`,
    message: `${name} is ${state}`,
    recovery: permissionRecovery(name, platform),
  })
}

function permissionRecovery(
  name: 'accessibility' | 'screenRecording' | 'inputInjection',
  platform: NodeJS.Platform,
): string {
  if (platform === 'darwin') {
    if (name === 'accessibility' || name === 'inputInjection') {
      return 'Grant Accessibility in System Settings, then re-run dsh computer doctor --request.'
    }
    return 'Grant Screen Recording in System Settings, then re-run dsh computer doctor --request.'
  }
  if (platform === 'linux') {
    if (name === 'inputInjection') {
      return 'Wayland input injection is unsupported; use an X11 session or a remote desktop VM provider.'
    }
    return 'Enable AT-SPI (install at-spi2-core) so accessibility snapshots can run.'
  }
  return 'Windows computer-use is foreground-only; grant no extra OS permission.'
}

/**
 * Connection label from a cheap available check plus a live-probe outcome.
 * @param available - selected provider `available()`.
 * @param probed - whether a live probe ran.
 * @param live - whether that probe succeeded.
 * @returns the status connection field.
 */
export function connectionState(available: boolean, probed: boolean, live: boolean): ComputerConnectionState {
  if (!available) return 'unconfigured'
  if (!probed) return 'configured'
  return live ? 'live' : 'probe-failed'
}
