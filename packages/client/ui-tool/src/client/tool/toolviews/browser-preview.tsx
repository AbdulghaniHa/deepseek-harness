// One live preview of the tab the agent is driving, mounted on
// 'conversation.input.dock' so it follows the newest browser call instead of
// repeating a card under every browser_* row.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { BrowserPreview, BrowserTabId } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { Context } from '@deepseek-ai/cordis'
import css from './browser-preview.module.css'
import { CONVERSATION_NS as NS } from '../../locale.ts'

/** Browser tool names that report the tab they acted on. */
const BROWSER_TOOL_PREFIX = 'browser_'

/** Tab the newest browser result names, plus the capture persisted with it. */
export interface BrowserTarget {
  readonly tabId: BrowserTabId
  readonly title: string
  readonly url: string
  readonly screenshot?: string
  readonly previewError?: string
  readonly capturedAt: number
}

/**
 * Newest browser result naming a tab. Results without a tab id (for example a
 * tab list) leave the previous target in place; `browser_close` ends the
 * sequence because the tab it closed no longer exists.
 * @param nodes - loaded transcript nodes, oldest first.
 * @returns the current target, or undefined when the agent has no open tab.
 */
export function latestBrowserTarget(nodes: ChatSnapshot['legacy']['nodes']): BrowserTarget | undefined {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index]
    if (node === undefined || node.kind !== 'tool-result') continue
    const name = node.call?.name
    if (name === undefined || !name.startsWith(BROWSER_TOOL_PREFIX)) continue
    if (name === 'browser_close') return undefined
    const meta = node.meta !== null && typeof node.meta === 'object' ? node.meta as Record<string, unknown> : {}
    const tabId = typeof meta.tabId === 'string' && meta.tabId.length > 0 ? meta.tabId as BrowserTabId : undefined
    if (tabId === undefined) continue
    const screenshot = typeof meta.screenshot === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(meta.screenshot)
      ? meta.screenshot : undefined
    return {
      tabId,
      title: typeof meta.title === 'string' ? meta.title : '',
      url: typeof meta.url === 'string' ? meta.url : '',
      ...screenshot === undefined ? {} : { screenshot },
      ...typeof meta.previewError === 'string' ? { previewError: meta.previewError } : {},
      capturedAt: node.time,
    }
  }
  return undefined
}

/** Session-authorized capture and reveal face of the preview dock. */
export interface BrowserPreviewInjected {
  preview: (tabId: BrowserTabId, signal: AbortSignal) => Promise<BrowserPreview>
  reveal: (tabId: BrowserTabId) => Promise<void>
}

/** Full props of the preview dock. */
export type BrowserPreviewDockProps =
  PropsRuntime<'conversation.input.dock'>
  & PropsLocale<'conversation'>
  & BrowserPreviewInjected

/** Live preview of the newest agent tab; hidden while the Session has none. */
export function BrowserPreviewDock({ t, preview, reveal, useSession, useChat }: BrowserPreviewDockProps) {
  const running = useSession(session => session.running)
  const nodes = useChat(snapshot => snapshot.legacy.nodes)
  const target = useMemo(() => latestBrowserTarget(nodes), [nodes])
  const tabId = target?.tabId
  const [frame, setFrame] = useState<BrowserPreview>()
  const [watch, setWatch] = useState<'auto' | 'on' | 'off'>('auto')
  const [expanded, setExpanded] = useState(false)
  const [revision, setRevision] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [bottom, setBottom] = useState<number>()
  const anchorRef = useRef<HTMLDivElement | null>(null)
  // Auto follows a running Session; on and off are explicit user choices.
  const live = watch === 'on' || (watch === 'auto' && running)
  useLayoutEffect(() => {
    const anchor = anchorRef.current
    if (anchor === null) return
    const measure = () => {
      const top = anchor.getBoundingClientRect().top
      setBottom(Math.min(Math.max(8, window.innerHeight - top + 8), Math.max(8, window.innerHeight - 140)))
    }
    measure()
    window.addEventListener('resize', measure)
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    observer?.observe(anchor.parentElement ?? anchor)
    return () => {
      window.removeEventListener('resize', measure)
      observer?.disconnect()
    }
  }, [tabId])
  useEffect(() => {
    setFrame(undefined)
    setError(undefined)
    setWatch('auto')
  }, [tabId])
  useEffect(() => {
    if (tabId === undefined || (!live && revision === 0)) return
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
          setWatch('off')
        }
      } finally {
        if (!stopped()) setBusy(false)
      }
    }
    void capture()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [tabId, live, revision, preview, t])
  if (target === undefined || tabId === undefined) return null
  const image = frame?.screenshot ?? target.screenshot
  const title = frame?.title ?? target.title
  const url = frame?.url ?? target.url
  const at = frame?.capturedAt ?? target.capturedAt
  return (
    <>
      <div className={css.anchor} ref={anchorRef} />
      <section className={expanded ? `${css.floating} ${css.expanded}` : css.floating}
        style={bottom === undefined ? undefined : { bottom }} aria-label={t('tool.browser.preview')}>
        <div className={css.header}>
          <span className={css.identity} title={url}>{title || t('tool.browser.untitled')}{url && ` — ${url}`}</span>
          <span className={css.status} role="status">{busy ? t('tool.browser.refreshing') : live ? t('tool.browser.live') : t('tool.browser.captured')}</span>
          <time className={css.timestamp} dateTime={new Date(at).toISOString()}>{new Date(at).toLocaleTimeString()}</time>
        </div>
        {image !== undefined
        && <button className={css.imageButton} type="button" onClick={() => { setExpanded(!expanded) }}
          aria-label={t(expanded ? 'tool.browser.collapse' : 'tool.browser.expand')} aria-expanded={expanded}>
          <img className={css.image} src={`data:image/png;base64,${image}`} alt={t('tool.browser.preview')} />
        </button>}
        <div className={css.footer}>
          {(error !== undefined || (image === undefined && target.previewError !== undefined))
          && <p className={css.failure} role="status">{error ?? t('tool.browser.unavailable')}</p>}
          <div className={css.controls}>
            <button type="button" disabled={busy} onClick={() => { setRevision(revision + 1) }}>{t('tool.browser.refresh')}</button>
            <button type="button" aria-pressed={live} onClick={() => { setRevision(0); setWatch(live ? 'off' : 'on') }}>{t(live ? 'tool.browser.pause' : 'tool.browser.live')}</button>
            <button type="button" onClick={() => { void reveal(tabId).catch(() => { setError(t('tool.browser.revealFailed')) }) }}>{t('tool.browser.reveal')}</button>
          </div>
        </div>
      </section>
    </>
  )
}

/** Registers the session-scoped browser preview dock. */
export const browserPreviewDock = {
  name: 'browser-preview-dock',
  inject: ['slots', 'remote', 'remote.browser'],
  apply(ctx: Context): void {
    ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
      name: 'conversation.input.dock', id: 'browser-preview', order: 30, locale: NS,
      inject: sessionId => ({
        preview: async (tabId: BrowserTabId, signal: AbortSignal) => {
          const result = await ctx.remote.browser.preview(sessionId, tabId, signal)
          if (!result.ok) throw new Error(result.error.message)
          return result.value
        },
        reveal: async (tabId: BrowserTabId) => {
          const result = await ctx.remote.browser.reveal(sessionId, tabId)
          if (!result.ok) throw new Error(result.error.message)
        },
      }),
    }, BrowserPreviewDock))
  },
}
