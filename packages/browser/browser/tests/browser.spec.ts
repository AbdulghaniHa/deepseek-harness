import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import BrowserRuntime, {
  BrowserAttachmentId,
  BrowserDownloadId,
  BrowserError,
  BrowserFrameId,
  BrowserTabId,
  browserConnectionState,
  browserProbeIssue,
  operationsForBrowserCapabilities,
  recoveryForBrowserCode,
  unsupportedOperationsForBrowserCapabilities,
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
    await browser.attach(owner, BrowserTabId('2'))
    await browser.closeTab(owner, BrowserTabId('1'))
    expect(browser.listAttachments(owner).map(item => item.tabId)).toEqual([BrowserTabId('2')])
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
    await expect(browser.getDownload(BrowserDownloadId('1'))).rejects.toThrow(expect.objectContaining({ code: 'BROWSER_FACET_UNAVAILABLE' }))
  })

  it('delegates optional facets when the provider implements them', async () => {
    const { browser } = await mount()
    browser.registerProvider(makeProvider('chrome', available, {
      historySearch: query => Promise.resolve([{ url: query, title: 't', lastVisitTime: 1 }]),
      listBookmarks: () => Promise.resolve([{ id: '1', title: 'b' }]),
      createBookmark: item => Promise.resolve({ id: '2', ...item }),
      listReadingList: () => Promise.resolve([{ url: 'https://r', title: 'r', hasBeenRead: false }]),
      addReadingList: item => Promise.resolve({ ...item, hasBeenRead: false }),
      listDownloads: () => Promise.resolve([{ id: BrowserDownloadId('1'), url: 'https://d', filename: 'f', state: 'complete' }]),
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
      { id: BrowserDownloadId('1'), url: 'https://d', filename: 'f', state: 'complete' },
    ])
    await expect(browser.getDownload(BrowserDownloadId('1'))).resolves.toEqual({
      id: BrowserDownloadId('1'), url: 'https://d', filename: 'f', state: 'complete',
    })
    await expect(browser.getDownload(BrowserDownloadId('missing'))).resolves.toBeUndefined()
  })

  it('delegates getDownload when the provider implements it', async () => {
    const { browser } = await mount()
    browser.registerProvider(makeProvider('chrome', available, {
      listDownloads: () => Promise.resolve([]),
      getDownload: id => Promise.resolve(id === BrowserDownloadId('1')
        ? { id: BrowserDownloadId('1'), url: 'https://d', filename: 'f', state: 'complete' }
        : undefined),
    }))
    await expect(browser.getDownload(BrowserDownloadId('1'))).resolves.toMatchObject({ filename: 'f' })
    await expect(browser.getDownload(BrowserDownloadId('missing'))).resolves.toBeUndefined()
  })
})

describe('chat preview ownership', () => {
  it('captures without bringing Chrome forward and reveals only explicitly', async () => {
    const { browser, ctx } = await mount()
    const owner = makeAgent('preview')
    const revealed: string[] = []
    const provider = makeProvider('chrome', true, {
      cdp: () => Promise.resolve({ data: 'AAAA' }),
      revealTab: async (tabId) => { revealed.push(tabId) },
    })
    browser.registerProvider(provider)
    await browser.attach(owner, BrowserTabId('1'))
    await expect(browser.preview(owner, BrowserTabId('1'))).resolves.toMatchObject({ screenshot: 'AAAA', tabId: '1' })
    expect(revealed).toEqual([])
    await browser.reveal(owner, BrowserTabId('1'))
    expect(revealed).toEqual(['1'])
    await expect(browser.preview(makeAgent('preview'), BrowserTabId('1'))).rejects.toMatchObject({ code: 'BROWSER_NOT_ATTACHED' })
    await expect(browser.reveal(makeAgent('preview'), BrowserTabId('1'))).rejects.toMatchObject({ code: 'BROWSER_NOT_ATTACHED' })
    await ctx.fiber.dispose()
  })

  it('names a freshly opened tab once its URL commits', async () => {
    const { browser, ctx } = await mount()
    const owner = makeAgent('preview')
    const reads = [
      { ...tab('1'), url: '', title: '' },
      { ...tab('1'), url: 'https://example.com/', title: 'Example Domain' },
    ]
    let read = 0
    browser.registerProvider(makeProvider('chrome', true, {
      cdp: () => Promise.resolve({ data: 'AAAA' }),
      listTabs: async () => [reads[Math.min(read++, reads.length - 1)]!],
    }))
    await browser.attach(owner, BrowserTabId('1'))
    await expect(browser.preview(owner, BrowserTabId('1')))
      .resolves.toMatchObject({ url: 'https://example.com/', title: 'Example Domain' })
    await ctx.fiber.dispose()
    let emptyReads = 0
    const { browser: browser2, ctx: ctx2 } = await mount()
    browser2.registerProvider(makeProvider('chrome', true, {
      cdp: () => Promise.resolve({ data: 'AAAA' }),
      listTabs: async () => {
        emptyReads += 1
        return emptyReads === 1 ? [{ ...tab('1'), url: '', title: '' }] : []
      },
    }))
    const owner2 = makeAgent('preview-empty')
    await browser2.attach(owner2, BrowserTabId('1'))
    await expect(browser2.preview(owner2, BrowserTabId('1'))).resolves.toMatchObject({ url: '', title: '' })
    await ctx2.fiber.dispose()
  })

  it('rejects oversized, missing, and malformed captures and closed tabs', async () => {
    const { browser, ctx } = await mount({ previewMaxBytes: 2 })
    const owner = makeAgent('preview')
    let data: unknown = 'AAAA'
    let tabs = [tab('1')]
    browser.registerProvider(makeProvider('chrome', true, {
      cdp: async () => ({ data }), listTabs: async () => tabs,
    }))
    await browser.attach(owner, BrowserTabId('1'))
    await expect(browser.preview(owner, BrowserTabId('1'))).rejects.toMatchObject({ code: 'BROWSER_PREVIEW_TOO_LARGE' })
    data = 'AAA='
    await expect(browser.preview(owner, BrowserTabId('1'))).resolves.toMatchObject({ screenshot: 'AAA=' })
    for (data of ['', undefined, '!!==']) {
      await expect(browser.preview(owner, BrowserTabId('1'))).rejects.toMatchObject({ code: 'BROWSER_PREVIEW_UNAVAILABLE' })
    }
    tabs = []
    await expect(browser.preview(owner, BrowserTabId('1'))).rejects.toMatchObject({ code: 'BROWSER_TAB_GONE' })
    await expect(browser.reveal(owner, BrowserTabId('1'))).rejects.toMatchObject({ code: 'BROWSER_FACET_UNAVAILABLE' })
    await ctx.fiber.dispose()
  })

  it('serializes opens and reuses only the same agent group', async () => {
    const { browser, ctx } = await mount()
    const requests: unknown[] = []
    browser.registerProvider(makeProvider('chrome', true, {
      openTab: async (request) => { requests.push(request); return tab(String(requests.length)) },
    }))
    const owner = makeAgent('one')
    await Promise.all([browser.openTab(owner, { url: 'https://one', group: true }), browser.openTab(owner, { url: 'https://two', group: true })])
    await browser.openTab(makeAgent('two'), { url: 'https://three', group: true })
    expect(requests).toEqual([
      { url: 'https://one', group: true },
      { url: 'https://two', group: true, groupWithTabId: '1' },
      { url: 'https://three', group: true },
    ])
    await ctx.fiber.dispose()
  })

  it('starts a new group after the predecessor tab is closed', async () => {
    const { browser, ctx } = await mount()
    const requests: unknown[] = []
    const tabs = new Map<string, BrowserTab>()
    browser.registerProvider(makeProvider('chrome', true, {
      listTabs: async () => [...tabs.values()],
      openTab: async (request) => {
        requests.push(request)
        const opened = tab(String(requests.length), { url: request.url })
        tabs.set(opened.id, opened)
        return opened
      },
      closeTab: async (tabId) => { tabs.delete(tabId) },
    }))
    const owner = makeAgent('one')
    const first = await browser.openTab(owner, { url: 'https://one', group: true })
    await browser.closeTab(owner, first.tab.id)
    await browser.openTab(owner, { url: 'https://two', group: true })
    expect(requests).toEqual([
      { url: 'https://one', group: true },
      { url: 'https://two', group: true },
    ])
    await ctx.fiber.dispose()
  })

  it('rejects non-positive preview limits at load', async () => {
    await expect(new Context().plugin(BrowserRuntime, { previewMaxBytes: 0 }))
      .rejects.toThrow('previewMaxBytes')
    await expect(new Context().plugin(BrowserRuntime, { previewIntervalMs: 0 }))
      .rejects.toThrow('previewIntervalMs')
  })

  it('serializes captures for one tab and honors abort before and after Chrome returns', async () => {
    const { browser, ctx } = await mount()
    const owner = makeAgent('preview')
    const order: string[] = []
    let release!: () => void
    const hold = new Promise<void>((resolve) => { release = resolve })
    let started!: () => void
    const sawStart = new Promise<void>((resolve) => { started = resolve })
    let blocked: Promise<void> = Promise.resolve()
    let proceed!: () => void
    let entered: (() => void) | undefined
    let n = 0
    browser.registerProvider(makeProvider('chrome', true, {
      cdp: async () => {
        const id = String(++n)
        order.push(`start-${id}`)
        if (id === '1') started()
        entered?.()
        if (id === '1') await hold
        await blocked
        order.push(`end-${id}`)
        return { data: 'AAAA' }
      },
    }))
    await browser.attach(owner, BrowserTabId('1'))
    const early = new AbortController()
    early.abort()
    await expect(browser.preview(owner, BrowserTabId('1'), early.signal)).rejects.toThrow()
    const first = browser.preview(owner, BrowserTabId('1'))
    const second = browser.preview(owner, BrowserTabId('1'))
    await sawStart
    expect(order).toEqual(['start-1'])
    release()
    await Promise.all([first, second])
    expect(order).toEqual(['start-1', 'end-1', 'start-2', 'end-2'])
    blocked = new Promise<void>((resolve) => { proceed = resolve })
    const sawCdp = new Promise<void>((resolve) => { entered = resolve })
    const mid = new AbortController()
    const pending = browser.preview(owner, BrowserTabId('1'), mid.signal)
    await sawCdp
    mid.abort()
    proceed()
    await expect(pending).rejects.toThrow()
    await ctx.fiber.dispose()
  })

  it('applies preview defaults when config omits the fields', async () => {
    const ctx = new Context()
    new BrowserRuntime(ctx)
    await ctx.fiber.dispose()
  })

  it('opens an ungrouped tab and releases the open lock after a failed grouped open', async () => {
    const { browser, ctx } = await mount()
    browser.registerProvider(makeProvider('chrome', true, {
      openTab: async (request) => {
        if (request.url === 'https://fail') throw new Error('nope')
        return tab('plain', { url: request.url, grouped: request.group === true })
      },
    }))
    const owner = makeAgent('one')
    await expect(browser.openTab(owner, { url: 'https://plain' }))
      .resolves.toMatchObject({ tab: { grouped: false } })
    await expect(browser.openTab(owner, { url: 'https://fail', group: true })).rejects.toThrow('nope')
    await expect(browser.openTab(owner, { url: 'https://after', group: true }))
      .resolves.toMatchObject({ tab: { url: 'https://after' } })
    await ctx.fiber.dispose()
  })
})

describe('status', () => {
  it('never throws when no provider is registered', async () => {
    const { browser } = await mount()
    const status = await browser.status()
    expect(status.available).toBe(false)
    expect(status.connection).toBe('unconfigured')
    expect(status.issues[0]?.code).toBe('BROWSER_PROVIDER_UNAVAILABLE')
  })

  it('reports configured-missing without throwing', async () => {
    const { browser } = await mount({ provider: 'missing' })
    browser.registerProvider(makeProvider('chrome', available))
    const status = await browser.status()
    expect(status.available).toBe(false)
    expect(status.issues[0]?.code).toBe('BROWSER_PROVIDER_CONFIGURED_MISSING')
  })

  it('reports live status after a listTabs probe', async () => {
    const { browser } = await mount({ provider: 'chrome' })
    browser.registerProvider(makeProvider('chrome', available))
    const status = await browser.status()
    expect(status.connection).toBe('live')
    expect(status.selectedProvider).toBe('chrome')
    expect(status.configuredProvider).toBe('chrome')
  })

  it('reports probe-failed when listTabs throws', async () => {
    const { browser } = await mount()
    browser.registerProvider(makeProvider('chrome', available, {
      listTabs: () => Promise.reject(new BrowserError('disconnected', 'BROWSER_NOT_CONNECTED')),
    }))
    const status = await browser.status()
    expect(status.connection).toBe('probe-failed')
    expect(status.issues[0]?.code).toBe('BROWSER_NOT_CONNECTED')
  })
})

describe('status helpers', () => {
  it('covers connection labels and recovery copy', () => {
    expect(browserConnectionState(false, false, false)).toBe('unconfigured')
    expect(browserConnectionState(true, false, false)).toBe('configured')
    expect(BrowserFrameId('frame-1')).toBe('frame-1')
    expect(operationsForBrowserCapabilities(['downloads'])).toContain('listDownloads')
    expect(unsupportedOperationsForBrowserCapabilities(['tabs', 'cdp'])).toContain('listDownloads')
    expect(recoveryForBrowserCode('BROWSER_PROVIDER_UNAVAILABLE')).toContain('Mount')
    expect(recoveryForBrowserCode('BROWSER_NOT_CONNECTED')).toContain('native host')
    expect(recoveryForBrowserCode('BROWSER_PROVIDER_CONFIGURED_MISSING')).toContain('not registered')
    expect(recoveryForBrowserCode('BROWSER_PROVIDER_CONFIGURED_MISSING', 'chrome')).toContain('chrome')
    expect(recoveryForBrowserCode('BROWSER_PROVIDER_CONFIGURED_UNAVAILABLE')).toContain('unavailable')
    expect(recoveryForBrowserCode('BROWSER_PROVIDER_CONFIGURED_UNAVAILABLE', 'chrome')).toContain('chrome')
    expect(recoveryForBrowserCode('BROWSER_PROVIDER_AMBIGUOUS')).toContain('Multiple')
    expect(recoveryForBrowserCode('BROWSER_FACET_UNAVAILABLE')).toContain('browser_status')
    expect(recoveryForBrowserCode('BROWSER_FRAME_DETACHED')).toContain('browser_frames')
    expect(recoveryForBrowserCode('BROWSER_STALE_REF')).toContain('stale')
    expect(recoveryForBrowserCode('BROWSER_DOWNLOAD_INTERRUPTED')).toContain('interrupted')
    expect(recoveryForBrowserCode('BROWSER_UNSUPPORTED_DRAG')).toContain('same frame')
    expect(recoveryForBrowserCode('BROWSER_UNKNOWN')).toContain('Inspect')
    expect(browserProbeIssue(new BrowserError('down', 'BROWSER_NOT_CONNECTED')).code).toBe('BROWSER_NOT_CONNECTED')
    expect(browserProbeIssue('bare').message).toBe('bare')
  })
})
