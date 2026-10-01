/**
 * Connectivity probes for managed servers.
 *
 * Both probes speak real JSON-RPC: `initialize` followed by `tools/list`.
 * A probe never throws — every outcome, including timeouts and transport
 * failures, is returned as data so the page can render it inline.
 *
 * @module dsh-mcp-hub/probe
 */

import { spawn } from 'node:child_process'
import { PROBE_CLIENT, PROBE_TIMEOUT_MS } from './constants'
import type { ServerEntry } from './model'

/** Outcome of a connectivity probe; never throws. */
export type ProbeResult = Record<string, unknown>

/** Deadline shared by both probe kinds. */
function withDeadline<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  return work(controller.signal).finally(() => clearTimeout(timer))
}

/** Extract an MCP `initialize` result from raw bytes (JSON or an SSE stream). */
function extractInitialize(raw: string): { serverInfo: any; raw: string } {
  const dataLine = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .find((line) => line.length > 0)
  const candidate = dataLine ?? raw
  let message: any = null
  try {
    message = JSON.parse(candidate)
  } catch {
    message = null
  }
  return { serverInfo: message?.result?.serverInfo ?? null, raw }
}

/** Start one stdio server, run the handshake, and list its tools. */
export function probeStdio(server: ServerEntry): Promise<ProbeResult> {
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

    const finish = (payload: ProbeResult): void => {
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
      () =>
        finish({
          ok: false,
          stage: 'timeout',
          error: `服务在 ${PROBE_TIMEOUT_MS / 1000} 秒内没有应答。`,
          stderr: stderr.slice(-1200),
        }),
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
            toolPrefix: `mcp__${server.serverName}__`,
          })
        }
      }
    })
    child.on('exit', (code) =>
      finish({
        ok: false,
        stage: 'exit',
        error: `服务在应答前退出了（退出码 ${code}）。`,
        stderr: stderr.slice(-1200),
      }),
    )

    const write = (payload: unknown): void => {
      child.stdin?.write(`${JSON.stringify(payload)}\n`)
    }
    write({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: PROBE_CLIENT },
    })
    write({ jsonrpc: '2.0', method: 'notifications/initialized' })
    write({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  })
}

/** Handshake with one streamable-http server. */
export async function probeHttp(server: ServerEntry): Promise<ProbeResult> {
  return withDeadline(async (signal) => {
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
          params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: PROBE_CLIENT },
        }),
        signal,
      })

      const raw = (await response.text()).slice(0, 200_000)
      if (!response.ok) {
        return {
          ok: false,
          stage: 'http',
          status: response.status,
          error: `HTTP ${response.status}。${
            response.status === 401 || response.status === 403 ? '通常是凭证无效或过期。' : ''
          }`,
          body: raw.slice(0, 600),
        }
      }

      const { serverInfo } = extractInitialize(raw)
      return {
        ok: serverInfo !== null,
        status: response.status,
        serverInfo,
        error: serverInfo === null ? '收到了响应，但没有解析到 MCP 的 initialize 结果。' : undefined,
        body: raw.slice(0, 400),
      }
    } catch (error) {
      const aborted = error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
      return {
        ok: false,
        stage: aborted ? 'timeout' : 'network',
        error: aborted ? `请求在 ${PROBE_TIMEOUT_MS / 1000} 秒内没有完成。` : String(error),
      }
    }
  })
}

/** Probe any server, dispatching on its transport. */
export function probe(server: ServerEntry): Promise<ProbeResult> {
  return server.transport === 'stdio' ? probeStdio(server) : probeHttp(server)
}
