// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { RunningToolCall, ToolResultNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { zh } from '@deepseek-ai/dsh-client-ui-conversation/src/client/locales.ts'
import { ComputerRow, computerToolview } from '../src/client/tool/toolviews/computer-row.tsx'

afterEach(cleanup)

const t = makeTranslate(zh, commonZh)

const running = (): RunningToolCall => ({
  callId: 'c1', name: 'computer_apps', argsRaw: '{}',
  turn: 1, step: 1, time: 1_000, subCalls: [],
})

const result = (over?: Partial<ToolResultNode>): ToolResultNode => ({
  kind: 'tool-result', seq: 10, time: 2_000, callId: 'c1',
  call: { name: 'computer_snapshot', argsRaw: '{"windowId":"w1"}' },
  callTime: 1_000,
  content: [{ type: 'text', text: 'snapshot' }], isError: false,
  meta: { app: 'Notes', windowTitle: 'Untitled' }, subCalls: [], ...over,
})

const rowProps = (block: RunningToolCall | ToolResultNode, toolName = 'computer_snapshot') => ({
  callId: block.callId,
  toolName,
  block,
  openFile: vi.fn(),
  loadImage: vi.fn(() => Promise.reject(new Error('not used'))),
  t,
} as unknown as Parameters<typeof ComputerRow>[0])

describe('ComputerRow', () => {
  it('titles the row Computer and summarizes window title plus app from persisted meta', () => {
    const view = render(<ComputerRow {...rowProps(result())} />)
    expect(view.getByText('电脑')).toBeTruthy()
    expect(view.getByText('Untitled — Notes')).toBeTruthy()
  })

  it('falls back to untitled copy when the window title is empty', () => {
    const view = render(<ComputerRow {...rowProps(result({ meta: { app: 'Notes', windowTitle: '' } }))} />)
    expect(view.getByText('无标题窗口 — Notes')).toBeTruthy()
  })

  it('summarizes a title without an app', () => {
    const view = render(<ComputerRow {...rowProps(result({ meta: { windowTitle: 'Only title' } }))} />)
    expect(view.getByText('Only title')).toBeTruthy()
  })

  it('uses the generic summary when meta is absent, null, or the call is still running', () => {
    expect(render(<ComputerRow {...rowProps(result({ meta: undefined }))} />).container.textContent).toContain('电脑')
    cleanup()
    expect(render(<ComputerRow {...rowProps(result({ meta: null as unknown as undefined }))} />).container.textContent).toContain('电脑')
    cleanup()
    expect(render(<ComputerRow {...rowProps(running(), 'computer_apps')} />).container.textContent).toContain('电脑')
  })
})

describe('computer toolview registration', () => {
  it('registers ComputerRow under every computer_* key', () => {
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
    computerToolview.apply(ctx)
    expect(registered.map(row => row.key)).toContain('computer_apps')
    expect(registered.map(row => row.key)).toContain('computer_status')
    expect(registered.map(row => row.key)).toContain('computer_observe')
    expect(registered.map(row => row.key)).toContain('computer_action')
    expect(registered.map(row => row.key)).toContain('computer_clipboard')
    expect(registered.map(row => row.key)).toContain('computer_displays')
    expect(registered.map(row => row.key)).toContain('computer_focus_element')
    expect(registered.map(row => row.key)).toContain('computer_set_window_bounds')
    expect(registered.every(row => row.component === ComputerRow)).toBe(true)
    expect(registered.every(row => row.locale === 'conversation')).toBe(true)
    expect(computerToolview.inject).toEqual(['slots'])
  })
})
