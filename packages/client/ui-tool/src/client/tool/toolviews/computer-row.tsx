import type { Context } from '@deepseek-ai/cordis'
import { IconFullscreenOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '../../contract/slots.ts'
import { toolRowModel } from '../models/tool-call-model.ts'
import { ToolRow } from '../components/ToolRow.tsx'
import { CONVERSATION_NS as NS } from '../../locale.ts'

type ComputerRowProps = ToolCallViewProps & PropsLocale<'conversation'>

const COMPUTER_TOOLS = [
  'computer_status',
  'computer_apps',
  'computer_launch',
  'computer_focus',
  'computer_focus_element',
  'computer_set_window_bounds',
  'computer_displays',
  'computer_observe',
  'computer_snapshot',
  'computer_screenshot',
  'computer_action',
  'computer_click',
  'computer_type',
  'computer_press_key',
  'computer_scroll',
  'computer_drag',
  'computer_mouse_move',
  'computer_wait_for',
  'computer_clipboard',
] as const

function computerSummary(block: ComputerRowProps['block'], untitled: string): string | undefined {
  if (!('kind' in block) || block.meta === undefined || typeof block.meta !== 'object' || block.meta === null) {
    return undefined
  }
  const meta = block.meta as { app?: unknown; windowTitle?: unknown }
  const title = typeof meta.windowTitle === 'string' && meta.windowTitle.length > 0 ? meta.windowTitle : untitled
  const app = typeof meta.app === 'string' ? meta.app : undefined
  return app !== undefined ? `${title} — ${app}` : title
}

/** Conversation row for computer_* tools: app, window title, and generic summary. */
export function ComputerRow({ toolName, block, inspect, t }: ComputerRowProps) {
  const model = toolRowModel(toolName, block)
  return (
    <ToolRow
      t={t}
      variant={model.variant}
      toolName={toolName}
      icon={<IconFullscreenOutline16 size={14} />}
      title={t('tool.title.computer')}
      summary={computerSummary(block, t('tool.computer.untitled')) ?? model.summary}
      output={model.output}
      errorSummary={model.errorSummary}
      state={model.state}
      inspect={inspect}
    />
  )
}

/** Registers the computer conversation rows. */
export const computerToolview = {
  name: 'computer-toolview',
  inject: ['slots'],
  apply(ctx: Context): void {
    ctx.slots.inject('tool.call.toolview', function* () {
      for (const key of COMPUTER_TOOLS) {
        yield ctx.slots.register({ name: 'tool.call.toolview', key, locale: NS }, ComputerRow)
      }
    })
  },
}
