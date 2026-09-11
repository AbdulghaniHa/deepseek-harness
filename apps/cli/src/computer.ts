/**
 * `dsh computer doctor` — print computer-use permission state and remediation.
 * @module @deepseek-ai/dsh/computer
 */

import { doctor, formatDoctorReport } from '@deepseek-ai/dsh-computer-use-local'

/**
 * Run one `dsh computer` invocation.
 * @param action - subcommand name; only `doctor` is implemented.
 * @param request - when true, trigger a capture so the OS may prompt.
 * @returns process exit code.
 */
export async function runComputer(action: string, request: boolean): Promise<number> {
  if (action !== 'doctor') return 1
  const report = await doctor({ request })
  process.stdout.write(formatDoctorReport(report))
  return 0
}
