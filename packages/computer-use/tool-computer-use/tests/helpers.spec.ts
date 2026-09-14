import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  assertImageCapableRoute,
  createSerialQueue,
  fitPng,
  isImageCapableRoute,
} from '@deepseek-ai/dsh-tool-computer-use'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'

describe('computer-use helpers', () => {
  it('serializes the shared input queue after a rejected task', async () => {
    const order: number[] = []
    const queue = createSerialQueue()
    await Promise.all([
      queue.run(async () => { order.push(1); await Promise.resolve(); order.push(2) }),
      queue.run(async () => { order.push(3) }),
    ])
    expect(order).toEqual([1, 2, 3])
    await expect(queue.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    await expect(queue.run(async () => 'ok')).resolves.toBe('ok')
  })

  it('fits oversized PNGs and leaves invalid bytes unchanged', async () => {
    const source = new Uint8Array(await sharp({
      create: { width: 100, height: 40, channels: 3, background: { r: 255, g: 0, b: 0 } },
    }).png().toBuffer())
    const fitted = await fitPng(source, 50)
    expect(fitted.width).toBe(50)
    expect(fitted.height).toBe(20)
    expect(fitted.scaleX).toBe(0.5)
    const invalid = await fitPng(new Uint8Array([1, 2, 3]), 10)
    expect(invalid.width).toBe(0)
    const small = await fitPng(source, 200)
    expect(small.width).toBe(100)
  })

  it('treats unresolved routes as not image-capable', async () => {
    const ctx = new Context()
    const exec = {
      agent: { id: SessionId('a'), session: Session.create(SessionId('a')), options: {} },
      signal: new AbortController().signal,
    } as unknown as ToolExecution
    expect(await isImageCapableRoute(ctx, exec)).toBe(false)
    await expect(assertImageCapableRoute(ctx, exec)).rejects.toThrow(/could not be resolved/)
    const missingSession = {
      agent: { id: SessionId('a') },
      signal: new AbortController().signal,
    } as unknown as ToolExecution
    expect(await isImageCapableRoute(ctx, missingSession)).toBe(false)
    await expect(assertImageCapableRoute(ctx, missingSession)).rejects.toThrow(/could not be resolved/)
    const textCtx = new Context()
    textCtx.provide('llm', {
      resolveModelInfo: async () => ({ inputModalities: ['text'] }),
    } as never)
    const textOnly = {
      agent: {
        id: SessionId('a'),
        session: Session.create(SessionId('a')),
        options: { provider: 'deepseek-official', model: 'chat' },
      },
      signal: new AbortController().signal,
    } as unknown as ToolExecution
    expect(await isImageCapableRoute(textCtx, textOnly)).toBe(false)
    await expect(assertImageCapableRoute(textCtx, textOnly)).rejects.toThrow(/does not declare image input/)
    const visionCtx = new Context()
    visionCtx.provide('llm', {
      resolveModelInfo: async () => ({ inputModalities: ['image'] }),
    } as never)
    expect(await isImageCapableRoute(visionCtx, textOnly)).toBe(true)
    await expect(assertImageCapableRoute(visionCtx, textOnly)).resolves.toBeUndefined()
  })
})
