import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  boundChars,
  boundUtf8,
  createConsoleCapture,
  createKeyedSerialQueue,
  createSerialQueue,
  isImageCapableRoute,
  isOrdinaryLeftClick,
  modifierMask,
  shortcutModifier,
  textContinuationId,
  waitForActionable,
} from '@deepseek-ai/dsh-tool-browser'
import type { CdpClient } from '@deepseek-ai/dsh-tool-browser'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'

describe('browser helpers', () => {
  it('serializes keyed queues after a rejected task', async () => {
    const order: number[] = []
    const queue = createSerialQueue()
    const keyed = createKeyedSerialQueue()
    await Promise.all([
      queue.run(async () => { order.push(1); await Promise.resolve(); order.push(2) }),
      queue.run(async () => { order.push(3) }),
    ])
    expect(order).toEqual([1, 2, 3])
    await expect(queue.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    await expect(queue.run(async () => 'ok')).resolves.toBe('ok')
    const left = keyed.run('a', async () => 'a')
    const right = keyed.run('b', async () => 'b')
    expect(await Promise.all([left, right])).toEqual(['a', 'b'])
    expect(await keyed.run('a', async () => 'again')).toBe('again')
  })

  it('bounds UTF-8 and Unicode fields without splitting characters', () => {
    expect(boundUtf8('hi', 10)).toEqual({ text: 'hi', truncated: false, bytes: 2 })
    expect(boundUtf8('héllo', 2).truncated).toBe(true)
    expect(boundChars('abc', 8)).toEqual({ text: 'abc', truncated: false })
    expect(boundChars('abc', 2)).toEqual({ text: 'ab', truncated: true })
    expect(textContinuationId('tab', 4)).toBe('tab:t4')
  })

  it('captures console messages from attachment onward', () => {
    const consoles = createConsoleCapture({ maxEntries: 2 })
    expect(consoles.isArmed('1')).toBe(false)
    consoles.record({
      tabId: '1',
      method: 'Runtime.consoleAPICalled',
      params: { type: 'log', args: [{ value: 'ignored' }] },
    } as never)
    consoles.arm('1')
    expect(consoles.isArmed('1')).toBe(true)
    consoles.arm('1')
    consoles.record({
      tabId: '1',
      method: 'Runtime.consoleAPICalled',
      params: { type: 'error', args: [{ value: 'boom' }], timestamp: 3 },
    } as never)
    consoles.record({
      tabId: '1',
      method: 'Runtime.consoleAPICalled',
      params: { type: 'log', args: [{ value: 'keep' }] },
    } as never)
    consoles.record({
      tabId: '1',
      method: 'Runtime.consoleAPICalled',
      params: { type: 'warn', args: [{ value: 'newest' }] },
    } as never)
    consoles.record({
      tabId: '1',
      method: 'Page.frameNavigated',
      params: {},
    } as never)
    consoles.record({
      tabId: '1',
      method: 'Runtime.consoleAPICalled',
      params: { args: [{ value: 1 }, { value: true }, { value: null }, { description: 'obj' }, { type: 'symbol' }, 'skip'] },
    } as never)
    consoles.record({
      tabId: '1',
      method: 'Runtime.exceptionThrown',
      params: { exceptionDetails: { text: 'ReferenceError' } },
    } as never)
    consoles.record({
      tabId: '2',
      method: 'Runtime.exceptionThrown',
      params: { exceptionDetails: { exception: { description: 'TypeError' } } },
    } as never)
    expect(consoles.list('1').map(entry => entry.text)).toEqual(['1 true null obj symbol', 'ReferenceError'])
    expect(consoles.list('1', undefined, 1).map(entry => entry.text)).toEqual(['ReferenceError'])
    expect(consoles.list('1', 'error', 1)[0]?.level).toBe('error')
    consoles.arm('level')
    consoles.record({
      tabId: 'level',
      method: 'Runtime.consoleAPICalled',
      params: { type: 'warning', args: [{ value: 'keep-me' }] },
    } as never)
    expect(consoles.list('level', 'warn').map(entry => entry.level)).toEqual(['warning'])
    consoles.clear('1')
    expect(consoles.list('1')).toEqual([])
    consoles.clear('missing')
    consoles.drop('1')
    expect(consoles.list('1')).toEqual([])
  })

  it('folds exceptionThrown without a description into a generic error line', () => {
    const consoles = createConsoleCapture({ maxEntries: 4 })
    consoles.arm('1')
    consoles.record({
      tabId: '1',
      method: 'Runtime.exceptionThrown',
      params: { exceptionDetails: {} },
    } as never)
    consoles.record({
      tabId: '1',
      method: 'Runtime.exceptionThrown',
      params: { exceptionDetails: null },
    } as never)
    consoles.record({
      tabId: '1',
      method: 'Runtime.exceptionThrown',
      params: { exceptionDetails: { exception: { description: 'TypeError' } } },
    } as never)
    expect(consoles.list('1').map(entry => entry.text)).toEqual(['exception', 'exception', 'TypeError'])
  })

  it('maps named modifiers and ordinary left clicks', () => {
    expect(modifierMask()).toBe(0)
    expect(modifierMask(['alt', 'shift'])).toBe(9)
    expect(modifierMask(['control', 'cmd'])).toBe(6)
    expect(() => modifierMask(['super'])).toThrow(/unknown modifier/)
    expect(shortcutModifier('darwin')).toBe(4)
    expect(shortcutModifier('linux')).toBe(2)
    expect(shortcutModifier('win32')).toBe(2)
    expect(isOrdinaryLeftClick()).toBe(true)
    expect(isOrdinaryLeftClick('left', 1, [])).toBe(true)
    expect(isOrdinaryLeftClick('right')).toBe(false)
    expect(isOrdinaryLeftClick('left', 2)).toBe(false)
    expect(isOrdinaryLeftClick('left', 1, ['shift'])).toBe(false)
  })

  it('fails closed when a target is not actionable before the deadline', async () => {
    const cdp: CdpClient = { send: async () => ({}) }
    await expect(waitForActionable(cdp, 1, 'click', Date.now() - 1)).rejects.toThrow(/not actionable/)
  })

  it('returns geometry once two inspects agree', async () => {
    const cdp: CdpClient = {
      send: async (method) => {
        if (method === 'DOM.resolveNode') return { object: { objectId: 'o' } }
        if (method === 'DOM.getBoxModel') return { model: { content: [3, 4, 5, 4, 5, 6, 3, 6] } }
        if (method === 'DOM.getNodeForLocation') return { backendNodeId: 1 }
        if (method === 'Runtime.callFunctionOn') return { result: { value: { ok: true, x: 4, y: 5 } } }
        return {}
      },
    }
    await expect(waitForActionable(cdp, 1, 'click', Date.now() + 1_000)).resolves.toEqual({ x: 4, y: 5, width: 0, height: 0 })
  })

  it('retries detached, obstructed, unstable, and throwing inspects until the deadline', async () => {
    const obstructed: CdpClient = {
      send: async (method) => {
        if (method === 'DOM.scrollIntoViewIfNeeded') throw new Error('gone')
        return {}
      },
    }
    await expect(waitForActionable(obstructed, 1, 'click', Date.now() + 200)).rejects.toThrow(/detached/)

    const notReady: CdpClient = {
      send: async (method) => {
        if (method === 'DOM.resolveNode') return { object: { objectId: 'o' } }
        if (method === 'DOM.getBoxModel') return { model: { content: [3, 4, 5, 4, 5, 6, 3, 6] } }
        if (method === 'DOM.getNodeForLocation') return { backendNodeId: 1 }
        if (method === 'Runtime.callFunctionOn') return { result: { value: { ok: false, reason: 'obstructed' } } }
        return {}
      },
    }
    await expect(waitForActionable(notReady, 1, 'click', Date.now() + 200)).rejects.toThrow(/obstructed/)

    const detachedNode: CdpClient = {
      send: async (method) => {
        if (method === 'DOM.resolveNode') return { object: {} }
        return {}
      },
    }
    await expect(waitForActionable(detachedNode, 1, 'click', Date.now() + 200)).rejects.toThrow(/detached/)

    const unlabeled: CdpClient = {
      send: async (method) => {
        if (method === 'DOM.resolveNode') return { object: { objectId: 'o' } }
        if (method === 'DOM.getBoxModel') return { model: { content: [3, 4, 5, 4, 5, 6, 3, 6] } }
        if (method === 'DOM.getNodeForLocation') return { backendNodeId: 1 }
        if (method === 'Runtime.callFunctionOn') return { result: { value: { ok: false } } }
        return {}
      },
    }
    await expect(waitForActionable(unlabeled, 1, 'select', Date.now() + 200)).rejects.toThrow(/not ready/)

    const threw: CdpClient = {
      send: async (method) => {
        if (method === 'DOM.resolveNode') return { object: { objectId: 'o' } }
        if (method === 'DOM.getBoxModel') return { model: { content: [3, 4, 5, 4, 5, 6, 3, 6] } }
        if (method === 'DOM.getNodeForLocation') return { backendNodeId: 1 }
        if (method === 'Runtime.callFunctionOn') return { exceptionDetails: {} }
        return {}
      },
    }
    await expect(waitForActionable(threw, 1, 'type', Date.now() + 200)).rejects.toThrow(/evaluate threw/)

    const namedThrow: CdpClient = {
      send: async (method) => {
        if (method === 'DOM.resolveNode') return { object: { objectId: 'o' } }
        if (method === 'DOM.getBoxModel') return { model: { content: [3, 4, 5, 4, 5, 6, 3, 6] } }
        if (method === 'DOM.getNodeForLocation') return { backendNodeId: 1 }
        if (method === 'Runtime.callFunctionOn') return { exceptionDetails: { text: 'TypeError' } }
        return {}
      },
    }
    await expect(waitForActionable(namedThrow, 1, 'fill', Date.now() + 200)).rejects.toThrow(/TypeError/)

    let inspects = 0
    const unstable: CdpClient = {
      send: async (method) => {
        if (method === 'DOM.resolveNode') return { object: { objectId: 'o' } }
        if (method === 'DOM.getBoxModel') return { model: { content: [inspects * 10, 0, inspects * 10 + 2, 0, inspects * 10 + 2, 2, inspects * 10, 2] } }
        if (method === 'DOM.getNodeForLocation') return { backendNodeId: 1 }
        if (method === 'Runtime.callFunctionOn') {
          inspects += 1
          return { result: { value: { ok: true, x: inspects * 10, y: 1, width: 2, height: 2 } } }
        }
        return {}
      },
    }
    await expect(waitForActionable(unstable, 1, 'hover', Date.now() + 200)).rejects.toThrow(/unstable geometry/)

    let second = 0
    const secondFail: CdpClient = {
      send: async (method) => {
        if (method === 'DOM.resolveNode') return { object: { objectId: 'o' } }
        if (method === 'DOM.getBoxModel') return { model: { content: [3, 4, 5, 4, 5, 6, 3, 6] } }
        if (method === 'DOM.getNodeForLocation') return { backendNodeId: 1 }
        if (method === 'Runtime.callFunctionOn') {
          second += 1
          if (second === 1) return { result: { value: { ok: true, x: 1, y: 1, width: 1, height: 1 } } }
          return { result: { value: { ok: false, reason: 'hidden' } } }
        }
        return {}
      },
    }
    await expect(waitForActionable(secondFail, 1, 'drag', Date.now() + 200)).rejects.toThrow(/hidden/)
  })

  it('aborts a readiness pause when the signal fires', async () => {
    const cdp: CdpClient = {
      send: async (method) => {
        if (method === 'DOM.resolveNode') return { object: { objectId: 'o' } }
        if (method === 'DOM.getBoxModel') return { model: { content: [3, 4, 5, 4, 5, 6, 3, 6] } }
        if (method === 'DOM.getNodeForLocation') return { backendNodeId: 1 }
        if (method === 'Runtime.callFunctionOn') return { result: { value: { ok: false, reason: 'hidden' } } }
        return {}
      },
    }
    const signal = AbortSignal.timeout(5)
    await expect(waitForActionable(cdp, 1, 'fill', Date.now() + 5_000, signal)).rejects.toThrow()

    const ac = new AbortController()
    const pending = waitForActionable(cdp, 1, 'hover', Date.now() + 5_000, ac.signal)
    await new Promise(resolve => setTimeout(resolve, 15))
    ac.abort('stop')
    await expect(pending).rejects.toThrow('aborted')
  })

  it('treats unresolved routes as not image-capable and admits image-capable routes', async () => {
    const ctx = new Context()
    const exec = {
      agent: { id: SessionId('a'), session: Session.create(SessionId('a')), options: {} },
      signal: new AbortController().signal,
    } as unknown as ToolExecution
    expect(await isImageCapableRoute(ctx, exec)).toBe(false)
    const missingSession = {
      agent: { id: SessionId('a') },
      signal: new AbortController().signal,
    } as unknown as ToolExecution
    expect(await isImageCapableRoute(ctx, missingSession)).toBe(false)
    const visionCtx = new Context()
    visionCtx.provide('llm', {
      resolveModelInfo: async () => ({ inputModalities: ['image'] }),
    } as never)
    const vision = {
      agent: {
        id: SessionId('a'),
        session: Session.create(SessionId('a')),
        options: { provider: 'deepseek-official', model: 'vision' },
      },
      signal: new AbortController().signal,
    } as unknown as ToolExecution
    expect(await isImageCapableRoute(visionCtx, vision)).toBe(true)
    const textCtx = new Context()
    textCtx.provide('llm', {
      resolveModelInfo: async () => ({ inputModalities: ['text'] }),
    } as never)
    expect(await isImageCapableRoute(textCtx, vision)).toBe(false)
  })
})
