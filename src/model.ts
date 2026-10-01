/**
 * The persisted data model, its normalisation, and the validation rules.
 *
 * Normalisation mirrors the official `@deepseek-ai/dsh-mcp-client` config
 * contract exactly — most importantly, `env`/`headers` are declared there as
 * `{[key: string]: string}`, so numeric/boolean values are coerced here rather
 * than being emitted into YAML where they would fail validation.
 *
 * @module dsh-mcp-hub/model
 */

import { HARD_LIMITS, SERVER_NAME_PATTERN, TRANSPORTS } from './constants'

/** One user-managed MCP server definition. */
export interface ServerEntry {
  /** Stable key for UI round-trips; generated, never user-authored. */
  key: string
  /** Display name. */
  name: string
  /** `serverName` in the official client; drives the `mcp__<name>__` prefix. */
  serverName: string
  /** `stdio` or `streamable-http`. */
  transport: (typeof TRANSPORTS)[number]
  /** Whether the generated row is written on apply. */
  enabled: boolean
  /** streamable-http only. */
  url: string
  /** streamable-http only; values are strings by contract. */
  headers: Record<string, string>
  /** stdio only. */
  command: string
  /** stdio only. */
  args: string[]
  /** stdio only; values are strings by contract. */
  env: Record<string, string>
  /** stdio only. */
  cwd: string
  /** Free-form reminder shown in the list. */
  note: string
  /** When the entry was last changed. */
  updatedAt: number
}

/** The persisted document. */
export interface StoreState {
  version: number
  servers: ServerEntry[]
}

/** One validation failure, keyed by field. */
export interface ServerIssue {
  field: string
  problem: string
}

/** Trim and bound one line of user text. */
export function oneLine(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\r?\n/g, ' ').trim().slice(0, max) : ''
}

/** Clamp a numeric field into `[min, max]`, falling back on garbage. */
export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.min(max, Math.max(min, Math.round(num)))
}

/**
 * Coerce an unknown `key: value` bag into a `{[key: string]: string}` map.
 *
 * Coercing here means the user can type `PORT=8080` and it just works — the
 * value would otherwise reach YAML as a number and fail official validation.
 */
export function toStringMap(value: unknown, maxKeys: number): Record<string, string> {
  const out: Record<string, string> = {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return out
  for (const [key, raw] of Object.entries(value as Record<string, unknown>).slice(0, maxKeys)) {
    const cleanKey = key.trim().slice(0, 128)
    if (cleanKey.length === 0) continue
    out[cleanKey] = raw === null || raw === undefined ? '' : String(raw).slice(0, 4096)
  }
  return out
}

/** Coerce an unknown value onto the known shape, filling gaps from `base`. */
export function normalizeServer(value: unknown, base: ServerEntry | null): ServerEntry {
  const raw = (value ?? {}) as Record<string, unknown>
  const pick = <K extends keyof ServerEntry>(key: K): ServerEntry[K] =>
    key in raw ? (raw[key] as ServerEntry[K]) : base !== null ? base[key] : ('' as unknown as ServerEntry[K])

  const transport = oneLine(pick('transport'), 24)
  const args = Array.isArray(raw.args)
    ? raw.args.map((item) => oneLine(item, 500)).filter((item) => item.length > 0).slice(0, HARD_LIMITS.args)
    : (Array.isArray(base?.args) ? base!.args : [])

  return {
    key: oneLine(pick('key'), 64) || (base?.key ?? ''),
    name: oneLine(pick('name'), 80) || (base?.name ?? ''),
    serverName: (oneLine(pick('serverName'), HARD_LIMITS.serverNameLength) || (base?.serverName ?? '')).replace(
      /[^A-Za-z0-9_-]/g,
      '_',
    ),
    transport: (TRANSPORTS as readonly string[]).includes(transport)
      ? (transport as ServerEntry['transport'])
      : (base?.transport ?? 'stdio'),
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : (base?.enabled ?? false),
    url: oneLine(pick('url'), 500),
    headers: toStringMap(raw.headers, HARD_LIMITS.headerKeys),
    command: oneLine(pick('command'), 500),
    args,
    env: toStringMap(raw.env, HARD_LIMITS.envKeys),
    cwd: oneLine(pick('cwd'), 500),
    note: oneLine(pick('note'), 300),
    updatedAt: Date.now(),
  }
}

/** Validate one server against the official client's own rules. */
export function validateServer(server: ServerEntry, others: ServerEntry[]): ServerIssue[] {
  const issues: ServerIssue[] = []

  if (!SERVER_NAME_PATTERN.test(server.serverName)) {
    issues.push({ field: 'serverName', problem: '只能包含字母、数字、下划线和连字符，长度 1–32。' })
  }
  if (others.some((item) => item.key !== server.key && item.serverName === server.serverName)) {
    issues.push({ field: 'serverName', problem: '已被列表里的另一个服务器占用。' })
  }

  if (server.transport === 'streamable-http') {
    if (!/^https?:\/\//i.test(server.url)) {
      issues.push({ field: 'url', problem: '必须是 http(s) 地址。' })
    }
  } else if (server.command.length === 0) {
    issues.push({ field: 'command', problem: 'stdio 传输需要填写要启动的命令。' })
  }

  return issues.slice(0, 8)
}

/** Validate the whole list, cross-checking names and generated ids. */
export function validateAll(
  servers: ServerEntry[],
  entryIdFor: (server: ServerEntry) => string,
): Record<string, ServerIssue[]> {
  const problems: Record<string, ServerIssue[]> = {}
  for (const server of servers) {
    const issues = validateServer(server, servers)
    try {
      entryIdFor(server)
    } catch (error) {
      issues.push({ field: 'serverName', problem: (error as Error).message })
    }
    if (issues.length > 0) problems[server.key] = issues
  }
  return problems
}
