/**
 * Work-log style assistant, browser half: registers the「工作日志」settings
 * section (settings.section list slot), the sidebar-foot guide button
 * (sidebar.footer.action), and the guide modal (shell.overlay). Data rides
 * the host half's `/worklog` JSON RPC route, and the export-directory picker
 * rides the connection's host.pickDirectory API (native OS folder picker).
 * @module @deepseek-ai/dsh-worklog-style/client
 */

import React from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the settings section SlotMap entries live in the settings contract.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the sidebar footer action SlotMap entry lives in the sidebar contract.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: the shell.overlay SlotMap entry lives in the layout contract.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { WorklogSection } from './WorklogSection.tsx'
import { GuideFooterButton, GuideOverlay } from './guide.tsx'

export const name = 'worklog-style-client'
export const inject = ['slots']

interface PickDirectoryApi {
  pickDirectory(request: Record<string, never>): Promise<{
    result: { ok: true; value: { path: string | null } } | { ok: false; error: { message?: string } }
  }>
}

interface ConnectionLike {
  api: { host: PickDirectoryApi }
}

export function apply(ctx: ClientContext): void {
  const connection = ctx.get('connection') as unknown as ConnectionLike | undefined
  const pickDirectory = async (): Promise<string | null> => {
    if (connection === undefined) throw new Error('目录选择器不可用')
    const response = await connection.api.host.pickDirectory({})
    if (!response.result.ok) {
      throw new Error(response.result.error.message ?? '目录选择失败')
    }
    return response.result.value.path
  }

  ctx.slots.inject('settings.section', () => ctx.slots.register(
    { name: 'settings.section', id: 'worklog', order: 30, label: '工作日志' },
    props => React.createElement(WorklogSection, { pickDirectory, ...props }),
  ))

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
    { name: 'sidebar.footer.action', id: 'worklog-guide', order: 100, label: '工作日志指引' },
    props => React.createElement(GuideFooterButton, { wide: (props as { wide?: boolean }).wide === true }),
  ))

  ctx.slots.inject('shell.overlay', () => ctx.slots.register(
    { name: 'shell.overlay', id: 'worklog-guide', order: 100, label: '工作日志指引' },
    () => React.createElement(GuideOverlay),
  ))
}
