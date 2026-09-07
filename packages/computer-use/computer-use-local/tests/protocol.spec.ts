import { describe, expect, it } from 'vitest'
import {
  PROTOCOL_VERSION,
  decodeLines,
  encodeLine,
  isRpcRequest,
  isRpcResponse,
  protocolMismatch,
  rpcFailure,
  rpcRequest,
  rpcSuccess,
} from '@deepseek-ai/dsh-computer-use-local'

describe('computer-use-local protocol', () => {
  it('encodes a request line and splits complete JSON-RPC lines', () => {
    const request = rpcRequest(1, 'listApps', { extra: true })
    expect(request.protocolVersion).toBe(PROTOCOL_VERSION)
    const line = encodeLine(request)
    expect(line.endsWith('\n')).toBe(true)
    const first = decodeLines(line.slice(0, 8), '')
    expect(first.messages).toEqual([])
    const second = decodeLines(line.slice(8), first.pending)
    expect(second.messages).toEqual([request])
    expect(second.pending).toBe('')
  })

  it('skips empty lines and round-trips success and failure', () => {
    const success = rpcSuccess(2, { ok: true })
    const failure = rpcFailure(3, 'COMPUTER_UNSUPPORTED', 'nope')
    const decoded = decodeLines(`\n${encodeLine(success)}${encodeLine(failure)}`, '')
    expect(decoded.messages).toEqual([success, failure])
    expect(isRpcRequest(success)).toBe(false)
    expect(isRpcResponse(success)).toBe(true)
    expect(isRpcResponse(failure)).toBe(true)
    expect(isRpcRequest({ jsonrpc: '2.0', id: 1, method: 'x', protocolVersion: 1 })).toBe(true)
    expect(isRpcRequest(null)).toBe(false)
    expect(isRpcRequest('x')).toBe(false)
    expect(isRpcResponse(null)).toBe(false)
    expect(isRpcResponse({ jsonrpc: '2.0', id: 1, method: 'x' })).toBe(false)
  })

  it('rejects a mismatched protocol version', () => {
    const request = rpcRequest(1, 'listApps')
    expect(protocolMismatch(request)).toBeUndefined()
    expect(protocolMismatch({ ...request, protocolVersion: 99 })).toMatch(/does not match/)
  })
})
