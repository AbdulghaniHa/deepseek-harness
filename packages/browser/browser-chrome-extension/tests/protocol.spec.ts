import { describe, expect, it } from 'vitest'
import {
  ChunkAssembler,
  MAX_NATIVE_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  chunkNativePayload,
  decodeFrames,
  encodeFrame,
  isRpcNotification,
  isRpcRequest,
  isRpcResponse,
  protocolMismatch,
  rpcFailure,
  rpcNotify,
  rpcRequest,
  rpcSuccess,
} from '@deepseek-ai/dsh-browser-chrome-extension'

describe('length-prefixed framing', () => {
  it('round-trips one JSON value', () => {
    const frame = encodeFrame({ hello: 'world' })
    expect(decodeFrames(frame)).toEqual({ messages: [{ hello: 'world' }], rest: Buffer.alloc(0) })
  })

  it('returns a leftover incomplete frame', () => {
    const frame = encodeFrame({ a: 1 })
    const partial = frame.subarray(0, 3)
    expect(decodeFrames(partial)).toEqual({ messages: [], rest: partial })
    const headerOnly = frame.subarray(0, 6)
    expect(decodeFrames(headerOnly).messages).toEqual([])
    expect(decodeFrames(headerOnly).rest.length).toBe(6)
    const split = Buffer.concat([frame, frame.subarray(0, 2)])
    const decoded = decodeFrames(split)
    expect(decoded.messages).toEqual([{ a: 1 }])
    expect(decoded.rest.length).toBe(2)
  })

  it('decodes two frames glued together', () => {
    const glued = Buffer.concat([encodeFrame(1), encodeFrame(2)])
    expect(decodeFrames(glued).messages).toEqual([1, 2])
  })
})

describe('native-message chunking', () => {
  it('leaves a small payload unchunked', () => {
    expect(chunkNativePayload({ ok: true })).toEqual([{ ok: true }])
  })

  it('splits an oversized payload and reassembles it', () => {
    const payload = { blob: 'x'.repeat(MAX_NATIVE_MESSAGE_BYTES) }
    const parts = chunkNativePayload(payload)
    expect(parts.length).toBeGreaterThan(1)
    const assembler = new ChunkAssembler()
    let result: unknown
    for (const part of parts) result = assembler.push(part)
    expect(result).toEqual(payload)
  })

  it('returns a non-chunk message unchanged and ignores incomplete chunks', () => {
    const assembler = new ChunkAssembler()
    expect(assembler.push({ ok: true })).toEqual({ ok: true })
    expect(assembler.push('nope')).toBe('nope')
    expect(assembler.push({ chunked: true, id: 'a', index: 0, total: 2, data: '{' })).toBeUndefined()
  })
})

describe('JSON-RPC envelopes', () => {
  it('builds request, success, failure, and notification envelopes', () => {
    const request = rpcRequest(1, 'tabs.list', { q: 1 }, 'client-1')
    expect(request).toMatchObject({ jsonrpc: '2.0', id: 1, method: 'tabs.list', protocolVersion: PROTOCOL_VERSION, clientId: 'client-1' })
    expect(rpcRequest(2, 'ping')).toMatchObject({ method: 'ping', id: 2 })
    expect(rpcSuccess(1, { ok: true })).toEqual({ jsonrpc: '2.0', id: 1, result: { ok: true } })
    expect(rpcFailure(1, -32000, 'nope')).toEqual({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'nope' } })
    expect(rpcNotify('debugger.event', { x: 1 })).toEqual({ jsonrpc: '2.0', method: 'debugger.event', params: { x: 1 } })
    expect(rpcNotify('idle')).toEqual({ jsonrpc: '2.0', method: 'idle' })
  })

  it('detects a protocol version mismatch', () => {
    expect(protocolMismatch(rpcRequest(1, 'ping'))).toBeUndefined()
    expect(protocolMismatch({ ...rpcRequest(1, 'ping'), protocolVersion: 99 }))
      .toContain('does not match host')
  })

  it('narrows request, response, and notification values', () => {
    expect(isRpcRequest(rpcRequest(1, 'ping'))).toBe(true)
    expect(isRpcRequest(null)).toBe(false)
    expect(isRpcRequest({ jsonrpc: '2.0' })).toBe(false)
    expect(isRpcResponse(rpcSuccess(1, true))).toBe(true)
    expect(isRpcResponse(rpcRequest(1, 'ping'))).toBe(false)
    expect(isRpcNotification(rpcNotify('x'))).toBe(true)
    expect(isRpcNotification(rpcRequest(1, 'ping'))).toBe(false)
    expect(isRpcNotification(null)).toBe(false)
    expect(isRpcResponse(null)).toBe(false)
  })
})
