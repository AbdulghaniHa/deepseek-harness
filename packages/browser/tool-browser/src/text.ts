/**
 * UTF-8 byte and character bounds for model-visible browser text.
 * @module @deepseek-ai/dsh-tool-browser/text
 */

/** One bounded string plus whether the original exceeded the cap. */
export interface BoundedText {
  readonly text: string
  readonly truncated: boolean
  readonly bytes: number
}

/**
 * Keep a leading UTF-8 prefix of `text` that fits in `maxBytes`, without
 * splitting a multi-byte character.
 * @param text - complete string.
 * @param maxBytes - retention ceiling in UTF-8 bytes.
 * @returns the retained prefix, the complete byte size, and whether it was cut.
 */
export function boundUtf8(text: string, maxBytes: number): BoundedText {
  const decoded = Buffer.from(text, 'utf8')
  if (decoded.byteLength <= maxBytes) {
    return { text, truncated: false, bytes: decoded.byteLength }
  }
  const retained = new TextDecoder().decode(decoded.subarray(0, maxBytes), { stream: true })
  return { text: retained, truncated: true, bytes: decoded.byteLength }
}

/**
 * Cut a snapshot field to `maxChars` Unicode code points.
 * @param value - field text.
 * @param maxChars - character ceiling.
 * @returns the retained prefix and whether it was cut.
 */
export function boundChars(value: string, maxChars: number): { readonly text: string; readonly truncated: boolean } {
  if ([...value].length <= maxChars) return { text: value, truncated: false }
  return { text: [...value].slice(0, maxChars).join(''), truncated: true }
}

/**
 * Mint a continuation id for retained page text. Invalidated when the owner
 * tab is disposed or the capture is replaced.
 * @param tabId - owning tab.
 * @param sequence - per-tab counter.
 * @returns an opaque continuation id.
 */
export function textContinuationId(tabId: string, sequence: number): string {
  return `${tabId}:t${sequence}`
}
