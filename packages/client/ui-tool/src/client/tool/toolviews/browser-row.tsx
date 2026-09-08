import { useEffect, useState } from 'react'
import type { BrowserPreview, BrowserTabId } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import css from './browser-row.module.css'
import type { Context } from '@deepseek-ai/cordis'
import { IconBrowseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '../../contract/slots.ts'
import { toolRowModel } from '../models/tool-call-model.ts'
import { ToolRow } from '../components/ToolRow.tsx'
import { CONVERSATION_NS as NS } from '../../locale.ts'

type BrowserRowProps = ToolCallViewProps & PropsLocale<'conversation'> & {
  preview: (tabId: BrowserTabId, signal: AbortSignal) => Promise<BrowserPreview>
  reveal: (tabId: BrowserTabId) => Promise<void>
}

const BROWSER_TOOLS = [
  'browser_tabs',
  'browser_open',
  'browser_attach',
  'browser_navigate',
  'browser_snapshot',
  'browser_text',
  'browser_screenshot',
  'browser_click',
  'browser_type',
  'browser_press_key',
  'browser_scroll',
  'browser_select_option',
  'browser_wait_for',
  'browser_evaluate',
  'browser_console',
  'browser_close',
  'browser_hover',
  'browser_handle_dialog',
  'browser_upload',
  'browser_cdp',
  'browser_history_search',
  'browser_bookmarks',
  'browser_reading_list',
  'browser_downloads',
] as const

function browserSummary(block: BrowserRowProps['block'], untitled: string): string | undefined {
  if (!('kind' in block) || block.meta === undefined || typeof block.meta !== 'object' || block.meta === null) {
    return undefined
  }
  const meta = block.meta as { url?: unknown; title?: unknown }
  const title = typeof meta.title === 'string' && meta.title.length > 0 ? meta.title : untitled
  const url = typeof meta.url === 'string' ? meta.url : undefined
  return url !== undefined ? `${title} — ${url}` : title
}

/** Conversation row for browser_* tools: title, URL, and optional screenshot meta. */
export function BrowserRow({ toolName, block, inspect, t, preview, reveal, useSession }: BrowserRowProps) {
  const running = useSession(session => session.running)
  const model = toolRowModel(toolName, block)
  return (
    <>
      <ToolRow
        t={t}
        variant={model.variant}
        toolName={toolName}
        icon={<IconBrowseOutline16 size={14} />}
        title={t('tool.title.browser')}
        summary={browserSummary(block, t('tool.browser.untitled')) ?? model.summary}
        output={model.output}
        errorSummary={model.errorSummary}
        state={model.state}
        inspect={inspect}
      />
      {'kind' in block && !block.isError && toolName !== 'browser_close'
      && <BrowserPreviewCard key={block.callId} meta={block.meta} running={running}
        capturedAt={block.time} t={t} preview={preview} reveal={reveal} />}
    </>
  )
}

/** Persisted capture with opt-in live refresh against the owning attached tab. */
function BrowserPreviewCard({ meta, capturedAt, running, t, preview, reveal }: Pick<BrowserRowProps, 't' | 'preview' | 'reveal'> & {
  meta: unknown
  capturedAt: number
  running: boolean
}) {
  const value = meta !== null && typeof meta === 'object' ? meta as Record<string, unknown> : {}
  const tabId = typeof value.tabId === 'string' ? value.tabId as BrowserTabId : undefined
  const screenshot = typeof value.screenshot === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(value.screenshot)
    ? value.screenshot : undefined
  const [frame, setFrame] = useState<BrowserPreview>()
  const [live, setLive] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [revision, setRevision] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  useEffect(() => {
    if (tabId === undefined || (!live && revision === 0) || (live && !running)) return
    const controller = new AbortController()
    const stopped = () => controller.signal.aborted
    let timer: ReturnType<typeof setTimeout> | undefined
    let interval: number | undefined
    const capture = async () => {
      if (stopped()) return
      if (live && document.visibilityState === 'hidden' && interval !== undefined) {
        timer = setTimeout(() => { void capture() }, interval)
        return
      }
      setBusy(true)
      try {
        const next = await preview(tabId, controller.signal)
        if (stopped()) return
        interval = next.refreshIntervalMs
        setFrame(next)
        setError(undefined)
        if (live) timer = setTimeout(() => { void capture() }, next.refreshIntervalMs)
      } catch {
        if (!stopped()) {
          setError(t('tool.browser.unavailable'))
          setLive(false)
        }
      } finally {
        if (!stopped()) setBusy(false)
      }
    }
    void capture()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [tabId, live, revision, preview, t, running])
  if (tabId === undefined) return null
  const image = frame?.screenshot ?? screenshot
  const at = frame?.capturedAt ?? capturedAt
  const title = frame?.title ?? (typeof value.title === 'string' ? value.title : '')
  const url = frame?.url ?? (typeof value.url === 'string' ? value.url : '')
  return (
    <section className={expanded ? css.expanded : css.preview} aria-label={t('tool.browser.preview')}>
      <div className={css.header}>
        <span className={css.identity} title={url}>{title || t('tool.browser.untitled')}{url && ` — ${url}`}</span>
        <span role="status">{busy ? t('tool.browser.refreshing') : live && running ? t('tool.browser.live') : t('tool.browser.captured')}</span>
      </div>
      {image && <button className={css.imageButton} type="button" onClick={() => { setExpanded(!expanded) }}
        aria-label={t(expanded ? 'tool.browser.collapse' : 'tool.browser.expand')} aria-expanded={expanded}>
        <img className={css.image} src={`data:image/png;base64,${image}`} alt={t('tool.browser.preview')} />
      </button>}
      <time className={css.timestamp} dateTime={new Date(at).toISOString()}>{new Date(at).toLocaleTimeString()}</time>
      {(error !== undefined || (image === undefined && value.previewError !== undefined))
        && <p className={css.failure} role="status">{error ?? t('tool.browser.unavailable')}</p>}
      <div className={css.controls}>
        <button type="button" disabled={busy} onClick={() => { setRevision(revision + 1) }}>{t('tool.browser.refresh')}</button>
        <button type="button" aria-pressed={live} onClick={() => { setRevision(0); setLive(!live) }}>{t(live ? 'tool.browser.pause' : 'tool.browser.live')}</button>
        <button type="button" onClick={() => { void reveal(tabId).catch(() => { setError(t('tool.browser.revealFailed')) }) }}>{t('tool.browser.reveal')}</button>
      </div>
    </section>
  )
}

/** Registers the browser conversation rows. */
export const browserToolview = {
  name: 'browser-toolview',
  inject: ['slots', 'remote', 'remote.browser'],
  apply(ctx: Context): void {
    ctx.slots.inject('tool.call.toolview', function* () {
      for (const key of BROWSER_TOOLS) {
        yield ctx.slots.register({ name: 'tool.call.toolview', key, locale: NS, inject: sessionId => ({
          preview: async (tabId: BrowserTabId, signal: AbortSignal) => {
            const result = await ctx.remote.browser.preview(sessionId, tabId, signal)
            if (!result.ok) throw new Error(result.error.message)
            return result.value
          },
          reveal: async (tabId: BrowserTabId) => {
            const result = await ctx.remote.browser.reveal(sessionId, tabId)
            if (!result.ok) throw new Error(result.error.message)
          },
        }) }, BrowserRow)
      }
    })
  },
}
