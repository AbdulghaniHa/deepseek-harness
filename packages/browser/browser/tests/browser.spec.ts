import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import BrowserRuntime, {
  BrowserAttachmentId,
  BrowserError,
  BrowserTabId,
  type BrowserCdpEvent,
  type BrowserProvider,
  type BrowserTab,
} from '@deepseek-ai/dsh-browser'

function makeAgent(id: string): Agent {
  return { id: SessionId(id) } as unknown as Agent
}

function tab(id: string, overrides: Partial<BrowserTab> = {}): BrowserTab {
  return {
    id: BrowserTabId(id),
    url: `https://example.com/${id}`,
    title: id,
    active: false,
    windowId: 1,
    grouped: false,
    ...overrides,
  }
}

function makeProvider(id: string, available: boolean, extras: Partial<BrowserProvider> = {}): BrowserProvider & {
  attached: string[]
  cdpCalls: { method: string }[]
  emit(event: BrowserCdpEvent): void
} {
  const attached: string[] = []
  const cdpCalls: { method: string }[] = []
  const listeners = new Set<(event: BrowserCdpEvent) => void>()
  const first = tab('1')
  return {
    id,
    available: () => available,
    capabilities: () => ['tabs', 'cdp'],
    listTabs: () => Promise.resolve([first]),
    openTab: request => Promise.resolve(tab('opened', { url: request.url, grouped: request.group === true })),
    attach: (tabId) => {
      attached.push(tabId)
      return Promise.resolve()
    },
    detach: (tabId) => {
      const index = attached.indexOf(tabId)
      if (index >= 0) attached.splice(index, 1)
      return Promise.resolve()
    },
    closeTab: () => Promise.resolve(),
    cdp: (request) => {
      cdpCalls.push({ method: request.method })
      return Promise.resolve({ ok: request.method })
    },
    onCdpEvent: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    emit(event: BrowserCdpEvent) {
      for (const listener of listeners) listener(event)
    },
    attached,
    cdpCalls,
    ...extras,
  }
}

async function mount(config: ConstructorParameters<typeof BrowserRuntime>[1] = {}): Promise<{
  ctx: Context
  browser: BrowserRuntime
}> {
  const ctx = new Context()
  await ctx.plugin(BrowserRuntime, config)
  return { ctx, browser: ctx.browser }
}

const available = true
const unavailable = false

describe('BrowserRuntime registration', () => {
  it('registers a provider and unregisters it via the returned disposer', async () => {
    const { browser } = await mount()
    const provider = makeProvider('chrome', available)
    const dispose = browser.registerProvider(provider)
    await expect(browser.listTabs()).resolves.toHaveLength(1)
    dispose()
    await expect(browser.listTabs()).rejects.toThrow(expect.objectContaining({ code: 'BROWSER_PROVIDER_UNAVAILABLE' }))
  })

  it('throws BROWSER_DUPLICATE_PROVIDER on a duplicate id', async () => {
    const { browser } = await mount()
    browser.registerProvider(makeProvider('chrome', available))
    expect(() => browser.registerProvider(makeProvider('chrome', available)))
      .toThrow(expect.objectContaining({ code: 'BROWSER_DUPLICATE_PROVIDER' }))
  })

  it('disposes provider registrations when the contributing fiber is disposed (HMR safety)', async () => {
    const { ctx, browser } = await mount()
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.browser.registerProvider(makeProvider('chrome', available))
    }, { inject: ['browser'] }))
    await expect(browser.listTabs()).resolves.toHaveLength(1)
    await fiber.dispose()
    await expect(browser.listTabs()).rejects.toThrow(expect.objectContaining({ code: 'BROWSER_PROVIDER_UNAVAILABLE' }))
  })
})

describe('BrowserRuntime execution resolution', () => {
  it('throws BROWSER_PROVIDER_UNAVAILABLE when nothing is registered', async () => {
    const { browser } = await mount()
    await expect(browser.listTabs()).rejects.toThrow(expect.objectContaining({ code: 'BROWSER_PROVIDER_UNAVAILABLE' }))
  })

  it('throws BROWSER_PROVIDER_UNAVAILABLE when providers exist but none are usable', async () => {
    const { browser } = await mount()
    browser.registerProvider(makeProvider('chrome', unavailable))
    await expect(browser.listTabs()).rejects.toThrow(expect.objectContaining({ code: 'BROWSER_PROVIDER_UNAVAILABLE' }))
  })

  it('throws BROWSER_PROVIDER_CONFIGURED_MISSING for an unregistered configured id', async () => {
    const { browser } = await mount({ provider: 'missing' })
    browser.registerProvider(makeProvider('chrome', available))
    await expect(browser.listTabs()).rejects.toThrow(expect.objectContaining({ code: 'BROWSER_PROVIDER_CONFIGURED_MISSING' }))
  })

  it('throws BROWSER_PROVIDER_CONFIGURED_UNAVAILABLE for an unusable configured id', async () => {
    const { browser } = await mount({ provider: 'chrome' })
    browser.registerProvider(makeProvider('chrome', unavailable))
    await expect(browser.listTabs()).rejects.toThrow(expect.objectContaining({ code: 'BROWSER_PROVIDER_CONFIGURED_UNAVAILABLE' }))
  })

  it('throws BROWSER_PROVIDER_AMBIGUOUS rather than picking by order', async () => {
    const { browser } = await mount()
    browser.registerProvider(makeProvider('chrome', available))
    browser.registerProvider(makeProvider('edge', available))
    await expect(browser.listTabs()).rejects.toThrow(expect.objectContaining({ code: 'BROWSER_PROVIDER_AMBIGUOUS' }))
  })

  it('runs the configured provider even when another usable provider is registered', async () => {
    const { browser } = await mount({ provider: 'edge' })
    browser.registerProvider(makeProvider('chrome', available))
    const edge = makeProvider('edge', available, {
      listTabs: () => Promise.resolve([tab('edge')]),
    })
    browser.registerProvider(edge)
    await expect(browser.listTabs()).resolves.toEqual([expect.objectContaining({ id: 'edge' })])
  })

  it('reads DSH_BROWSER_PROVIDER as the same configured id field', async () => {
    const previous = process.env.DSH_BROWSER_PROVIDER
    process.env.DSH_BROWSER_PROVIDER = 'edge'
    try {
      const { browser } = await mount()
      browser.registerProvider(makeProvider('chrome', available))
      browser.registerProvider(makeProvider('edge', available, {
        listTabs: () => Promise.resolve([tab('from-env')]),
      }))
      await expect(browser.listTabs()).resolves.toEqual([expect.objectContaining({ id: 'from-env' })])
    } finally {
      if (previous === undefined) delete process.env.DSH_BROWSER_PROVIDER
      else process.env.DSH_BROWSER_PROVIDER = previous
    }
  })
})

describe('BrowserRuntime attachments', () => {
  it('attaches a tab for an owner and reuses the same attachment on a second attach', async () => {
    const { browser } = await mount()
    const provider = makeProvider('chrome', available)
    browser.registerProvider(provider)
    const owner = makeAgent('a')
    const first = await browser.attach(owner, BrowserTabId('1'))
    const second = await browser.attach(owner, BrowserTabId('1'))
    expect(first).toBe(second)
    expect(provider.attached).toEqual(['1'])
    expect(browser.listAttachments(owner)).toHaveLength(1)
  })

  it('opens a tab and auto-attaches it', async () => {
    const { browser } = await mount()
    browser.registerProvider(makeProvider('chrome', available))
    const owner = makeAgent('a')
    const result = await browser.openTab(owner, { url: 'https://example.com', group: true })
    expect(result.tab.url).toBe('https://example.com')
    expect(result.tab.grouped).toBe(true)
    expect(browser.listAttachments(owner)[0]?.tabId).toBe(result.tab.id)
  })

  it('forwards CDP only after the owner attaches, and rejects a foreign owner', async () => {
    const { browser } = await mount()
    const provider = makeProvider('chrome', available)
    browser.registerProvider(provider)
    const owner = makeAgent('a')
    const other = makeAgent('b')
    await expect(browser.cdp(owner, { tabId: BrowserTabId('1'), method: 'Page.enable' }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_NOT_ATTACHED' }))
    const attachment = await browser.attach(owner, BrowserTabId('1'))
    await expect(browser.cdp(owner, { tabId: BrowserTabId('1'), method: 'Page.enable' }))
      .resolves.toEqual({ ok: 'Page.enable' })
    await expect(browser.detach(other, attachment))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_FOREIGN_ATTACHMENT' }))
    await expect(browser.detach(owner, BrowserAttachmentId('missing')))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_NOT_ATTACHED' }))
  })

  it('detaches the provider only after the last owner drops the tab', async () => {
    const { browser } = await mount()
    const provider = makeProvider('chrome', available)
    browser.registerProvider(provider)
    const a = makeAgent('a')
    const b = makeAgent('b')
    const first = await browser.attach(a, BrowserTabId('1'))
    const second = await browser.attach(b, BrowserTabId('1'))
    expect(provider.attached).toEqual(['1'])
    await browser.detach(a, first)
    expect(provider.attached).toEqual(['1'])
    await browser.detach(b, second)
    expect(provider.attached).toEqual([])
  })

  it('closes a tab and drops every attachment on it', async () => {
    const { browser } = await mount()
    browser.registerProvider(makeProvider('chrome', available))
    const owner = makeAgent('a')
    await browser.attach(owner, BrowserTabId('1'))
    await browser.closeTab(owner, BrowserTabId('1'))
    expect(browser.listAttachments(owner)).toEqual([])
    await expect(browser.cdp(owner, { tabId: BrowserTabId('1'), method: 'Page.enable' }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_NOT_ATTACHED' }))
  })

  it('forwards provider CDP events to seam listeners', async () => {
    const { browser } = await mount()
    const provider = makeProvider('chrome', available)
    browser.registerProvider(provider)
    const seen: BrowserCdpEvent[] = []
    const stop = browser.onCdpEvent((event) => { seen.push(event) })
    const event: BrowserCdpEvent = { tabId: BrowserTabId('1'), method: 'Page.loadEventFired', params: {} }
    provider.emit(event)
    expect(seen).toEqual([event])
    stop()
    provider.emit(event)
    expect(seen).toHaveLength(1)
  })

  it('clears attachments on service dispose', async () => {
    const { ctx, browser } = await mount()
    browser.registerProvider(makeProvider('chrome', available))
    const owner = makeAgent('a')
    await browser.attach(owner, BrowserTabId('1'))
    await ctx.fiber.dispose()
    expect(browser.listAttachments(owner)).toEqual([])
  })
})

describe('BrowserRuntime facets', () => {
  it('returns an empty capability list when no provider is usable', async () => {
    const { browser } = await mount()
    expect(browser.capabilities()).toEqual([])
  })

  it('returns the selected provider capabilities', async () => {
    const { browser } = await mount()
    browser.registerProvider(makeProvider('chrome', available))
    expect(browser.capabilities()).toEqual(['tabs', 'cdp'])
  })

  it('rethrows a non-BrowserError from capabilities', async () => {
    const { browser } = await mount()
    browser.registerProvider(makeProvider('chrome', available, {
      available: () => {
        throw new Error('boom')
      },
    }))
    expect(() => browser.capabilities()).toThrow('boom')
  })

  it('throws BROWSER_FACET_UNAVAILABLE when an optional facet is missing', async () => {
    const { browser } = await mount()
    browser.registerProvider(makeProvider('chrome', available))
    await expect(browser.historySearch('q')).rejects.toBeInstanceOf(BrowserError)
    await expect(browser.listBookmarks()).rejects.toThrow(expect.objectContaining({ code: 'BROWSER_FACET_UNAVAILABLE' }))
    await expect(browser.createBookmark({ title: 't', url: 'https://example.com' }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_FACET_UNAVAILABLE' }))
    await expect(browser.listReadingList()).rejects.toThrow(expect.objectContaining({ code: 'BROWSER_FACET_UNAVAILABLE' }))
    await expect(browser.addReadingList({ title: 't', url: 'https://example.com' }))
      .rejects.toThrow(expect.objectContaining({ code: 'BROWSER_FACET_UNAVAILABLE' }))
    await expect(browser.listDownloads()).rejects.toThrow(expect.objectContaining({ code: 'BROWSER_FACET_UNAVAILABLE' }))
  })

  it('delegates optional facets when the provider implements them', async () => {
    const { browser } = await mount()
    browser.registerProvider(makeProvider('chrome', available, {
      historySearch: query => Promise.resolve([{ url: query, title: 't', lastVisitTime: 1 }]),
      listBookmarks: () => Promise.resolve([{ id: '1', title: 'b' }]),
      createBookmark: item => Promise.resolve({ id: '2', ...item }),
      listReadingList: () => Promise.resolve([{ url: 'https://r', title: 'r', hasBeenRead: false }]),
      addReadingList: item => Promise.resolve({ ...item, hasBeenRead: false }),
      listDownloads: () => Promise.resolve([{ id: 1, url: 'https://d', filename: 'f', state: 'complete' }]),
    }))
    await expect(browser.historySearch('https://h')).resolves.toEqual([
      { url: 'https://h', title: 't', lastVisitTime: 1 },
    ])
    await expect(browser.listBookmarks()).resolves.toEqual([{ id: '1', title: 'b' }])
    await expect(browser.createBookmark({ title: 'n', url: 'https://n' }))
      .resolves.toEqual({ id: '2', title: 'n', url: 'https://n' })
    await expect(browser.listReadingList()).resolves.toEqual([
      { url: 'https://r', title: 'r', hasBeenRead: false },
    ])
    await expect(browser.addReadingList({ title: 'x', url: 'https://x' }))
      .resolves.toEqual({ title: 'x', url: 'https://x', hasBeenRead: false })
    await expect(browser.listDownloads()).resolves.toEqual([
      { id: 1, url: 'https://d', filename: 'f', state: 'complete' },
    ])
  })
})
