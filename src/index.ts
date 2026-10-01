/**
 * Host half of `dsh-mcp-hub` — route assembly only.
 *
 * The logic lives in focused siblings so each concern is testable in isolation:
 *
 * - `constants`  protocol limits and the generated-id namespace
 * - `model`      data shape, normalisation, official-client validation
 * - `render`     managed-block YAML emission
 * - `profile`    profile discovery and atomic patch IO
 * - `probe`      stdio / streamable-http connectivity probes
 *
 * Only Node builtins are imported: a locally linked plugin resolves bare
 * specifiers from its own directory, so `@deepseek-ai/*` (which lives inside
 * the harness bundle) must not appear here.
 *
 * @module dsh-mcp-hub
 */

import { existsSync, readFileSync } from 'node:fs'

import {
  BLOCK_BEGIN,
  BLOCK_END,
  GENERATED_ID_PREFIX,
  MCP_CLIENT_PACKAGE,
  PLUGIN_ENTRY_ID,
  ROUTE_PREFIX,
} from './constants'
import { atomicWrite, readPatch, resolveLocations, stripBlock } from './profile'
import { probe } from './probe'
import { renderBlock } from './render'
import { normalizeServer, oneLine, validateAll } from './model'
import type { ServerEntry } from './model'

export { name } from './identity'
export const inject = ['webServer']

/** The persisted document. */
interface StoreState {
  version: number
  servers: ServerEntry[]
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
    if (size > 512 * 1024) throw new Error('请求体过大')
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
 * Register the settings-page routes.
 * @param ctx - the host context (injects `webServer`).
 */
export function apply(ctx: any): void {
  const { dataDir, storeFile, profileDir, patchFile, profileSource } = resolveLocations()

  /** All validation flows through one id resolver, so the guard is single-sourced. */
  const idFor = (server: ServerEntry): string => {
    const id = `${GENERATED_ID_PREFIX}${server.serverName}`
    if (id === PLUGIN_ENTRY_ID) throw new Error(`生成的条目 id 与本插件自身的 bundle id 冲突：${id}`)
    return id
  }

  const issues = (servers: ServerEntry[]): Record<string, ReturnType<typeof validateOne>> =>
    validateAll(servers, idFor)

  function validateOne(server: ServerEntry) {
    return validateAll([server], idFor)[server.key] ?? []
  }

  const load = (): StoreState => {
    try {
      if (!existsSync(storeFile)) return { version: 1, servers: [] }
      const parsed: unknown = JSON.parse(readFileSync(storeFile, 'utf8'))
      const raw = (parsed as Record<string, unknown>)?.servers
      const servers: ServerEntry[] = []
      if (Array.isArray(raw)) {
        for (const item of raw) {
          const normalized = normalizeServer(item, null)
          if (normalized.key.length > 0 && normalized.serverName.length > 0) servers.push(normalized)
        }
      }
      return { version: 1, servers }
    } catch (error) {
      ctx.logger?.warn?.(`mcp-hub: 读取服务列表失败，按空列表继续: ${String(error)}`)
      return { version: 1, servers: [] }
    }
  }

  const persist = (state: StoreState): void => atomicWrite(storeFile, JSON.stringify(state, null, 2))

  const handleStatus = (res: any): void => {
    const state = load()
    const patchText = readPatch(patchFile)
    send(res, 200, {
      ok: true,
      profile: { dir: profileDir, source: profileSource, patchFile },
      block: { applied: patchText.includes(BLOCK_BEGIN), servers: state.servers.filter((s) => s.enabled).length },
      officialClient: { package: MCP_CLIENT_PACKAGE },
      counts: { total: state.servers.length, enabled: state.servers.filter((s) => s.enabled).length },
      problems: issues(state.servers),
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
      problems: issues(state.servers),
      preview: renderBlock(state.servers, PLUGIN_ENTRY_ID),
      pluginEntryId: PLUGIN_ENTRY_ID,
      generatedIdPrefix: GENERATED_ID_PREFIX,
    })
  }

  const handleMutate = async (req: any, res: any): Promise<void> => {
    const body = await readJson(req)
    const action = typeof body.action === 'string' ? body.action : ''
    const state = load()

    if (action === 'upsert') {
      const incoming = body.server
      const rawKey = incoming !== null && typeof incoming === 'object' ? oneLine(incoming.key, 64) : ''
      const existing = rawKey.length > 0 ? state.servers.find((item) => item.key === rawKey) : undefined
      const entry = normalizeServer(incoming, existing ?? null)
      if (entry.key.length === 0) {
        entry.key = `srv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      }
      const others = state.servers.filter((item) => item.key !== entry.key)
      const entryIssues = issues([entry, ...others])
      if (Object.keys(entryIssues).length > 0) {
        send(res, 400, { ok: false, error: '配置未通过校验。', issues: entryIssues })
        return
      }
      state.servers = existing
        ? state.servers.map((item) => (item.key === entry.key ? entry : item))
        : [...state.servers, entry]
      persist(state)
      send(res, 200, { ok: true, servers: state.servers, key: entry.key, problems: issues(state.servers) })
      return
    }

    if (action === 'delete') {
      const key = oneLine(body.key, 64)
      state.servers = state.servers.filter((item) => item.key !== key)
      persist(state)
      send(res, 200, { ok: true, servers: state.servers })
      return
    }

    if (action === 'toggle') {
      const key = oneLine(body.key, 64)
      const enabled = body.enabled === true
      if (!state.servers.some((item) => item.key === key)) {
        send(res, 400, { ok: false, error: `没有 key 为 ${key} 的服务。` })
        return
      }
      state.servers = state.servers.map((item) => (item.key === key ? { ...item, enabled } : item))
      persist(state)
      send(res, 200, { ok: true, servers: state.servers })
      return
    }

    send(res, 400, { ok: false, error: `未知操作 "${action}"` })
  }

  const handleApply = async (req: any, res: any): Promise<void> => {
    const body = await readJson(req)
    const detach = body.enabled === false
    const state = load()

    if (!detach) {
      const entryIssues = issues(state.servers)
      if (Object.keys(entryIssues).length > 0) {
        send(res, 400, { ok: false, error: '有服务未通过校验，已阻止写入。', problems: entryIssues })
        return
      }
    }

    try {
      const stripped = stripBlock(readPatch(patchFile), BLOCK_BEGIN, BLOCK_END).replace(/\s+$/, '')
      const next = detach ? `${stripped}\n` : `${stripped}\n\n${renderBlock(state.servers, PLUGIN_ENTRY_ID)}\n`
      atomicWrite(patchFile, next)
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
    const targetIssues = issues([target])
    if (Object.keys(targetIssues).length > 0) {
      send(res, 400, { ok: false, error: '该服务配置未通过校验，无法探测。', issues: targetIssues })
      return
    }
    send(res, 200, { ok: true, result: await probe(target) })
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

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler }),
    'mcp-hub: routes',
  )
  ctx.logger?.info?.(`mcp-hub: 通用 MCP 管理页路由就绪 (${storeFile})`)
}
