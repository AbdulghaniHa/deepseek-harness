// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { RunningToolCall, ToolResultNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { zh } from '@deepseek-ai/dsh-client-ui-conversation/src/client/locales.ts'
import type { BrowserPreview, BrowserTabId } from '@deepseek-ai/dsh-api-remotes/client'
import { BrowserRow, browserToolview } from '../src/client/tool/toolviews/browser-row.tsx'

afterEach(cleanup)

const t = makeTranslate(zh, commonZh)

const running = (): RunningToolCall => ({
  callId: 'c1', name: 'browser_tabs', argsRaw: '{}',
  turn: 1, step: 1, time: 1_000, subCalls: [],
})

const result = (over?: Partial<ToolResultNode>): ToolResultNode => ({
  kind: 'tool-result', seq: 10, time: 2_000, callId: 'c1',
  call: { name: 'browser_snapshot', argsRaw: '{"tabId":"1"}' },
  callTime: 1_000,
  content: [{ type: 'text', text: 'snapshot' }], isError: false,
  meta: { url: 'https://example.com', title: 'Home' }, subCalls: [], ...over,
})

const rowProps = (
  block: RunningToolCall | ToolResultNode,
  toolName = 'browser_snapshot',
  session = { running: true },
) => ({
  callId: block.callId,
  toolName,
  block,
  openFile: vi.fn(),
  loadImage: vi.fn(() => Promise.reject(new Error('not used'))),
  t,
  useSession: (select: (state: { running: boolean }) => unknown) => select(session),
} as unknown as Parameters<typeof BrowserRow>[0])

describe('BrowserRow', () => {
  it('titles the row Browser and summarizes title plus URL from persisted meta', () => {
    const view = render(<BrowserRow {...rowProps(result())} />)
    expect(view.getByText('浏览器')).toBeTruthy()
    expect(view.getByText('Home — https://example.com')).toBeTruthy()
  })

  it('falls back to untitled copy when the page title is empty', () => {
    const view = render(<BrowserRow {...rowProps(result({ meta: { url: 'https://example.com', title: '' } }))} />)
    expect(view.getByText('无标题页面 — https://example.com')).toBeTruthy()
  })

  it('summarizes a title without a URL', () => {
    const view = render(<BrowserRow {...rowProps(result({ meta: { title: 'Only title' } }))} />)
    expect(view.getByText('Only title')).toBeTruthy()
  })

  it('uses the generic summary when meta is absent, null, or the call is still running', () => {
    expect(render(<BrowserRow {...rowProps(result({ meta: undefined }))} />).container.textContent).toContain('浏览器')
    cleanup()
    expect(render(<BrowserRow {...rowProps(result({ meta: null as unknown as undefined }))} />).container.textContent).toContain('浏览器')
    cleanup()
    expect(render(<BrowserRow {...rowProps(running(), 'browser_tabs')} />).container.textContent).toContain('浏览器')
  })
})

describe('browser toolview registration', () => {
  it('registers BrowserRow under every browser_* key', () => {
    const registered: { key: string; locale: unknown; component: unknown }[] = []
    const ctx = {
      slots: {
        inject: (_name: string, callback: () => Iterable<() => void>) => {
          for (const _dispose of callback()) { /* exhaust transactional setup */ }
          return () => undefined
        },
        register: (options: { name: string; key: string; locale?: string }, component: unknown) => {
          registered.push({ key: options.key, locale: options.locale, component })
          return () => {}
        },
      },
    } as unknown as import('@deepseek-ai/cordis').Context
    browserToolview.apply(ctx)
    expect(registered.map(row => row.key)).toContain('browser_tabs')
    expect(registered.map(row => row.key)).toContain('browser_cdp')
    expect(registered.every(row => row.component === BrowserRow)).toBe(true)
    expect(registered.every(row => row.locale === 'conversation')).toBe(true)
    expect(browserToolview.inject).toEqual(['slots', 'remote', 'remote.browser'])
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
        inject: (_name: string, callback: () => Iterable<() => void>) => {
          for (const _dispose of callback()) { /* exhaust transactional setup */ }
          return () => undefined
        },
        register: (options: { inject?: (sessionId: string) => Face }) => {
          inject = options.inject
          return () => {}
        },
      },
      remote: { browser: { preview, reveal } },
    } as unknown as import('@deepseek-ai/cordis').Context
    browserToolview.apply(ctx)
    const face = inject!('session-1')
    await expect(face.preview('1', new AbortController().signal)).resolves.toEqual({ screenshot: 'X' })
    await expect(face.preview('1', new AbortController().signal)).rejects.toThrow('nope')
    await face.reveal('1')
    await expect(face.reveal('1')).rejects.toThrow('gone')
  })
})


describe('browser preview', () => {
  it('renders persisted image bytes without contacting Chrome, and expands in place', () => {
    const preview = vi.fn()
    const view = render(<BrowserRow {...rowProps(result({ meta: { tabId: '1', screenshot: 'AAAA', capturedAt: 1000 } }))} preview={preview} />)
    expect(view.getByRole('img').getAttribute('src')).toBe('data:image/png;base64,AAAA')
    fireEvent.click(view.getByRole('button', { name: '展开预览' }))
    expect(view.getByRole('button', { name: '缩小预览' }).getAttribute('aria-expanded')).toBe('true')
    expect(preview).not.toHaveBeenCalled()
  })

  it('refreshes the owned tab and reveals it only after clicking Show in Chrome', async () => {
    const preview = vi.fn().mockResolvedValue({ tabId: '1', title: 'Updated', url: 'https://example.com', screenshot: 'BBBB', capturedAt: 2000, refreshIntervalMs: 2000 })
    const reveal = vi.fn().mockResolvedValue(undefined)
    const view = render(<BrowserRow {...rowProps(result({ meta: { tabId: '1', screenshot: 'AAAA' } }))} preview={preview} reveal={reveal} />)
    fireEvent.click(view.getByRole('button', { name: '刷新' }))
    await waitFor(() => { expect(view.getByRole('img').getAttribute('src')).toBe('data:image/png;base64,BBBB') })
    expect(reveal).not.toHaveBeenCalled()
    fireEvent.click(view.getByRole('button', { name: '在 Chrome 中显示' }))
    expect(reveal).toHaveBeenCalledWith('1')
  })

  it('retains the previous frame on disconnect and aborts pending capture on unmount', async () => {
    const preview = vi.fn().mockRejectedValue(new Error('disconnected'))
    const view = render(<BrowserRow {...rowProps(result({ meta: { tabId: '1', screenshot: 'AAAA' } }))} preview={preview} />)
    fireEvent.click(view.getByRole('button', { name: '刷新' }))
    await waitFor(() => { expect(view.getByText('预览不可用。请检查 Chrome 连接和标签页，然后重试。')).toBeTruthy() })
    expect(view.getByRole('img').getAttribute('src')).toBe('data:image/png;base64,AAAA')
    view.unmount()
    expect((preview.mock.calls[0]?.[1] as AbortSignal).aborted).toBe(true)
  })

  it('omits the preview card for browser_close', () => {
    const view = render(<BrowserRow {...rowProps(result({ meta: { tabId: '1', screenshot: 'AAAA' } }), 'browser_close')} preview={vi.fn()} reveal={vi.fn()} />)
    expect(view.queryByRole('img')).toBeNull()
  })

  it('shows persisted preview failure copy when no image was saved', () => {
    const view = render(<BrowserRow {...rowProps(result({ meta: { tabId: '1', previewError: 'fail' } }))} preview={vi.fn()} reveal={vi.fn()} />)
    expect(view.getByText('预览不可用。请检查 Chrome 连接和标签页，然后重试。')).toBeTruthy()
    expect(view.queryByRole('img')).toBeNull()
  })

  it('keeps the refresh control disabled until capture settles', async () => {
    let finish!: (value: BrowserPreview) => void
    const preview = vi.fn(() => new Promise<BrowserPreview>((resolve) => { finish = resolve }))
    const view = render(<BrowserRow {...rowProps(result({ meta: { tabId: '1', screenshot: 'AAAA' } }))} preview={preview} reveal={vi.fn()} />)
    fireEvent.click(view.getByRole('button', { name: '刷新' }))
    await waitFor(() => { expect((view.getByRole('button', { name: '刷新' }) as HTMLButtonElement).disabled).toBe(true) })
    finish({ tabId: '1' as BrowserTabId, title: 'Home', url: 'https://example.com', screenshot: 'BBBB', capturedAt: 2, refreshIntervalMs: 2_000 })
    await waitFor(() => { expect((view.getByRole('button', { name: '刷新' }) as HTMLButtonElement).disabled).toBe(false) })
  })

  it('does not live-refresh after the session stops', async () => {
    const preview = vi.fn()
    const view = render(<BrowserRow {...rowProps(result({ meta: { tabId: '1', screenshot: 'AAAA' } }), 'browser_snapshot', { running: false })}
      preview={preview} reveal={vi.fn()} />)
    fireEvent.click(view.getByRole('button', { name: '实时预览' }))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(preview).not.toHaveBeenCalled()
  })

  it('repeats captures while Live is pressed and skips hidden documents', async () => {
    const preview = vi.fn().mockImplementation(async () => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
      return { tabId: '1', title: 'Home', url: 'https://example.com', screenshot: 'LIVE', capturedAt: 3, refreshIntervalMs: 20 }
    })
    const view = render(<BrowserRow {...rowProps(result({ meta: { tabId: '1', screenshot: 'AAAA' } }))} preview={preview} reveal={vi.fn()} />)
    fireEvent.click(view.getByRole('button', { name: '实时预览' }))
    await waitFor(() => { expect(preview).toHaveBeenCalledTimes(1) })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(preview).toHaveBeenCalledTimes(1)
    fireEvent.click(view.getByRole('button', { name: '暂停预览' }))
    view.unmount()
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
  })

  it('reports a failed Show in Chrome without discarding the image', async () => {
    const reveal = vi.fn().mockRejectedValue(new Error('gone'))
    const view = render(<BrowserRow {...rowProps(result({ meta: { tabId: '1', screenshot: 'AAAA' } }))} preview={vi.fn()} reveal={reveal} />)
    fireEvent.click(view.getByRole('button', { name: '在 Chrome 中显示' }))
    await waitFor(() => { expect(view.getByText('无法显示标签页。它可能已关闭。')).toBeTruthy() })
    expect(view.getByRole('img').getAttribute('src')).toBe('data:image/png;base64,AAAA')
  })
})
