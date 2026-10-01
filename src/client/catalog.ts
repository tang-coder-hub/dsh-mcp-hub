/**
 * Curated catalog of well-known remote MCP servers.
 *
 * Deliberately small and conservative: every entry here points at a
 * **vendor-published** endpoint, and each is editable before it is applied.
 * A wrong URL is recoverable; an invented one is not, so entries are added
 * only when the vendor documents the endpoint itself.
 *
 * `tokenUrl` is where the user creates a credential in their browser — that is
 * what the 「连接」 button opens. Real OAuth token exchange (PKCE + callback)
 * is a separate, larger piece of work and is not pretended here.
 *
 * @module dsh-mcp-hub/src/client/catalog
 */

import type { ServerEntry } from './api'

/** One curated, vendor-published MCP endpoint. */
export interface CatalogEntry {
  id: string
  name: string
  icon: string
  category: string
  summary: string
  transport: 'streamable-http' | 'stdio'
  url: string
  /** Headers applied on top of the defaults when connecting. */
  headers: Record<string, string>
  /** Where the user creates a credential, opened in their browser. */
  tokenUrl: string
  /** How to describe the credential in the UI. */
  credentialLabel: string
  credentialHelp: string
  /** Extra hint shown under the token field. */
  note: string
}

/** Curated entries, in display order. */
export const CATALOG: CatalogEntry[] = [
  {
    id: 'github',
    name: 'GitHub',
    icon: '🐙',
    category: '开发工具',
    summary: '仓库、Issue、Pull Request、Actions、代码搜索',
    transport: 'streamable-http',
    url: 'https://api.githubcopilot.com/mcp/',
    headers: { Accept: 'application/json, text/event-stream' },
    tokenUrl: 'https://github.com/settings/personal-access-tokens/new',
    credentialLabel: 'GitHub Personal Access Token',
    credentialHelp: 'fine-grained PAT，只勾你真正需要的仓库和权限',
    note: 'Token 越小越安全：只读用途就不要给 write 权限。',
  },
  {
    id: 'notion',
    name: 'Notion',
    icon: '📓',
    category: '办公协作',
    summary: '搜索、读取和创建页面与数据库',
    transport: 'streamable-http',
    url: 'https://mcp.notion.com/mcp',
    headers: { Accept: 'application/json, text/event-stream' },
    tokenUrl: 'https://www.notion.so/profile/integrations',
    credentialLabel: 'Notion Internal Integration Token',
    credentialHelp: '在集成里创建一个内部集成，并把它连接到你要访问的页面',
    note: 'Notion 的集成默认访问不到任何页面，需要在页面里手动把它连上。',
  },
  {
    id: 'linear',
    name: 'Linear',
    icon: '📐',
    category: '办公协作',
    summary: 'Issue、项目、周期与团队协作',
    transport: 'streamable-http',
    url: 'https://mcp.linear.app/sse',
    headers: { Accept: 'application/json, text/event-stream' },
    tokenUrl: 'https://linear.app/settings/api',
    credentialLabel: 'Linear Personal API Key',
    credentialHelp: '在设置 → API 里创建个人 API Key',
    note: '个人 Key 拥有你账号的权限，建议只给自己用。',
  },
  {
    id: 'sentry',
    name: 'Sentry',
    icon: '🛡️',
    category: '开发工具',
    summary: '错误追踪、事件与发布分析',
    transport: 'streamable-http',
    url: 'https://mcp.sentry.dev/mcp',
    headers: { Accept: 'application/json, text/event-stream' },
    tokenUrl: 'https://sentry.io/settings/auth/',
    credentialLabel: 'Sentry Auth Token',
    credentialHelp: '在设置 → Auth Tokens 里创建，scope 只给需要的项目',
    note: '建议用只读 scope 起步。',
  },
]

/** Build a server entry from a catalog row plus the user's credential. */
export function entryFromCatalog(entry: CatalogEntry, credential: string): Partial<ServerEntry> {
  const headers: Record<string, string> = { ...entry.headers }
  if (credential.trim().length > 0) {
    headers.Authorization = `Bearer ${credential.trim()}`
  }
  return {
    key: '',
    name: entry.name,
    serverName: entry.id,
    transport: entry.transport,
    enabled: true,
    url: entry.url,
    headers,
    note: entry.note,
  }
}
