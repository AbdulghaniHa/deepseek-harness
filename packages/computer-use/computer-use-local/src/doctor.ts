/**
 * Standalone permission probe for `dsh computer doctor`. Does not require Cordis.
 * @module @deepseek-ai/dsh-computer-use-local/doctor
 */

import type { ComputerCapability, ComputerPermissions } from '@deepseek-ai/dsh-computer-use'
import { createPlatformBackend } from './platform.ts'
import { createSimulangBackend, loadSimulang } from './simulang.ts'

/** Which implementation the doctor used. */
export type ComputerDoctorBackend = 'simulang' | 'platform'

/** Printed report for `dsh computer doctor`. */
export interface ComputerDoctorReport {
  readonly platform: NodeJS.Platform
  readonly backend: ComputerDoctorBackend
  readonly permissions: ComputerPermissions
  readonly capabilities: readonly ComputerCapability[]
  readonly remediation: readonly string[]
}

function darwinRemediation(permissions: ComputerPermissions): string[] {
  const lines: string[] = []
  if (permissions.accessibility !== 'granted') {
    lines.push('Grant Accessibility: x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility')
  }
  if (permissions.screenRecording !== 'granted') {
    lines.push('Grant Screen Recording: x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
  }
  if (permissions.inputInjection !== 'granted' && permissions.inputInjection !== 'not-required') {
    lines.push('Input injection uses Accessibility; grant that permission, then re-run dsh computer doctor --request')
  }
  return lines
}

function linuxRemediation(permissions: ComputerPermissions): string[] {
  const lines: string[] = []
  if (permissions.inputInjection === 'denied') {
    lines.push('Wayland input injection is unsupported; use an X11 session or a remote desktop VM provider')
  }
  if (permissions.accessibility !== 'granted') {
    lines.push('Enable AT-SPI (install at-spi2-core) so accessibility snapshots can run')
  }
  return lines
}

/** Options for {@link doctor}. */
export interface ComputerDoctorOptions {
  readonly request?: boolean
  readonly platform?: NodeJS.Platform
  /** Override the optional native import; tests inject a duck-typed module. */
  readonly load?: typeof loadSimulang
}

/**
 * OS-specific remediation lines for a permission snapshot.
 * @param platform - host OS.
 * @param permissions - probe result.
 * @returns lines the CLI prints after the status fields.
 */
export function computerDoctorRemediation(
  platform: NodeJS.Platform,
  permissions: ComputerPermissions,
): string[] {
  if (platform === 'darwin') return darwinRemediation(permissions)
  if (platform === 'linux') return linuxRemediation(permissions)
  return ['Windows computer-use is foreground-only; grant no extra OS permission']
}

/**
 * Probe computer-use permissions without booting a Cordis context.
 * @param options - when `request` is true, trigger a capture so the OS may prompt.
 * @returns the report the CLI prints.
 */
export async function doctor(options: ComputerDoctorOptions = {}): Promise<ComputerDoctorReport> {
  const platform = options.platform ?? process.platform
  /* v8 ignore next -- the real addon import runs in local.e2e.ts; unit tests inject `load`. */
  const simulang = await (options.load ?? loadSimulang)()
  const backend = simulang === undefined
    ? createPlatformBackend({ platform })
    : createSimulangBackend(simulang)
  const kind: ComputerDoctorBackend = simulang === undefined ? 'platform' : 'simulang'
  if (options.request === true) {
    try {
      await backend.screenshot({})
    } catch {
      // A denied capture is still a successful probe of the prompt.
    }
    try {
      await backend.listApps()
    } catch {
      // Listing may also trigger Accessibility on macOS.
    }
  }
  const permissions = await backend.permissions()
  const capabilities = backend.capabilities()
  const remediation = computerDoctorRemediation(platform, permissions)
  return {
    platform,
    backend: kind,
    permissions,
    capabilities,
    remediation,
  }
}

/**
 * Format a doctor report for stdout.
 * @param report - probe result.
 * @returns printable text with a trailing newline.
 */
export function formatDoctorReport(report: ComputerDoctorReport): string {
  const lines = [
    `platform: ${report.platform}`,
    `backend: ${report.backend}`,
    `capabilities: ${report.capabilities.join(', ') || '(none)'}`,
    `accessibility: ${report.permissions.accessibility}`,
    `screenRecording: ${report.permissions.screenRecording}`,
    `inputInjection: ${report.permissions.inputInjection}`,
    ...report.remediation.map(line => `remediation: ${line}`),
  ]
  return `${lines.join('\n')}\n`
}
