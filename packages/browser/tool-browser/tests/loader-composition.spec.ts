import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import BrowserRuntime, { BrowserTabId, type BrowserProvider, type BrowserTab } from '@deepseek-ai/dsh-browser'
import * as ToolBrowser from '@deepseek-ai/dsh-tool-browser'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function tab(id: string): BrowserTab {
  return {
    id: BrowserTabId(id),
    url: `https://example.com/${id}`,
    title: id,
    active: true,
    windowId: 1,
    grouped: false,
  }
}

const FakeBrowserProvider = {
  name: 'fake-browser-provider',
  inject: ['browser'],
  apply(ctx: Context): void {
    const provider: BrowserProvider = {
      id: 'fake',
      available: () => true,
      capabilities: () => ['tabs', 'cdp'],
      listTabs: () => Promise.resolve([tab('1')]),
      openTab: () => Promise.resolve(tab('opened')),
      attach: () => Promise.resolve(),
      detach: () => Promise.resolve(),
      closeTab: () => Promise.resolve(),
      cdp: () => Promise.resolve({}),
      onCdpEvent: () => () => {},
    }
    ctx.browser.registerProvider(provider)
  },
}

async function boot(configLines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-browser-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-browser'",
    "- name: './fake-browser-provider.mjs'",
    "- name: '@deepseek-ai/dsh-tool-browser'",
    ...configLines.length > 0 ? ['  config:', ...configLines] : [],
    '',
  ].join('\n'))
  await writeFile(join(root, 'fake-browser-provider.mjs'), 'export default {}\n')

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-browser', BrowserRuntime],
    ['./fake-browser-provider.mjs', FakeBrowserProvider],
    ['@deepseek-ai/dsh-tool-browser', ToolBrowser],
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

describe('tool-browser real Loader composition through cordis.yml', () => {
  it('registers browser tools and lists tabs through a fake provider', async () => {
    const ctx = await boot(['    approval: never'])
    expect(ctx.tools.schemas().map(schema => schema.name)).toContain('browser_tabs')
    expect(ctx.tools.schemas().map(schema => schema.name)).toContain('browser_network')
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('tabs'),
      name: 'browser_tabs',
      arguments: {},
      agent: { id: SessionId('loader') } as unknown as import('@deepseek-ai/dsh-agent').Agent,
    })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({
      tabs: [{ tabId: '1', url: 'https://example.com/1', title: '1', active: true }],
    })
  }, 30_000)

  it('completes a mutating call with default never-mode and no approval service', async () => {
    const ctx = await boot([])
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('open'),
      name: 'browser_open',
      arguments: { url: 'https://example.com/opened' },
      agent: { id: SessionId('loader') } as unknown as import('@deepseek-ai/dsh-agent').Agent,
    })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ tabId: 'opened' })
  }, 30_000)

  it('leaves tools unregistered when enabled is false', async () => {
    const ctx = await boot(['    enabled: false'])
    expect(ctx.tools.schemas().map(schema => schema.name)).not.toContain('browser_tabs')
  }, 30_000)
})
