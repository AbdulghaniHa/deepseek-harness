// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { ToolResultNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { zh } from '@deepseek-ai/dsh-client-ui-conversation/src/client/locales.ts'
import type { BrowserPreview } from '@deepseek-ai/dsh-api-remotes/client'
import {
  BrowserPreviewDock, browserPreviewDock, latestBrowserTarget,
} from '../src/client/tool/toolviews/browser-preview.tsx'

afterEach(cleanup)

const t = makeTranslate(zh, commonZh)

const result = (over: Partial<ToolResultNode> = {}): ToolResultNode => ({
  kind: 'tool-result', seq: 10, time: 2_000, callId: 'c1',
  call: { name: 'browser_snapshot', argsRaw: '{"tabId":"1"}' },
  callTime: 1_000,
  content: [{ type: 'text', text: 'snapshot' }], isError: false,
  meta: { tabId: '1', url: 'https://example.com', title: 'Home' }, subCalls: [], ...over,
})

const browserResult = (name: string, meta: unknown, seq: number): ToolResultNode => result({
  seq, callId: `c${seq}`, meta,
  call: { name, argsRaw: '{}' },
})

const frame = (over: Partial<BrowserPreview> = {}): BrowserPreview => ({
  tabId: '1' as BrowserPreview['tabId'], title: 'Updated', url: 'https://example.com',
  screenshot: 'BBBB', capturedAt: 3_000, refreshIntervalMs: 20, ...over,
})

const dockProps = (
  nodes: readonly ToolResultNode[],
  options: {
    running?: boolean
    preview?: (tabId: string, signal: AbortSignal) => Promise<BrowserPreview>
    reveal?: (tabId: string) => Promise<void>
  } = {},
) => ({
  t,
  useSession: (select: (state: { running: boolean }) => unknown) => select({ running: options.running ?? false }),
  useChat: (select: (snapshot: unknown) => unknown) => select({ legacy: { nodes } }),
  preview: options.preview ?? vi.fn(() => Promise.resolve(frame())),
  reveal: options.reveal ?? vi.fn(() => Promise.resolve()),
} as unknown as Parameters<typeof BrowserPreviewDock>[0])

describe('latestBrowserTarget', () => {
  it('returns the newest browser result that names a tab', () => {
    const target = latestBrowserTarget([
      browserResult('browser_open', { tabId: '1', url: 'https://a', title: 'A', screenshot: 'AAAA' }, 1),
      browserResult('browser_click', { tabId: '1', url: 'https://a', title: 'A', screenshot: 'BBBB' }, 2),
    ])
    expect(target).toMatchObject({ tabId: '1', title: 'A', url: 'https://a', screenshot: 'BBBB', capturedAt: 2_000 })
  })

  it('keeps the previous tab across results that name none', () => {
    const target = latestBrowserTarget([
      browserResult('browser_open', { tabId: '1', title: 'A' }, 1),
      browserResult('browser_tabs', { tabs: [] }, 2),
      browserResult('browser_snapshot', { tabId: '', title: 'B' }, 3),
    ])
    expect(target).toMatchObject({ tabId: '1', title: 'A' })
  })

  it('ends the sequence at browser_close and ignores other tools', () => {
    expect(latestBrowserTarget([
      browserResult('browser_open', { tabId: '1', title: 'A' }, 1),
      browserResult('browser_close', { tabId: '1', closed: true }, 2),
    ])).toBeUndefined()
    expect(latestBrowserTarget([
      browserResult('read', { tabId: '1' }, 1),
    ])).toBeUndefined()
    expect(latestBrowserTarget([])).toBeUndefined()
  })

  it('drops malformed captures and keeps the persisted preview error', () => {
    expect(latestBrowserTarget([browserResult('browser_open', { tabId: '1', screenshot: 'not base64!' }, 1)]))
      .not.toHaveProperty('screenshot')
    expect(latestBrowserTarget([browserResult('browser_open', { tabId: '1', previewError: 'fail' }, 1)]))
      .toMatchObject({ previewError: 'fail' })
    expect(latestBrowserTarget([browserResult('browser_open', null, 1)])).toBeUndefined()
  })
})

describe('BrowserPreviewDock', () => {
  it('renders nothing without an agent tab', () => {
    const view = render(<BrowserPreviewDock {...dockProps([])} />)
    expect(view.container.innerHTML).toBe('')
  })

  it('floats above the composer instead of taking chat width', () => {
    const view = render(<BrowserPreviewDock {...dockProps([
      browserResult('browser_snapshot', { tabId: '1', title: 'Home', screenshot: 'AAAA' }, 1),
    ])} />)
    const panel = view.getByLabelText('浏览器预览')
    expect(panel.className).toContain('floating')
    expect(panel.style.bottom).not.toBe('')
    expect(view.container.querySelector('[class*="anchor"]')).toBeTruthy()
  })

  it('shows the persisted capture without contacting Chrome while the Session is idle', () => {
    const preview = vi.fn()
    const view = render(<BrowserPreviewDock {...dockProps([
      browserResult('browser_snapshot', { tabId: '1', url: 'https://example.com', title: 'Home', screenshot: 'AAAA' }, 1),
    ], { preview })} />)
    expect(view.getByRole('img').getAttribute('src')).toBe('data:image/png;base64,AAAA')
    expect(view.getByText('Home — https://example.com')).toBeTruthy()
    expect(view.getByText('已捕获')).toBeTruthy()
    expect(preview).not.toHaveBeenCalled()
  })

  it('follows a running Session and pauses on request', async () => {
    const preview = vi.fn().mockResolvedValue(frame())
    const view = render(<BrowserPreviewDock {...dockProps([
      browserResult('browser_snapshot', { tabId: '1', title: 'Home', screenshot: 'AAAA' }, 1),
    ], { running: true, preview })} />)
    await waitFor(() => { expect(preview).toHaveBeenCalledTimes(1) })
    await waitFor(() => { expect(view.getByText('实时预览')).toBeTruthy() })
    fireEvent.click(view.getByRole('button', { name: '暂停预览' }))
    const calls = preview.mock.calls.length
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(preview.mock.calls.length).toBe(calls)
  })

  it('refreshes once on request and reports the new identity', async () => {
    const preview = vi.fn().mockResolvedValue(frame({ screenshot: 'BBBB' }))
    const view = render(<BrowserPreviewDock {...dockProps([
      browserResult('browser_snapshot', { tabId: '1', title: 'Home', screenshot: 'AAAA' }, 1),
    ], { preview })} />)
    fireEvent.click(view.getByRole('button', { name: '刷新' }))
    await waitFor(() => { expect(view.getByRole('img').getAttribute('src')).toBe('data:image/png;base64,BBBB') })
    expect(view.getByText('Updated — https://example.com')).toBeTruthy()
    expect(preview).toHaveBeenCalledTimes(1)
  })

  it('starts watching an idle Session when Live is pressed', async () => {
    const preview = vi.fn().mockResolvedValue(frame({ screenshot: 'LIVE' }))
    const view = render(<BrowserPreviewDock {...dockProps([
      browserResult('browser_snapshot', { tabId: '1', title: 'Home', screenshot: 'AAAA' }, 1),
    ], { preview })} />)
    fireEvent.click(view.getByRole('button', { name: '实时预览' }))
    await waitFor(() => { expect(preview).toHaveBeenCalledTimes(1) })
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(preview.mock.calls.length).toBeGreaterThan(1)
    view.unmount()
  })

  it('skips rescheduling while the document is hidden', async () => {
    const preview = vi.fn().mockImplementation(async () => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
      return frame({ screenshot: 'LIVE' })
    })
    const view = render(<BrowserPreviewDock {...dockProps([
      browserResult('browser_snapshot', { tabId: '1', title: 'Home', screenshot: 'AAAA' }, 1),
    ], { running: true, preview })} />)
    await waitFor(() => { expect(preview).toHaveBeenCalledTimes(1) })
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(preview).toHaveBeenCalledTimes(1)
    view.unmount()
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
  })

  it('keeps the previous frame and stops following when capture fails', async () => {
    const preview = vi.fn().mockRejectedValue(new Error('disconnected'))
    const view = render(<BrowserPreviewDock {...dockProps([
      browserResult('browser_snapshot', { tabId: '1', title: 'Home', screenshot: 'AAAA' }, 1),
    ], { running: true, preview })} />)
    await waitFor(() => { expect(view.getByText('预览不可用。请检查 Chrome 连接和标签页，然后重试。')).toBeTruthy() })
    expect(view.getByRole('img').getAttribute('src')).toBe('data:image/png;base64,AAAA')
    const calls = preview.mock.calls.length
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(preview.mock.calls.length).toBe(calls)
    view.unmount()
  })

  it('shows the persisted preview error when no capture was saved', () => {
    const view = render(<BrowserPreviewDock {...dockProps([
      browserResult('browser_open', { tabId: '1', title: 'Home', previewError: 'fail' }, 1),
    ])} />)
    expect(view.getByText('预览不可用。请检查 Chrome 连接和标签页，然后重试。')).toBeTruthy()
    expect(view.queryByRole('img')).toBeNull()
  })

  it('expands the capture in place and aborts a pending capture on unmount', async () => {
    const preview = vi.fn((_tabId: string, _signal: AbortSignal) => new Promise<BrowserPreview>(() => {}))
    const view = render(<BrowserPreviewDock {...dockProps([
      browserResult('browser_snapshot', { tabId: '1', title: 'Home', screenshot: 'AAAA' }, 1),
    ], { preview })} />)
    fireEvent.click(view.getByRole('button', { name: '展开预览' }))
    expect(view.getByRole('button', { name: '缩小预览' }).getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(view.getByRole('button', { name: '刷新' }))
    await waitFor(() => { expect((view.getByRole('button', { name: '刷新' }) as HTMLButtonElement).disabled).toBe(true) })
    view.unmount()
    expect((preview.mock.calls[0]?.[1] as AbortSignal).aborted).toBe(true)
  })

  it('reveals the tab and reports a failed reveal without dropping the frame', async () => {
    const reveal = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('gone'))
    const view = render(<BrowserPreviewDock {...dockProps([
      browserResult('browser_snapshot', { tabId: '1', title: 'Home', screenshot: 'AAAA' }, 1),
    ], { reveal })} />)
    fireEvent.click(view.getByRole('button', { name: '在 Chrome 中显示' }))
    await waitFor(() => { expect(reveal).toHaveBeenCalledWith('1') })
    fireEvent.click(view.getByRole('button', { name: '在 Chrome 中显示' }))
    await waitFor(() => { expect(view.getByText('无法显示标签页。它可能已关闭。')).toBeTruthy() })
    expect(view.getByRole('img').getAttribute('src')).toBe('data:image/png;base64,AAAA')
  })

  it('follows a newly opened tab and drops the previous frame', async () => {
    const preview = vi.fn().mockResolvedValue(frame({ tabId: '2' as BrowserPreview['tabId'], screenshot: 'CCCC' }))
    const nodes = [browserResult('browser_snapshot', { tabId: '1', title: 'First', screenshot: 'AAAA' }, 1)]
    const view = render(<BrowserPreviewDock {...dockProps(nodes, { preview })} />)
    expect(view.getByRole('img').getAttribute('src')).toBe('data:image/png;base64,AAAA')
    view.rerender(<BrowserPreviewDock {...dockProps([
      ...nodes,
      browserResult('browser_open', { tabId: '2', title: 'Second', screenshot: 'BBBB' }, 2),
    ], { preview })} />)
    expect(view.getByRole('img').getAttribute('src')).toBe('data:image/png;base64,BBBB')
    fireEvent.click(view.getByRole('button', { name: '刷新' }))
    await waitFor(() => { expect(preview).toHaveBeenCalledWith('2', expect.anything()) })
  })
})

describe('browser preview dock registration', () => {
  it('registers one session dock entry', () => {
    const registered: { name: string; id?: string; order?: number; locale?: string; component: unknown }[] = []
    const ctx = {
      slots: {
        inject: (_name: string, callback: () => () => void) => {
          callback()
          return () => undefined
        },
        register: (options: { name: string; id?: string; order?: number; locale?: string }, component: unknown) => {
          registered.push({ ...options, component })
          return () => {}
        },
      },
    } as unknown as import('@deepseek-ai/cordis').Context
    browserPreviewDock.apply(ctx)
    expect(registered).toEqual([expect.objectContaining({
      name: 'conversation.input.dock', id: 'browser-preview', order: 30, locale: 'conversation',
      component: BrowserPreviewDock,
    })])
    expect(browserPreviewDock.inject).toEqual(['slots', 'remote', 'remote.browser'])
  })

  it('loads a live preview through the session Remote and surfaces Remote failures', async () => {
    type Face = {
      preview: (tabId: string, signal: AbortSignal) => Promise<{ screenshot: string }>
      reveal: (tabId: string) => Promise<void>
    }
    let inject: ((sessionId: string) => Face) | undefined
    const preview = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: { screenshot: 'X' } })
      .mockResolvedValueOnce({ ok: false, error: { message: 'nope' } })
    const reveal = vi.fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, error: { message: 'gone' } })
    const ctx = {
      slots: {
        inject: (_name: string, callback: () => () => void) => {
          callback()
          return () => undefined
        },
        register: (options: { inject?: (sessionId: string) => Face }) => {
          inject = options.inject
          return () => {}
        },
      },
      remote: { browser: { preview, reveal } },
    } as unknown as import('@deepseek-ai/cordis').Context
    browserPreviewDock.apply(ctx)
    const face = inject!('session-1')
    await expect(face.preview('1', new AbortController().signal)).resolves.toEqual({ screenshot: 'X' })
    await expect(face.preview('1', new AbortController().signal)).rejects.toThrow('nope')
    await face.reveal('1')
    await expect(face.reveal('1')).rejects.toThrow('gone')
  })
})
