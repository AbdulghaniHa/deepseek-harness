/**
 * Length-prefixed JSON framing shared by Chrome native messaging and the
 * local socket. Each frame is a 4-byte little-endian length plus UTF-8 JSON.
 * @module @deepseek-ai/dsh-browser-chrome-extension/protocol/framing
 */

import { FRAME_HEADER_BYTES, MAX_NATIVE_MESSAGE_BYTES } from './constants.ts'

/** One decoded JSON value plus the unconsumed tail of a stream buffer. */
export interface FrameDecodeResult {
  readonly messages: unknown[]
  readonly rest: Buffer
}

/**
 * Encode one JSON value as a length-prefixed frame.
 * @param payload - JSON-serializable value.
 * @returns the framed buffer.
 */
export function encodeFrame(payload: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  const header = Buffer.alloc(FRAME_HEADER_BYTES)
  header.writeUInt32LE(body.length, 0)
  return Buffer.concat([header, body])
}

/**
 * Split a length-prefixed stream into complete JSON messages.
 * @param buffer - accumulated unread bytes.
 * @returns decoded messages and the leftover incomplete frame.
 */
export function decodeFrames(buffer: Buffer): FrameDecodeResult {
  const messages: unknown[] = []
  let offset = 0
  while (offset + FRAME_HEADER_BYTES <= buffer.length) {
    const length = buffer.readUInt32LE(offset)
    const start = offset + FRAME_HEADER_BYTES
    const end = start + length
    if (end > buffer.length) break
    messages.push(JSON.parse(buffer.subarray(start, end).toString('utf8')))
    offset = end
  }
  return { messages, rest: buffer.subarray(offset) }
}

/**
 * Split one JSON value into native-messaging-sized chunks when it exceeds
 * Chrome's 1 MiB host→extension limit. Small payloads return one item.
 * @param payload - JSON-serializable value.
 * @returns one or more framed payloads. A multi-part sequence uses
 *   `{ chunked: true, id, index, total, data }` envelopes.
 */
export function chunkNativePayload(payload: unknown): unknown[] {
  const encoded = JSON.stringify(payload)
  const bytes = Buffer.byteLength(encoded, 'utf8')
  if (bytes <= MAX_NATIVE_MESSAGE_BYTES) return [payload]
  const overhead = 128
  const dataBudget = MAX_NATIVE_MESSAGE_BYTES - overhead
  const total = Math.ceil(encoded.length / dataBudget)
  const id = `chunk-${bytes}-${total}`
  const parts: unknown[] = []
  for (let index = 0; index < total; index++) {
    const data = encoded.slice(index * dataBudget, (index + 1) * dataBudget)
    parts.push({ chunked: true, id, index, total, data })
  }
  return parts
}

/** Accumulator that reassembles {@link chunkNativePayload} envelopes. */
export class ChunkAssembler {
  private readonly parts = new Map<string, { total: number; data: string[] }>()

  /**
   * Feed one decoded message. Complete values are returned; incomplete
   * chunk envelopes return `undefined`.
   * @param message - a raw decoded JSON value.
   * @returns the reassembled payload, the original message, or `undefined`.
   */
  push(message: unknown): unknown | undefined {
    if (!isChunkEnvelope(message)) return message
    const bucket = this.parts.get(message.id) ?? { total: message.total, data: [] }
    bucket.data[message.index] = message.data
    this.parts.set(message.id, bucket)
    if (bucket.data.filter(item => item !== undefined).length < message.total) return undefined
    this.parts.delete(message.id)
    return JSON.parse(bucket.data.join(''))
  }
}

interface ChunkEnvelope {
  readonly chunked: true
  readonly id: string
  readonly index: number
  readonly total: number
  readonly data: string
}

function isChunkEnvelope(value: unknown): value is ChunkEnvelope {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return record.chunked === true
    && typeof record.id === 'string'
    && typeof record.index === 'number'
    && typeof record.total === 'number'
    && typeof record.data === 'string'
}
