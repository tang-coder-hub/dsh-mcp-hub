/**
 * Host half of `dsh-mcp-hub` — the generic MCP server management page.
 *
 * Manages a list of MCP servers (stdio or streamable-http) and, on apply,
 * writes one `@deepseek-ai/dsh-mcp-client` insert row per enabled server into
 * the profile's `cordis.patch.yml`. Uses only official components: the client
 * plugin that actually connects is DSH's own.
 *
 * Routes (all under `/api/mcp-hub`):
 *
 * - `GET  /status`   — profile dir, applied state, official-client availability
 * - `GET  /servers`  — the whole list plus the rendered (but not applied) block
 * - `POST /servers`  — upsert / delete / toggle
 * - `POST /apply`    — rewrite the managed block from the current list
 * - `POST /probe`    — start one server and list its tools (best effort)
 *
 * Only Node builtins are imported: a locally linked plugin resolves bare
 * specifiers from its own directory, so `@deepseek-ai/*` (which lives inside
 * the harness bundle) must not appear here.
 *
 * @module dsh-mcp-hub
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** Loader entry id; must match the `insert` row in cordis.patch.yml. */
export const name = 'mcp-hub'
/** The settings page talks to the browser HTTP carrier. */
export const inject = ['webServer']

const ROUTE_PREFIX = '/api/mcp-hub'
const MAX_BODY_BYTES = 512 * 1024
const PROBE_TIMEOUT_MS = 20000

/**
 * Delimiter pair for the block this plugin owns in the profile patch. The whole
 * block is regenerated on every apply, so hand edits inside it are lost — the
 * markers say so explicitly.
 */
const BLOCK_BEGIN = '# >>> mcp-hub (managed by the DSH settings page; edits here are overwritten) >>>'
const BLOCK_END = '# <<< mcp-hub <<<'

/**
 * This plugin's own bundle entry id.
 *
 * MUST be different from every id the managed block generates. Loader entries
 * are addressed by id and the profile patch layer is applied after the bundle
 * layers, so a shared id lets the profile row silently replace the bundle row —
 * the plugin then never activates and its routes 401 while everything else
 * looks healthy. Guarded by {@link ENTRY_ID_PATTERN} and asserted in tests.
 */
const PLUGIN_ENTRY_ID = 'mcp-hub'

/**
 * Namespace prefix for every id this page generates: `mcp-hub__<serverName>`.
 * The double underscore makes a collision with a bundle id structurally
 * impossible, because a serverName cannot contain `__`… actually it can, so
 * {@link assertGeneratedIdSafe} still checks.
 */
const GENERATED_ID_PREFIX = 'mcp-hub__'

/** The official client plugin this page writes rows for. */
const MCP_CLIENT_PACKAGE = '@deepseek-ai/dsh-mcp-client'

/** Mirrors the official client's own validation. */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** Tool naming the official client uses: `mcp__<serverName>__<rawName>`. */
const TOOL_PREFIX = 'mcp__'

const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60000
const HARD_MAX_FILE_BYTES = 10 * 1024 * 1024

/** Valid transports, mirroring the official client's config union. */
const TRANSPORTS = ['stdio', 'streamable-http'] as const

/** A user-managed MCP server definition. */
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
interface StoreState {
  version: number
  servers: ServerEntry[]
}

/** Everything the renderer needs to know about one server. */
export interface ServerIssue {
  field: string
  problem: string
}

/** Resolve the harness home without importing `@deepseek-ai/dsh-home-paths`. */
function resolveHome(): string {
  const fromEnv = process.env.DSH_HOME
  return typeof fromEnv === 'string' && fromEnv.length > 0 ? fromEnv : join(homedir(), '.dsh')
}

/**
 * Find the profile directory whose patch layer this page should edit.
 *
 * `DSH_PROFILE_DIR` is exported to child processes but is **not** reliably set
 * inside the desktop host itself, so falling back to a hard-coded name would
 * silently edit the wrong profile. The desktop app receives its profile
 * directory as a command-line argument, which is authoritative; every other
 * step is a last resort and is surfaced in the UI.
 */
function resolveProfileDir(home: string): { dir: string; source: string } {
  const profilesRoot = join(home, 'profiles')
  const hasPatch = (candidate: string): boolean => {
    try {
      return existsSync(join(candidate, 'cordis.patch.yml'))
    } catch {
      return false
    }
  }

  const fromEnv = process.env.DSH_PROFILE_DIR
  if (typeof fromEnv === 'string' && fromEnv.length > 0 && hasPatch(fromEnv)) {
    return { dir: fromEnv, source: 'DSH_PROFILE_DIR' }
  }

  for (const argument of process.argv) {
    if (typeof argument !== 'string' || argument.length === 0) continue
    let candidate: string
    try {
      candidate = resolve(argument)
    } catch {
      continue
    }
    if (candidate.startsWith(profilesRoot) && hasPatch(candidate)) {
      return { dir: candidate, source: 'argv' }
    }
  }

  const named = process.env.DSH_PROFILE
  if (typeof named === 'string' && named.length > 0) {
    const candidate = join(profilesRoot, named)
    if (hasPatch(candidate)) return { dir: candidate, source: 'DSH_PROFILE' }
  }

  for (const candidate of [join(profilesRoot, 'desktop'), join(profilesRoot, 'web')]) {
    if (hasPatch(candidate)) return { dir: candidate, source: 'default-name' }
  }
  return { dir: join(profilesRoot, 'web'), source: 'fallback' }
}

/** Trim and bound one line of user text. */
function oneLine(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\r?\n/g, ' ').trim().slice(0, max) : ''
}

/** Clamp a numeric field into `[min, max]`, falling back on garbage. */
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.min(max, Math.max(min, Math.round(num)))
}

/**
 * Coerce an unknown `key: value` bag into a `{[key: string]: string}` map.
 *
 * The official client declares both `env` and `headers` as `z.dict(String)`, so
 * a bare `false` or `10485760` fails validation. Coercing here means the user
 * can type `PORT=8080` and it just works.
 */
function toStringMap(value: unknown, maxKeys: number): Record<string, string> {
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
function normalizeServer(value: unknown, base: ServerEntry | null): ServerEntry {
  const raw = (value ?? {}) as Record<string, unknown>
  const pick = <K extends keyof ServerEntry>(key: K): ServerEntry[K] =>
    (key in raw ? (raw[key] as ServerEntry[K]) : (base ? base[key] : ('' as unknown as ServerEntry[K])))

  const transport = oneLine(pick('transport'), 24)
  const args = Array.isArray(raw.args)
    ? raw.args.map((item) => oneLine(item, 500)).filter((item) => item.length > 0).slice(0, 64)
    : (Array.isArray(base?.args) ? base!.args : [])

  return {
    key: oneLine(pick('key'), 64) || (base?.key ?? ''),
    name: oneLine(pick('name'), 80) || (base?.name ?? ''),
    serverName: (oneLine(pick('serverName'), 32) || (base?.serverName ?? '')).replace(/[^A-Za-z0-9_-]/g, '_'),
    transport: (TRANSPORTS as readonly string[]).includes(transport)
      ? (transport as ServerEntry['transport'])
      : (base?.transport ?? 'stdio'),
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : (base?.enabled ?? false),
    url: oneLine(pick('url'), 500),
    headers: toStringMap(raw.headers, 16),
    command: oneLine(pick('command'), 500),
    args,
    env: toStringMap(raw.env, 32),
    cwd: oneLine(pick('cwd'), 500),
    note: oneLine(pick('note'), 300),
    updatedAt: Date.now(),
  }
}

/** Validate one server against the official client's own rules. */
function validateServer(server: ServerEntry, others: ServerEntry[]): ServerIssue[] {
  const issues: ServerIssue[] = []

  if (!SERVER_NAME_PATTERN.test(server.serverName)) {
    issues.push({
      field: 'serverName',
      problem: '只能包含字母、数字、下划线和连字符，长度 1–32。',
    })
  }
  if (others.some((item) => item.key !== server.key && item.serverName === server.serverName)) {
    issues.push({ field: 'serverName', problem: '已被列表里的另一个服务器占用。' })
  }

  if (server.transport === 'streamable-http') {
    if (!/^https?:\/\//i.test(server.url)) {
      issues.push({ field: 'url', problem: '必须是 http(s) 地址。' })
    }
  } else {
    if (server.command.length === 0) {
      issues.push({ field: 'command', problem: 'stdio 传输需要填写要启动的命令。' })
    }
  }

  return issues
}

/** Generated loader id for one server, with a collision guard. */
function entryIdFor(server: ServerEntry): string {
  const id = `${GENERATED_ID_PREFIX}${server.serverName}`
  if (id === PLUGIN_ENTRY_ID) {
    // Structurally impossible given the prefix, but the cost of being wrong is
    // a silently dead plugin, so it is checked rather than assumed.
    throw new Error(`生成的条目 id 与本插件自身的 bundle id 冲突：${id}`)
  }
  return id
}

/** Render a YAML scalar as an explicit **string**. */
function yamlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/** Render one server as an `insert` row for the official client. */
function renderRow(server: ServerEntry): string {
  const lines: string[] = [
    `    - id: ${yamlString(entryIdFor(server))}`,
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

  lines.push(`        toolCallTimeoutMs: 60000`)
  lines.push('        reconnect:')
  lines.push('          enabled: true')
  return lines.join('\n')
}

/** Render the whole managed block: one insert row per enabled server, in list order. */
function renderBlock(servers: ServerEntry[]): string {
  const enabled = servers.filter((server) => server.enabled)
  // Each server is its own `insert` row: the official client is one plugin
  // instance per server, and loader entries are keyed by their own ids.
  //
  // The trailing newline before BLOCK_END is not cosmetic: without it the end
  // marker lands on the same line as the last scalar (`enabled: true# <<< …`),
  // and YAML folds both into one string — which then fails the official
  // client's config validation. Caught by reloading the plugin tree.
  const rows = enabled.map((server) => `- insert:\n${renderRow(server)}`).join('\n')
  const header = `${BLOCK_BEGIN}\n# ${enabled.length} 个已启用的 MCP 服务；此块由 DSH 设置页整体重写。\n`
  const body = rows.length > 0 ? `${rows}\n` : '# （当前没有启用的服务）\n'
  return `${header}${body}${BLOCK_END}\n`
}

/** Remove a previously managed block, if present. */
function stripBlock(text: string): string {
  const start = text.indexOf(BLOCK_BEGIN)
  if (start < 0) return text
  const end = text.indexOf(BLOCK_END, start)
  if (end < 0) return text.slice(0, start)
  return text.slice(0, start) + text.slice(end + BLOCK_END.length)
}

/** Send one JSON response with no caching. */
function send(res: any, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** Read and parse a bounded JSON request body. */
async function readJson(req: any): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buf.length
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大')
    chunks.push(buf)
  }
  if (size === 0) return {}
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('请求体必须是 JSON 对象')
  }
  return parsed as Record<string, unknown>
}

/**
 * Probe one stdio server: start it, run `initialize` + `tools/list`, stop it.
 */
function probeStdio(server: ServerEntry): Promise<Record<string, unknown>> {
  return new Promise((done) => {
    const child = spawn(server.command, server.args, {
      cwd: server.cwd.length > 0 ? server.cwd : undefined,
      env: { ...process.env, ...server.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })

    let buffer = ''
    let stderr = ''
    let settled = false
    const finish = (payload: Record<string, unknown>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      done({ transport: 'stdio', ...payload })
    }
    const timer = setTimeout(
      () => finish({ ok: false, stage: 'timeout', error: `服务在 ${PROBE_TIMEOUT_MS / 1000} 秒内没有应答。`, stderr: stderr.slice(-1200) }),
      PROBE_TIMEOUT_MS,
    )

    child.on('error', (error) => finish({ ok: false, stage: 'spawn', error: String(error) }))
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.stdout?.on('data', (chunk) => {
      buffer += String(chunk)
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf('\n')
        if (line.length === 0) continue
        let message: any
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        if (message.id === 2) {
          const tools = message.result?.tools ?? []
          finish({
            ok: true,
            serverInfo: message.result?.serverInfo ?? null,
            tools: tools.map((tool: any) => ({ name: tool.name, description: tool.description ?? '' })),
            toolPrefix: `${TOOL_PREFIX}${server.serverName}__`,
          })
        }
      }
    })
    child.on('exit', (code) => finish({ ok: false, stage: 'exit', error: `服务在应答前退出了（退出码 ${code}）。`, stderr: stderr.slice(-1200) }))

    const write = (payload: unknown): void => {
      child.stdin?.write(`${JSON.stringify(payload)}\n`)
    }
    write({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'dsh-mcp-hub', version: '1.0.0' },
      },
    })
    write({ jsonrpc: '2.0', method: 'notifications/initialized' })
    write({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  })
}

/**
 * Probe one streamable-http server with an `initialize` handshake.
 *
 * The response may be plain JSON or an SSE stream; both are accepted, and a
 * non-200 is reported with its status code so a bad token is diagnosable.
 */
async function probeHttp(server: ServerEntry): Promise<Record<string, unknown>> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const response = await fetch(server.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...server.headers,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'dsh-mcp-hub', version: '1.0.0' },
        },
      }),
      signal: controller.signal,
    })

    const text = (await response.text()).slice(0, 200000)
    if (!response.ok) {
      return {
        ok: false,
        stage: 'http',
        status: response.status,
        error: `HTTP ${response.status}。${response.status === 401 || response.status === 403 ? '通常是凭证无效或过期。' : ''}`,
        body: text.slice(0, 600),
      }
    }

    // Prefer a `data:` SSE frame, else treat the body as JSON.
    const dataLine = text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .find((line) => line.length > 0)
    const candidate = dataLine ?? text
    let message: any = null
    try {
      message = JSON.parse(candidate)
    } catch {
      message = null
    }

    const serverInfo = message?.result?.serverInfo ?? null
    return {
      ok: response.ok && serverInfo !== null,
      status: response.status,
      serverInfo,
      error: serverInfo === null ? '收到了响应，但没有解析到 MCP 的 initialize 结果。' : undefined,
      body: text.slice(0, 400),
    }
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError'
    return {
      ok: false,
      stage: aborted ? 'timeout' : 'network',
      error: aborted ? `请求在 ${PROBE_TIMEOUT_MS / 1000} 秒内没有完成。` : String(error),
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Register the settings-page routes.
 * @param ctx - the host context (injects `webServer`).
 */
export function apply(ctx: any): void {
  const home = resolveHome()
  const dataDir = join(home, 'mcp-hub')
  const storeFile = join(dataDir, 'servers.json')
  const profile = resolveProfileDir(home)
  const profileDir = profile.dir
  const patchFile = join(profileDir, 'cordis.patch.yml')

  /** Read the persisted list. */
  const load = (): StoreState => {
    try {
      if (!existsSync(storeFile)) return { version: 1, servers: [] }
      const parsed: unknown = JSON.parse(readFileSync(storeFile, 'utf8'))
      const raw = (parsed as Record<string, unknown>)?.servers
      const servers: ServerEntry[] = []
      if (Array.isArray(raw)) {
        for (const item of raw) {
          const base = null
          const normalized = normalizeServer(item, base)
          if (normalized.key.length > 0 && normalized.serverName.length > 0) servers.push(normalized)
        }
      }
      return { version: 1, servers }
    } catch (error) {
      ctx.logger?.warn?.(`mcp-hub: 读取服务列表失败，按空列表继续: ${String(error)}`)
      return { version: 1, servers: [] }
    }
  }

  /** Persist the list atomically. */
  const persist = (state: StoreState): void => {
    mkdirSync(dataDir, { recursive: true })
    const tmp = `${storeFile}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
    renameSync(tmp, storeFile)
  }

  /** Validate the whole list, cross-checking names and generated ids. */
  const validateAll = (servers: ServerEntry[]): Record<string, ServerIssue[]> => {
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

  /** Re-derive the patch text from the current list. */
  const renderPatch = (servers: ServerEntry[]): { next: string; before: string; existed: boolean } => {
    let before = ''
    try {
      before = existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : ''
    } catch (error) {
      throw new Error(`无法读取 profile 配置：${String(error)}`)
    }
    const stripped = stripBlock(before).replace(/\s+$/, '')
    const block = renderBlock(servers.filter((server) => server.enabled))
    return { next: `${stripped}\n\n${block}\n`, before, existed: before.includes(BLOCK_BEGIN) }
  }

  const handleStatus = (res: any): void => {
    const state = load()
    let patchText = ''
    try {
      patchText = existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : ''
    } catch {
      patchText = ''
    }
    const appliedBlock = patchText.includes(BLOCK_BEGIN)

    send(res, 200, {
      ok: true,
      profile: { dir: profileDir, source: profile.source, patchFile },
      block: { applied: appliedBlock, servers: state.servers.filter((s) => s.enabled).length },
      officialClient: { package: MCP_CLIENT_PACKAGE },
      counts: { total: state.servers.length, enabled: state.servers.filter((s) => s.enabled).length },
      problems: validateAll(state.servers),
      dataDir,
      storeFile,
      pluginEntryId: PLUGIN_ENTRY_ID,
      generatedIdPrefix: GENERATED_ID_PREFIX,
    })
  }

  const handleList = (res: any): void => {
    const state = load()
    send(res, 200, {
      ok: true,
      servers: state.servers,
      problems: validateAll(state.servers),
      preview: renderBlock(state.servers.filter((server) => server.enabled)),
      pluginEntryId: PLUGIN_ENTRY_ID,
      generatedIdPrefix: GENERATED_ID_PREFIX,
    })
  }

  const handleMutate = async (req: any, res: any): Promise<void> => {
    const body = await readJson(req)
    const action = typeof body.action === 'string' ? body.action : ''
    const state = load()
    let payload: Record<string, unknown>

    if (action === 'upsert') {
      const incoming = body.server
      const rawKey = incoming !== null && typeof incoming === 'object' ? oneLine((incoming as Record<string, unknown>).key, 64) : ''
      const existing = rawKey.length > 0 ? state.servers.find((item) => item.key === rawKey) : undefined
      const entry = normalizeServer(incoming, existing ?? null)
      if (entry.key.length === 0) entry.key = `srv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

      const others = state.servers.filter((item) => item.key !== entry.key)
      const issues = validateServer(entry, others)
      try {
        entryIdFor(entry)
      } catch (error) {
        issues.push({ field: 'serverName', problem: (error as Error).message })
      }
      if (issues.length > 0) {
        send(res, 400, { ok: false, error: '配置未通过校验。', issues: { [entry.key]: issues } })
        return
      }

      state.servers = existing
        ? state.servers.map((item) => (item.key === entry.key ? entry : item))
        : [...state.servers, entry]
      persist(state)
      payload = { ok: true, servers: state.servers, key: entry.key, problems: validateAll(state.servers) }
    } else if (action === 'delete') {
      const key = oneLine(body.key, 64)
      state.servers = state.servers.filter((item) => item.key !== key)
      persist(state)
      payload = { ok: true, servers: state.servers }
    } else if (action === 'toggle') {
      const key = oneLine(body.key, 64)
      const enabled = body.enabled === true
      const target = state.servers.find((item) => item.key === key)
      if (target === undefined) {
        send(res, 400, { ok: false, error: `没有 key 为 ${key} 的服务。` })
        return
      }
      state.servers = state.servers.map((item) => (item.key === key ? { ...item, enabled } : item))
      persist(state)
      payload = { ok: true, servers: state.servers }
    } else {
      send(res, 400, { ok: false, error: `未知操作 "${action}"` })
      return
    }

    send(res, 200, payload)
  }

  const handleApply = async (req: any, res: any): Promise<void> => {
    const body = await readJson(req)
    const detach = body.enabled === false
    const state = load()

    if (!detach) {
      const problems = validateAll(state.servers)
      if (Object.keys(problems).length > 0) {
        send(res, 400, { ok: false, error: '有服务未通过校验，已阻止写入。', problems })
        return
      }
    }

    try {
      const { next } = detach
        ? { next: stripBlock(readFileSync(patchFile, 'utf8')).replace(/\s+$/, '') + '\n' }
        : renderPatch(state.servers)
      mkdirSync(dirname(patchFile), { recursive: true })
      const tmp = `${patchFile}.${process.pid}.tmp`
      writeFileSync(tmp, next, 'utf8')
      renameSync(tmp, patchFile)
    } catch (error) {
      send(res, 500, { ok: false, error: String(error) })
      return
    }

    const count = detach ? 0 : state.servers.filter((server) => server.enabled).length
    ctx.logger?.info?.(`mcp-hub: ${detach ? '已移除' : `已写入 ${count} 个`} MCP 服务注册块 (${patchFile})`)
    send(res, 200, { ok: true, applied: !detach, servers: count, patchFile, restartRequired: true })
  }

  const handleProbe = async (req: any, res: any): Promise<void> => {
    const body = await readJson(req)
    const key = oneLine(body.key, 64)
    const state = load()
    const target = state.servers.find((item) => item.key === key)
    if (target === undefined) {
      send(res, 400, { ok: false, error: `没有 key 为 ${key} 的服务。` })
      return
    }
    const issues = validateServer(target, state.servers)
    if (issues.length > 0) {
      send(res, 400, { ok: false, error: '该服务配置未通过校验，无法探测。', issues: { [key]: issues } })
      return
    }
    const result = target.transport === 'stdio' ? await probeStdio(target) : await probeHttp(target)
    send(res, 200, { ok: true, result })
  }

  const handler = (req: any, res: any): Promise<void> => {
    const run = async (): Promise<void> => {
      const url = new URL(req.url ?? '/', 'http://x')
      const path = url.pathname
      const method = (req.method ?? 'GET').toUpperCase()
      try {
        if (path === `${ROUTE_PREFIX}/status` && method === 'GET') return handleStatus(res)
        if (path === `${ROUTE_PREFIX}/servers` && method === 'GET') return handleList(res)
        if (path === `${ROUTE_PREFIX}/servers` && method === 'POST') return await handleMutate(req, res)
        if (path === `${ROUTE_PREFIX}/apply` && method === 'POST') return await handleApply(req, res)
        if (path === `${ROUTE_PREFIX}/probe` && method === 'POST') return await handleProbe(req, res)
        send(res, 404, { ok: false, error: 'not found' })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger?.warn?.(`mcp-hub: ${message}`)
        if (!res.headersSent) send(res, 500, { ok: false, error: message })
        else res.end()
      }
    }
    return run()
  }

  try {
    mkdirSync(dataDir, { recursive: true })
  } catch {
    /* a read-only home still works; writes report their own failure */
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler }),
    'mcp-hub: routes',
  )
  ctx.logger?.info?.(`mcp-hub: 通用 MCP 管理页路由就绪 (${storeFile})`)
}
