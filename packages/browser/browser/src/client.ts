/** Browser-safe tab identities and chat preview responses. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque provider-issued tab identity. */
export type BrowserTabId = Branded<'BrowserTabId'>

/** A transient chat preview; image bytes are never implicitly sent to the model. */
export interface BrowserPreview {
  readonly tabId: BrowserTabId
  readonly url: string
  readonly title: string
  readonly screenshot: string
  readonly capturedAt: number
  readonly refreshIntervalMs: number
}
