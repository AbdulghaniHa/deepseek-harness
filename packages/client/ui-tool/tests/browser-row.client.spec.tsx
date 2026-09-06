// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { RunningToolCall, ToolResultNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { zh } from '@deepseek-ai/dsh-client-ui-conversation/src/client/locales.ts'
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

const rowProps = (block: RunningToolCall | ToolResultNode, toolName = 'browser_snapshot') => ({
  callId: block.callId,
  toolName,
  block,
  openFile: vi.fn(),
  loadImage: vi.fn(() => Promise.reject(new Error('not used'))),
  t,
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
    expect(browserToolview.inject).toEqual(['slots'])
  })
})
