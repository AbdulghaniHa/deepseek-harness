import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import ComputerRuntime, { ComputerAppId, ComputerDisplayId, ComputerWindowId, type ComputerProvider } from '@deepseek-ai/dsh-computer-use'
import * as ToolComputerUse from '@deepseek-ai/dsh-tool-computer-use'
import type { Agent } from '@deepseek-ai/dsh-agent'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

const FakeComputerProvider = {
  name: 'fake-computer-provider',
  inject: ['computer'],
  apply(ctx: Context): void {
    const provider: ComputerProvider = {
      id: 'fake',
      available: () => true,
      capabilities: () => ['a11y'],
      permissions: () => Promise.resolve({ accessibility: 'granted', screenRecording: 'granted', inputInjection: 'granted' }),
      listApps: () => Promise.resolve([{ id: ComputerAppId('notes'), name: 'Notes', pid: 1 }]),
      listWindows: () => Promise.resolve([{
        id: ComputerWindowId('w1'),
        appId: ComputerAppId('notes'),
        title: 'Notes',
        bounds: { x: 0, y: 0, width: 800, height: 600 },
        focused: true,
      }]),
      listDisplays: () => Promise.resolve([{
        id: ComputerDisplayId('d1'),
        bounds: { x: 0, y: 0, width: 800, height: 600 },
        scale: 1,
        primary: true,
      }]),
      launchApp: request => Promise.resolve({ id: ComputerAppId('notes'), name: request.name, pid: 1 }),
      focusWindow: () => Promise.resolve(),
      setWindowBounds: () => Promise.resolve(),
      windowAtPoint: () => Promise.resolve(undefined),
      snapshot: request => Promise.resolve({
        windowId: request.windowId,
        appId: ComputerAppId('notes'),
        title: 'Notes',
        truncated: false,
        nodes: [],
      }),
      screenshot: () => Promise.resolve({
        png: new Uint8Array([1]),
        width: 1,
        height: 1,
        scale: 1,
        bounds: { x: 0, y: 0, width: 1, height: 1 },
      }),
      press: () => Promise.resolve(),
      setValue: () => Promise.resolve(),
      focusElement: () => Promise.resolve(),
      action: () => Promise.resolve(),
      click: () => Promise.resolve(),
      type: () => Promise.resolve(),
      key: () => Promise.resolve(),
      scroll: () => Promise.resolve(),
      drag: () => Promise.resolve(),
      move: () => Promise.resolve(),
      clipboardRead: () => Promise.resolve(''),
      clipboardWrite: () => Promise.resolve(),
    }
    ctx.computer.registerProvider(provider)
  },
}

async function boot(configLines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-computer-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-computer-use'",
    "- name: './fake-computer-provider.mjs'",
    "- name: '@deepseek-ai/dsh-tool-computer-use'",
    ...configLines.length > 0 ? ['  config:', ...configLines] : [],
    '',
  ].join('\n'))
  await writeFile(join(root, 'fake-computer-provider.mjs'), 'export default {}\n')

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-computer-use', ComputerRuntime],
    ['./fake-computer-provider.mjs', FakeComputerProvider],
    ['@deepseek-ai/dsh-tool-computer-use', ToolComputerUse],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

describe('tool-computer-use real Loader composition through cordis.yml', () => {
  it('registers computer tools and lists apps through a fake provider', async () => {
    const ctx = await boot(['    approval: never'])
    expect(ctx.tools.schemas().map(schema => schema.name)).toContain('computer_apps')
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('apps'),
      name: 'computer_apps',
      arguments: {},
      agent: {
        id: SessionId('loader'),
        session: Session.create(SessionId('loader')),
      } as unknown as Agent,
    })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({
      apps: [{ appId: 'notes', name: 'Notes' }],
    })
  }, 30_000)

  it('completes a mutating call with default never-mode and no approval or user-question service', async () => {
    const ctx = await boot([])
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('launch'),
      name: 'computer_launch',
      arguments: { app: 'Notes' },
      agent: {
        id: SessionId('loader'),
        session: Session.create(SessionId('loader')),
      } as unknown as Agent,
    })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ app: 'Notes' })
  }, 30_000)

  it('leaves tools unregistered when enabled is false', async () => {
    const ctx = await boot(['    enabled: false'])
    expect(ctx.tools.schemas().map(schema => schema.name)).not.toContain('computer_apps')
  }, 30_000)

  it('disposes the loaded composition without leaking the computer tools fiber (HMR safety)', async () => {
    const ctx = await boot(['    approval: never'])
    expect(ctx.tools.schemas().map(schema => schema.name)).toContain('computer_apps')
    await ctx.fiber.dispose()
    context = undefined
  }, 30_000)
})
