/**
 * Rendering of the managed YAML block.
 *
 * Every scalar is emitted through {@link yamlString} — quoted, always. The
 * official client declares `env`/`headers` as `{[key: string]: string}`; a bare
 * `false`, `1` or `10485760` parses as boolean/number and fails validation.
 * This is the exact bug that motivated the quoted-scalar rule.
 *
 * @module dsh-mcp-hub/render
 */

import { BLOCK_BEGIN, BLOCK_END, GENERATED_ID_PREFIX, MCP_CLIENT_PACKAGE } from './constants'
import type { ServerEntry } from './model'

/** Generated loader id for one server, with a collision guard. */
export function entryIdFor(server: ServerEntry, pluginEntryId: string): string {
  const id = `${GENERATED_ID_PREFIX}${server.serverName}`
  if (id === pluginEntryId) {
    // Structurally impossible given the prefix, but the cost of being wrong is
    // a silently dead plugin, so it is checked rather than assumed.
    throw new Error(`生成的条目 id 与本插件自身的 bundle id 冲突：${id}`)
  }
  return id
}

/** Render a YAML scalar as an explicit **string**. */
export function yamlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/** Render one server as an `insert` row for the official client. */
export function renderRow(server: ServerEntry, pluginEntryId: string): string {
  const lines: string[] = [
    `    - id: ${yamlString(entryIdFor(server, pluginEntryId))}`,
    `      name: ${yamlString(MCP_CLIENT_PACKAGE)}`,
    '      config:',
    `        transport: ${yamlString(server.transport)}`,
    `        serverName: ${yamlString(server.serverName)}`,
  ]

  if (server.transport === 'streamable-http') {
    lines.push(`        url: ${yamlString(server.url)}`)
    if (Object.keys(server.headers).length > 0) {
      lines.push('        headers:')
      for (const [key, value] of Object.entries(server.headers)) {
        lines.push(`          ${key}: ${yamlString(value)}`)
      }
    }
  } else {
    lines.push(`        command: ${yamlString(server.command)}`)
    if (server.args.length > 0) {
      lines.push('        args:')
      for (const arg of server.args) lines.push(`          - ${yamlString(arg)}`)
    }
    if (Object.keys(server.env).length > 0) {
      lines.push('        env:')
      for (const [key, value] of Object.entries(server.env)) {
        lines.push(`          ${key}: ${yamlString(value)}`)
      }
    }
    if (server.cwd.length > 0) lines.push(`        cwd: ${yamlString(server.cwd)}`)
  }

  lines.push('        toolCallTimeoutMs: 60000')
  lines.push('        reconnect:')
  lines.push('          enabled: true')
  return lines.join('\n')
}

/**
 * Render the whole managed block: one insert row per enabled server, in list
 * order.
 *
 * The trailing newline before BLOCK_END is not cosmetic: without it the end
 * marker lands on the same line as the last scalar (`enabled: true# <<< …`),
 * and YAML folds both into one string — which then fails the official client's
 * config validation.
 */
export function renderBlock(servers: ServerEntry[], pluginEntryId: string): string {
  const enabled = servers.filter((server) => server.enabled)
  const rows = enabled.map((server) => `- insert:\n${renderRow(server, pluginEntryId)}`).join('\n')
  const header = `${BLOCK_BEGIN}\n# ${enabled.length} 个已启用的 MCP 服务；此块由 DSH 设置页整体重写。\n`
  const body = rows.length > 0 ? `${rows}\n` : '# （当前没有启用的服务）\n'
  return `${header}${body}${BLOCK_END}\n`
}

/** Remove a previously managed block, if present. */
export function stripBlock(text: string): string {
  const start = text.indexOf(BLOCK_BEGIN)
  if (start < 0) return text
  const end = text.indexOf(BLOCK_END, start)
  if (end < 0) return text.slice(0, start)
  return text.slice(0, start) + text.slice(end + BLOCK_END.length)
}
