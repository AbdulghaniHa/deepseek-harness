import { afterEach, describe, expect, it, vi } from 'vitest'

const doctor = vi.fn()
const formatDoctorReport = vi.fn(() => 'report\n')

vi.mock('@deepseek-ai/dsh-computer-use-local', () => ({
  doctor,
  formatDoctorReport,
}))

const { runComputer } = await import('../src/computer.ts')

afterEach(() => {
  vi.restoreAllMocks()
  doctor.mockReset()
  formatDoctorReport.mockReset()
  formatDoctorReport.mockReturnValue('report\n')
})

describe('runComputer', () => {
  it('prints a doctor report', async () => {
    doctor.mockResolvedValue({ platform: 'darwin', backend: 'platform' })
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    await expect(runComputer('doctor', false)).resolves.toBe(0)
    expect(doctor).toHaveBeenCalledWith({ request: false })
    expect(write).toHaveBeenCalledWith('report\n')
  })

  it('forwards --request', async () => {
    doctor.mockResolvedValue({ platform: 'darwin', backend: 'platform' })
    vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    await expect(runComputer('doctor', true)).resolves.toBe(0)
    expect(doctor).toHaveBeenCalledWith({ request: true })
  })
})
