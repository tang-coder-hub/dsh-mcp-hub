/**
 * Browser-side client for the mcp-hub settings routes.
 * @module dsh-mcp-hub/src/client/api
 */

/** One user-managed MCP server (mirrors the host's `ServerEntry`). */
export interface ServerEntry {
  key: string
  name: string
  serverName: string
  transport: 'stdio' | 'streamable-http'
  enabled: boolean
  url: string
  headers: Record<string, string>
  command: string
  args: string[]
  env: Record<string, string>
  cwd: string
  note: string
  updatedAt: number
}

/** A validation failure keyed by server key. */
export type Problems = Record<string, { field: string; problem: string }[]>

/** `GET /api/mcp-hub/status`. */
export interface StatusPayload {
  ok: boolean
  profile: { dir: string; source: string; patchFile: string }
  block: { applied: boolean; servers: number }
  officialClient: { package: string }
  counts: { total: number; enabled: number }
  problems: Problems
  dataDir: string
  storeFile: string
  pluginEntryId: string
  generatedIdPrefix: string
}

/** `GET /api/mcp-hub/servers`. */
export interface ListPayload {
  ok: boolean
  servers: ServerEntry[]
  problems: Problems
  preview: string
  pluginEntryId: string
  generatedIdPrefix: string
}

/** `POST /api/mcp-hub/probe`. */
export interface ProbePayload {
  ok: boolean
  result: {
    ok: boolean
    transport?: string
    stage?: string
    status?: number
    error?: string
    serverInfo?: { name?: string; version?: string } | null
    tools?: { name: string; description: string }[]
    toolPrefix?: string
    body?: string
    stderr?: string
  }
}

const BASE = '/api/mcp-hub'

/** One request against the page's routes, surfacing the host's error text. */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, { headers: { 'content-type': 'application/json' }, ...init })
  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    throw new Error(`设置服务返回了无法解析的响应（HTTP ${response.status}）`)
  }
  const record = (payload ?? {}) as Record<string, unknown>
  if (!response.ok || record.ok === false) {
    const error = new Error(
      typeof record.error === 'string' ? record.error : `请求失败（HTTP ${response.status}）`,
    ) as Error & { issues?: unknown }
    if (record.issues !== undefined) error.issues = record.issues
    throw error
  }
  return payload as T
}

/** Read interpreter-independent state: profile, applied flag, problem list. */
export function fetchStatus(): Promise<StatusPayload> {
  return request<StatusPayload>('/status', { method: 'GET' })
}

/** Read the server list, the problem map and a preview of the managed block. */
export function fetchServers(): Promise<ListPayload> {
  return request<ListPayload>('/servers', { method: 'GET' })
}

/** Create or update one server. */
export function upsertServer(server: Partial<ServerEntry>): Promise<{ ok: boolean; servers: ServerEntry[]; key: string; problems: Problems }> {
  return request('/servers', { method: 'POST', body: JSON.stringify({ action: 'upsert', server }) })
}

/** Delete one server. */
export function deleteServer(key: string): Promise<{ ok: boolean; servers: ServerEntry[] }> {
  return request('/servers', { method: 'POST', body: JSON.stringify({ action: 'delete', key }) })
}

/** Enable or disable one server without deleting it. */
export function toggleServer(key: string, enabled: boolean): Promise<{ ok: boolean; servers: ServerEntry[] }> {
  return request('/servers', { method: 'POST', body: JSON.stringify({ action: 'toggle', key, enabled }) })
}

/** Write (or, with enabled=false, remove) the managed block in the profile. */
export function applyServers(enabled: boolean): Promise<{ ok: boolean; applied: boolean; servers: number; patchFile: string; restartRequired: boolean }> {
  return request('/apply', { method: 'POST', body: JSON.stringify({ enabled }) })
}

/** Start one server and list its tools (best effort). */
export function probeServer(key: string): Promise<ProbePayload> {
  return request<ProbePayload>('/probe', { method: 'POST', body: JSON.stringify({ key }) })
}

/** Parse a `key: value` / `key=value` textarea into a string map. */
export function parsePairText(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const match = /^([^:=]+)[:=](.*)$/.exec(line)
    if (match === null) {
      out[line] = ''
      continue
    }
    out[match[1].trim()] = match[2].trim()
  }
  return out
}

/** Render a string map back into `key: value` lines for editing. */
export function renderPairText(map: Record<string, string>): string {
  return Object.entries(map ?? {})
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n')
}
