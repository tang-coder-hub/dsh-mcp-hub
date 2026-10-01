/**
 * Browser half of `dsh-mcp-hub`.
 *
 * Registers one page into `settings.section`: 「MCP 服务器」. Everything else —
 * validation, persistence, the profile patch write and the connectivity probe —
 * lives in the host half behind `/api/mcp-hub/*`.
 *
 * @module dsh-mcp-hub/src/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { McpServersPage } from './SettingsPage'
import { ensureStyles } from './styles'

/** Services this half needs before it can register anything. */
export const inject = ['slots']

/** Guards against a duplicate loader row applying the plugin twice. */
let applied = false

/**
 * Register the Settings page.
 * @param ctx - the client context.
 */
export function apply(ctx: ClientContext): void {
  if (applied) return
  applied = true
  ensureStyles()
  ctx.slots.inject('settings.section', () => {
    try {
      return ctx.slots.register(
        {
          name: 'settings.section',
          id: 'mcp-hub',
          order: 97,
          label: 'MCP 服务器',
        },
        McpServersPage,
      )
    } catch (error) {
      // A duplicate load owns the cell already; the first registration wins.
      if (error instanceof Error && /already|duplicate/i.test(error.message)) return () => {}
      throw error
    }
  })
}
