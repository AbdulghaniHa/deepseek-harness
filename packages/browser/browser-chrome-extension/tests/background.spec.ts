import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

/** Execute the shipped service worker with Chrome API observations. */
async function worker() {
  const chrome = {
    runtime: {
      connectNative: () => ({ onMessage: { addListener() {} }, onDisconnect: { addListener() {} } }), onMessage: { addListener() {} } },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {} },
    tabs: {
      create: vi.fn(async () => ({ id: 2, windowId: 1, active: false })),
      get: vi.fn(async () => ({ id: 2, windowId: 1, active: false, groupId: 9 })),
      query: vi.fn(async () => [{ id: 1, windowId: 7, groupId: 9 }]),
      group: vi.fn(async () => 9),
      update: vi.fn(async () => ({ windowId: 7 })),
    },
    tabGroups: { update: vi.fn(async () => ({})) },
    windows: { update: vi.fn(async () => ({})) },
    debugger: {
      onEvent: { addListener() {} },
      onDetach: { addListener() {} },
      attach: vi.fn(async () => {}),
      detach: vi.fn(async () => {}),
      sendCommand: vi.fn(async () => ({})),
    },
    downloads: {
      search: vi.fn(async () => [{ id: 9, url: 'https://d', filename: '/tmp/a.zip', state: 'complete', bytesReceived: 1, totalBytes: 1, exists: true }]),
    },
  }
  const source = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8')
  const dispatch = runInNewContext(`${source}\ndispatch`, { chrome }) as (method: string, params: object) => Promise<unknown>
  return { chrome, dispatch }
}

describe('Chrome background tab operations', () => {
  it('creates inactive tabs and groups them without activating a tab or window', async () => {
    const { chrome, dispatch } = await worker()
    const tab = await dispatch('tabs.create', { url: 'https://example.com', group: true })
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://example.com', active: false })
    expect(chrome.tabs.update).not.toHaveBeenCalled()
    expect(chrome.windows.update).not.toHaveBeenCalled()
    expect(tab).toMatchObject({ id: '2', active: false, grouped: true })
  })

  it('reports an ungrouped tab without reading it back', async () => {
    const { chrome, dispatch } = await worker()
    const tab = await dispatch('tabs.create', { url: 'https://example.com' })
    expect(chrome.tabs.get).not.toHaveBeenCalled()
    expect(tab).toMatchObject({ id: '2', grouped: false })
  })

  it('reuses the task group and its window', async () => {
    const { chrome, dispatch } = await worker()
    await dispatch('tabs.create', { url: 'https://example.com', group: true, groupWithTabId: '1' })
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://example.com', active: false, windowId: 7 })
    expect(chrome.tabs.group).toHaveBeenCalledWith({ tabIds: [2], groupId: 9 })
  })

  it('creates a group when the previous tab is gone', async () => {
    const { chrome, dispatch } = await worker()
    await dispatch('tabs.create', { url: 'https://example.com', group: true, groupWithTabId: 'gone' })
    expect(chrome.tabs.group).toHaveBeenCalledWith({ tabIds: [2] })
  })

  it('activates and focuses only through explicit reveal', async () => {
    const { chrome, dispatch } = await worker()
    await dispatch('tabs.activate', { tabId: '1' })
    expect(chrome.tabs.update).toHaveBeenCalledWith(1, { active: true })
    expect(chrome.windows.update).toHaveBeenCalledWith(7, { focused: true })
  })
})

describe('Chrome debugger sessions and downloads', () => {
  it('auto-attaches flattened child targets and forwards sessionId', async () => {
    const { chrome, dispatch } = await worker()
    await dispatch('debugger.attach', { tabId: '1' })
    expect(chrome.debugger.attach).toHaveBeenCalledWith({ tabId: 1 }, '1.3')
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 1 },
      'Target.setAutoAttach',
      { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
    )
    await dispatch('debugger.sendCommand', { tabId: '1', method: 'Runtime.evaluate', params: { expression: '1' }, sessionId: 'child' })
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 1 },
      'Runtime.evaluate',
      { expression: '1' },
      'child',
    )
    await dispatch('debugger.sendCommand', { tabId: '1', method: 'Runtime.evaluate', targetId: 't1' })
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
      { targetId: 't1' },
      'Runtime.evaluate',
      {},
    )
  })

  it('projects a download by id without reading the file', async () => {
    const { chrome, dispatch } = await worker()
    const listed = await dispatch('downloads.list', {})
    expect(listed).toEqual([{
      id: '9',
      url: 'https://d',
      filename: '/tmp/a.zip',
      state: 'complete',
      bytesReceived: 1,
      totalBytes: 1,
      exists: true,
      error: undefined,
      filePath: '/tmp/a.zip',
    }])
    chrome.downloads.search.mockResolvedValueOnce([{
      id: 9,
      url: 'https://d',
      filename: '/tmp/a.zip',
      state: 'complete',
      bytesReceived: 1,
      totalBytes: 1,
      exists: true,
    }])
    await expect(dispatch('downloads.get', { id: '9' })).resolves.toMatchObject({ id: '9', filePath: '/tmp/a.zip' })
    chrome.downloads.search.mockResolvedValueOnce([])
    await expect(dispatch('downloads.get', { id: '8' })).resolves.toBeNull()
  })
})
