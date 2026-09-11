import type { Context } from '@deepseek-ai/cordis'
import { IconBrowseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '../../contract/slots.ts'
import { toolRowModel } from '../models/tool-call-model.ts'
import { ToolRow } from '../components/ToolRow.tsx'
import { CONVERSATION_NS as NS } from '../../locale.ts'

type BrowserRowProps = ToolCallViewProps & PropsLocale<'conversation'>

const BROWSER_TOOLS = [
  'browser_status',
  'browser_tabs',
  'browser_open',
  'browser_attach',
  'browser_frames',
  'browser_navigate',
  'browser_snapshot',
  'browser_text',
  'browser_screenshot',
  'browser_click',
  'browser_type',
  'browser_press_key',
  'browser_scroll',
  'browser_drag',
  'browser_select_option',
  'browser_wait_for',
  'browser_evaluate',
  'browser_console',
  'browser_network',
  'browser_network_body',
  'browser_close',
  'browser_hover',
  'browser_handle_dialog',
  'browser_upload',
  'browser_cdp',
  'browser_history_search',
  'browser_bookmarks',
  'browser_reading_list',
  'browser_downloads',
  'browser_wait_for_download',
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

/** Conversation row for browser_* tools; the live capture lives in the preview dock. */
export function BrowserRow({ toolName, block, inspect, t }: BrowserRowProps) {
  const model = toolRowModel(toolName, block)
  return (
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
  )
}

/** Registers the browser conversation rows. */
export const browserToolview = {
  name: 'browser-toolview',
  inject: ['slots'],
  apply(ctx: Context): void {
    ctx.slots.inject('tool.call.toolview', function* () {
      for (const key of BROWSER_TOOLS) {
        yield ctx.slots.register({ name: 'tool.call.toolview', key, locale: NS }, BrowserRow)
      }
    })
  },
}
