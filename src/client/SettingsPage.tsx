/**
 * The 「MCP 服务器」 page in the DSH Settings panel (v2).
 *
 * Layout is catalogue-first: pick a vendor entry, the credential panel opens
 * with a browser link to the vendor's own token page, save, then apply.
 *
 * @module dsh-mcp-hub/src/client/SettingsPage
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import * as api from './api'
import type { Problems, ServerEntry } from './api'
import { parsePairText, renderPairText } from './api'
import { CATALOG, entryFromCatalog, type CatalogEntry } from './catalog'

/** Human-readable text for any thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A checkbox styled as a labelled switch. */
function Switch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (next: boolean) => void }): JSX.Element {
  return (
    <label className="dmhb-switch">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      {label}
    </label>
  )
}

/** One labelled row. */
function Row({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="dmhb-row">
      <span className="dmhb-label">{label}</span>
      <div className="dmhb-control">{children}</div>
    </div>
  )
}

/** A status chip with a coloured dot. */
function Chip({ label, dot, title }: { label: string; dot: 'ok' | 'warn' | 'bad'; title?: string }): JSX.Element {
  return (
    <span className="dmhb-chip" title={title}>
      <span className={`dmhb-dot dmhb-dot-${dot}`} />
      {label}
    </span>
  )
}

/** The credential panel: browser link + one field + save. */
function CredentialPanel({
  entry,
  onSave,
  onTest,
  busy,
  testing,
}: {
  entry: ServerEntry
  onSave: (next: ServerEntry) => void
  onTest: (key: string) => void
  busy: boolean
  testing: boolean
}): JSX.Element {
  const [token, setToken] = useState('')
  const hasAuth = Object.keys(entry.headers ?? {}).some((key) => key.toLowerCase() === 'authorization')
  const catalog = CATALOG.find((item) => item.id === entry.key || item.serverName === entry.serverName)

  /**
   * Accepts either a bare token or a full `Header: value` line, so pasting
   * straight from a vendor's docs works without the user having to know which
   * one it is.
   */
  const commit = (): void => {
    const text = token.trim()
    if (text.length === 0) return

    const headerMatch = /^([A-Za-z0-9_-]+)\s*:\s*(.+)$/.exec(text)
    if (headerMatch !== null && !/^bearer\s/i.test(text)) {
      // A full header line: store it verbatim.
      onSave({
        ...entry,
        headers: { ...(entry.headers ?? {}), [headerMatch[1]]: headerMatch[2].trim() },
      })
    } else {
      // A bare credential: wrap it as a bearer token.
      const value = /^bearer\s/i.test(text) ? text : `Bearer ${text}`
      onSave({
        ...entry,
        headers: { ...(entry.headers ?? {}), Authorization: value },
      })
    }
    setToken('')
  }

  return (
    <div className="dmhb-form">
      <div className="dmhb-actions">
        {catalog !== undefined && (
          <button
            type="button"
            className="dmhb-btn"
            disabled={busy}
            onClick={() => window.open(catalog.tokenUrl, '_blank', 'noopener')}
          >
            ↗ 打开 {catalog.name} 的凭证页
          </button>
        )}
        {hasAuth ? (
          <span className="dmhb-hint dmhb-ok">已配置 ✓</span>
        ) : (
          <span className="dmhb-hint">还没有配置凭证</span>
        )}
      </div>
      <div className="dmhb-cred">
        <input
          className="dmhb-input"
          type="text"
          spellCheck={false}
          autoComplete="off"
          placeholder={catalog !== undefined ? catalog.credentialLabel : '粘贴凭证（如 Bearer <PAT> 或完整请求头）'}
          value={token}
          onChange={(event) => setToken(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && token.trim().length > 0) commit()
          }}
        />
        <button type="button" className="dmhb-btn dmhb-btn-primary" disabled={busy || token.trim().length === 0} onClick={commit}>
          填入并保存
        </button>
      </div>
      <span className="dmfb-hint">
        {catalog !== undefined ? catalog.credentialHelp : '支持粘贴完整请求头（如 Authorization: Bearer xxx），或只贴 token。'}
        {'  '}保存后立即生效（写入 profile 需再点「应用到 DSH」）。
      </span>
      <div className="dmhb-actions">
        <button type="button" className="dmhb-btn dmhb-btn-primary" disabled={busy} onClick={() => onTest(entry.key)}>
          {testing ? '探测中…' : '探测（列出工具）'}
        </button>
      </div>
    </div>
  )
}

/**
 * The settings page. Registered into `settings.section`.
 */
export function McpServersPage(): JSX.Element {
  const [servers, setServers] = useState<ServerEntry[]>([])
  const [problems, setProblems] = useState<Problems>({})
  const [status, setStatus] = useState<api.StatusPayload | null>(null)
  const [probe, setProbe] = useState<api.ProbePayload | null>(null)
  const [probeKey, setProbeKey] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [testingKey, setTestingKey] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const noticeTimer = useRef<number | null>(null)

  const announce = useCallback((text: string): void => {
    setNotice(text)
    setError('')
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setNotice(''), 5000)
  }, [])

  const fail = useCallback((cause: unknown): void => {
    const withIssues = cause as Error & { issues?: Problems }
    if (withIssues?.issues !== undefined && withIssues.issues !== null) {
      const first = Object.values(withIssues.issues)[0]
      if (Array.isArray(first) && first.length > 0) {
        setError(first.map((item) => `${item.field}: ${item.problem}`).join('；'))
        setNotice('')
        return
      }
    }
    setError(messageOf(cause))
    setNotice('')
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      const [list, statusPayload] = await Promise.all([api.fetchServers(), api.fetchStatus()])
      setServers(list.servers)
      setProblems(list.problems ?? {})
      setStatus(statusPayload)
    } catch (cause) {
      fail(cause)
    } finally {
      setBusy(false)
    }
  }, [fail])

  useEffect(() => {
    void refresh()
    return () => {
      if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current)
    }
  }, [refresh])

  /** Connect a catalog entry: store it, then reload. */
  const connect = useCallback(
    async (item: CatalogEntry, credential: string): Promise<void> => {
      setBusy(true)
      try {
        const payload = await api.upsertServer(entryFromCatalog(item, credential))
        setServers(payload.servers)
        setProblems(payload.problems ?? {})
        setStatus(await api.fetchStatus())
        announce(`${item.name} 已添加${credential.trim().length > 0 ? '，凭证已填入' : '（未填凭证，先去第②步）'}`)
      } catch (cause) {
        fail(cause)
      } finally {
        setBusy(false)
      }
    },
    [announce, fail],
  )

  const remove = useCallback(
    async (key: string): Promise<void> => {
      const target = servers.find((item) => item.key === key)
      if (!window.confirm(`删除「${target?.name ?? key}」？`)) return
      setBusy(true)
      try {
        const payload = await api.deleteServer(key)
        setServers(payload.servers)
        setStatus(await api.fetchStatus())
        announce('已删除')
      } catch (cause) {
        fail(cause)
      } finally {
        setBusy(false)
      }
    },
    [servers, announce, fail],
  )

  const toggle = useCallback(
    async (key: string, enabled: boolean): Promise<void> => {
      setBusy(true)
      try {
        const payload = await api.toggleServer(key, enabled)
        setServers(payload.servers)
        setStatus(await api.fetchStatus())
      } catch (cause) {
        fail(cause)
      } finally {
        setBusy(false)
      }
    },
    [fail],
  )

  const applyServers = useCallback(
    async (enabled: boolean): Promise<void> => {
      setBusy(true)
      try {
        const payload = await api.applyServers(enabled)
        announce(enabled ? `已写入 ${payload.servers} 个服务到 profile，重启 DSH 后生效` : '已移除托管块，重启后生效')
        setStatus(await api.fetchStatus())
      } catch (cause) {
        fail(cause)
      } finally {
        setBusy(false)
      }
    },
    [announce, fail],
  )

  const runProbe = useCallback(
    async (key: string): Promise<void> => {
      setBusy(true)
      setProbe(null)
      setProbeKey(key)
      try {
        const payload = await api.probeServer(key)
        setProbe(payload)
        if (payload.result.ok) announce(`探测成功：${(payload.result.tools ?? []).length} 个工具`)
        else setError(`探测失败：${payload.result.error ?? '未知原因'}`)
      } catch (cause) {
        fail(cause)
      } finally {
        setBusy(false)
      }
    },
    [announce, fail],
  )

  /** Save an arbitrary server entry (custom form path). */
  const saveCustom = useCallback(
    async (entry: ServerEntry): Promise<void> => {
      setBusy(true)
      try {
        const payload = await api.upsertServer(entry)
        setServers(payload.servers)
        setProblems(payload.problems ?? {})
        setStatus(await api.fetchStatus())
        announce('已保存')
      } catch (cause) {
        fail(cause)
      } finally {
        setBusy(false)
      }
    },
    [announce, fail],
  )

  const connectedCount = servers.filter((item) => Object.keys(item.headers ?? {}).some((key) => key.toLowerCase() === 'authorization')).length
  const catalogConnected = (catalogId: string): boolean =>
    servers.some((item) => item.serverName === catalogId || item.key === catalogId)

  return (
    <div className="dmhb">
      <p className="dmfb-intro">
        把外部 MCP 服务接进 DSH。选一个下面的服务，按提示创建凭证、粘贴进来，然后「应用到 DSH」；
        重启后工具以 <span className="dmhb-mono">mcp__服务名__工具名</span> 出现。
      </p>

      {/* ---------------------------------------------------------- status */}
      <div className="dmhb-strip">
        <Chip label={`已接入 ${servers.length} 个`} dot={servers.length > 0 ? 'ok' : 'warn'} />
        <Chip label={`带凭证 ${connectedCount} 个`} dot={connectedCount > 0 ? 'ok' : 'warn'} />
        <Chip
          label={status?.block.applied ? `已写入 profile（${status.block.servers} 个）` : '未写入 profile'}
          dot={status?.block.applied ? 'ok' : 'warn'}
          title={status?.profile.patchFile}
        />
        <Chip
          label={status?.profile.profileDir ?? 'profile 未知'}
          dot={status?.profile.source === 'argv' || status?.profile.source === 'DSH_PROFILE_DIR' ? 'ok' : 'warn'}
          title={`判定来源：${status?.profile.source ?? '-'}\n补丁文件：${status?.profile.patchFile ?? '-'}`}
        />
      </div>

      {error.length > 0 && <div className="dmhb-error">{error}</div>}
      {notice.length > 0 && <div className="dmhb-status dmhb-ok">{notice}</div>}

      {/* -------------------------------------------------------- catalogue */}
      <section className="dmhb-card">
        <h3>
          连接一个服务 <span className="dmhb-count">点选 → 创建凭证 → 粘贴回来</span>
        </h3>
        <div className="dmhb-cat">
          {CATALOG.map((item) => {
            const isAdded = catalogConnected(item.id)
            return (
              <button
                key={item.id}
                type="button"
                className="dmhb-tile"
                disabled={busy}
                onClick={() => void connect(item, '')}
              >
                <span className="dmhb-tile-head">
                  <span className="dmhb-tile-icon">{item.icon}</span>
                  <span className="dmhb-tile-name">{item.name}</span>
                  {isAdded && <span className="dmhb-tile-badge">已添加</span>}
                </span>
                <span className="dmhb-tile-summary">{item.summary}</span>
              </button>
            )
          })}
        </div>
        <span className="dmhb-hint">
          这些条目指向各厂商**自己发布**的端点，添加后仍可在下面编辑。目录刻意保持很小，只收录厂商文档里明确给出的端点。
        </span>
      </section>

      {/* ------------------------------------------------------ apply strip */}
      <section className="dmhb-card">
        <h3>应用到 DSH</h3>
        <div className="dmhb-actions">
          {status?.block.applied === true ? (
            <>
              <button type="button" className="dmhb-btn dmfb-btn-primary" disabled={busy} onClick={() => void applyServers(true)}>
                重新写入
              </button>
              <button type="button" className="dmhb-btn dmhb-btn-danger" disabled={busy} onClick={() => void applyServers(false)}>
                断开
              </button>
            </>
          ) : (
            <button type="button" className="dmhb-btn dmhb-btn-primary" disabled={busy || servers.length === 0} onClick={() => void applyServers(true)}>
              应用到 DSH
            </button>
          )}
          {busy && <span className="dmhb-spin" />}
          <span className="dmhb-hint">写入后需要重启 DSH 才会生效。</span>
        </div>
      </section>

      {/* ------------------------------------------------------ my servers */}
      <section className="dmhb-card">
        <h3>
          已接入的服务 <span className="dmhb-count">{servers.length} 个</span>
        </h3>
        {servers.length === 0 && <div className="dmhb-empty">上面选一个开始，或往下用自定义表单添加。</div>}
        <div className="dmhb-list">
          {servers.map((entry) => {
            const issues = problems[entry.key] ?? []
            const isProbed = probeKey === entry.key && probe !== null
            return (
              <div key={entry.key} className={`dmhb-server ${entry.enabled ? 'dmhb-server-on' : 'dmhb-server-off'}`}>
                <div className="dmhb-server-head">
                  <span className="dmhb-server-name">{entry.name || entry.serverName}</span>
                  <span className={`dmhb-badge ${entry.enabled ? 'dmhb-badge-on' : ''}`}>{entry.enabled ? '启用' : '停用'}</span>
                  <span className={`dmhb-badge ${entry.transport === 'streamable-http' ? 'dmhb-badge-http' : ''}`}>
                    {entry.transport === 'stdio' ? 'stdio' : '远程'}
                  </span>
                  <span className="dmhb-badge dmhb-mono">mcp__{entry.serverName}__</span>
                  <span className="dmhb-actions" style={{ marginLeft: 'auto' }}>
                    <Switch label="" checked={entry.enabled} onChange={(next) => void toggle(entry.key, next)} />
                    <button type="button" className="dmhb-btn" disabled={busy} onClick={() => void runProbe(entry.key)}>
                      探测
                    </button>
                    <button type="button" className="dmhb-btn dmhb-btn-danger" disabled={busy} onClick={() => void remove(entry.key)}>
                      删除
                    </button>
                  </span>
                </div>
                <div className="dmhb-server-target">
                  {entry.transport === 'stdio' ? `${entry.command} ${entry.args.join(' ')}`.trim() : entry.url}
                </div>
                {issues.length > 0 && (
                  <div className="dmhb-problem">{issues.map((item) => `${item.field}: ${item.problem}`).join('；')}</div>
                )}
                {/* The credential editor lives inside the card so there is
                    exactly one place to paste a token, next to the server it
                    belongs to. */}
                <CredentialPanel entry={entry} onSave={(next) => void saveCustom(next)} onTest={(key) => void runProbe(key)} busy={busy} testing={testingKey === entry.key} />
                {entry.note.length > 0 && <div className="dmhb-hint">{entry.note}</div>}
                {isProbed && probe !== null && probe.result.ok && (
                  <div className="dmhb-tools">
                    {(probe.result.tools ?? []).map((tool) => (
                      <div key={tool.name} className="dmhb-tool">
                        <code>mcp__{entry.serverName}__{tool.name}</code>
                        <span>{tool.description.slice(0, 160)}{tool.description.length > 160 ? '…' : ''}</span>
                      </div>
                    ))}
                  </div>
                )}
                {isProbed && probe !== null && !probe.result.ok && (
                  <div className="dmhb-problem">探测失败：{probe.result.error ?? '未知原因'}</div>
                )}
              </div>
            )
          })}
        </div>
      </section>

      {/* -------------------------------------------------- custom (expert) */}
      <section className="dmhb-card">
        <h3>
          自定义 / 高级 <span className="dmhb-count">stdio、任意端点</span>
        </h3>
        <CustomServerForm onSave={(entry) => void saveCustom(entry)} busy={busy} />
      </section>

      {/* ----------------------------------------------------- block preview */}
      <section className="dmhb-card">
        <h3>写入 profile 的内容</h3>
        <div className="dmhb-preview">
          {servers.length > 0 ? servers.map((entry) => `mcp-hub__${entry.serverName}${entry.enabled ? '' : '（停用）'}`).join('\n') : '（还没有服务）'}
          {'\n'}→ {status?.profile.patchFile ?? '-'}
        </div>
        <span className="dmhb-hint">
          完整 YAML 由宿主生成（每个标量加引号、env/headers 值强制字符串），这里只显示摘要。
          凭证以明文存在该文件里，请确保权限仅限本机当前用户。
        </span>
      </section>
    </div>
  )
}

/** The expert form: full control over command / args / env / url / headers. */
function CustomServerForm({ onSave, busy }: { onSave: (entry: ServerEntry) => void; busy: boolean }): JSX.Element {
  const [draft, setDraft] = useState<ServerEntry>(() => blankDraft())
  const [open, setOpen] = useState(false)
  const [showSecret, setShowSecret] = useState(false)

  if (!open) {
    return (
      <button type="button" className="dmhb-btn" disabled={busy} onClick={() => setOpen(true)}>
        + 自定义（手动填 URL / 命令 / 环境变量）
      </button>
    )
  }

  return (
    <div className="dmhb-form">
      <Row label="显示名">
        <input className="dmhb-input" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
      </Row>
      <Row label="服务名">
        <input className="dmhb-input" style={{ maxWidth: 240 }} value={draft.serverName}
          placeholder="字母数字下划线连字符"
          onChange={(event) => setDraft({ ...draft, serverName: event.target.value.replace(/[^A-Za-z0-9_-]/g, '_') })} />
      </Row>
      <Row label="传输方式">
        <select className="dmhb-select" value={draft.transport}
          onChange={(event) => setDraft({ ...draft, transport: event.target.value as ServerEntry['transport'] })}>
          <option value="streamable-http">streamable-http</option>
          <option value="stdio">stdio</option>
        </select>
      </Row>
      {draft.transport === 'streamable-http' ? (
        <Row label="URL">
          <input className="dmhb-input" value={draft.url} placeholder="https://…" onChange={(event) => setDraft({ ...draft, url: event.target.value })} />
        </Row>
      ) : (
        <>
          <Row label="命令">
            <input className="dmhb-input" value={draft.command} onChange={(event) => setDraft({ ...draft, command: event.target.value })} />
          </Row>
          <Row label="参数">
            <input className="dmhb-input" value={draft.args.join(' ')}
              onChange={(event) => setDraft({ ...draft, args: event.target.value.split(/\s+/).filter((part) => part.length > 0) })} />
          </Row>
          <div className="dmhb-row" style={{ alignItems: 'flex-start' }}>
            <span className="dmhb-label">环境变量</span>
            <div className="dmhb-control" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
              <textarea className="dmhb-area" value={renderPairText(draft.env)} onChange={(event) => setDraft({ ...draft, env: parsePairText(event.target.value) })} />
              <span className="dmfb-hint">每行一个 键: 值；值按字符串处理。</span>
            </div>
          </div>
        </>
      )}
      {draft.transport === 'streamable-http' && (
        <div className="dmhb-row" style={{ alignItems: 'flex-start' }}>
          <span className="dmhb-label">请求头</span>
          <div className="dmhb-control" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
            {showSecret ? (
              <textarea className="dmhb-area" value={renderPairText(draft.headers)} onChange={(event) => setDraft({ ...draft, headers: parsePairText(event.target.value) })} />
            ) : (
              <div className="dmhb-actions">
                <span className="dmhb-hint">已配置 {Object.keys(draft.headers ?? {}).length} 个请求头（隐藏显示）</span>
                <button type="button" className="dmhb-btn" onClick={() => setShowSecret(true)}>显示 / 编辑</button>
              </div>
            )}
          </div>
        </div>
      )}
      <div className="dmhb-actions">
        <button type="button" className="dmhb-btn dmhb-btn-primary" disabled={busy} onClick={() => { onSave(draft); setOpen(false); setDraft(blankDraft()) }}>
          保存
        </button>
        <button type="button" className="dmhb-btn" onClick={() => { setOpen(false); setDraft(blankDraft()) }}>
          取消
        </button>
      </div>
    </div>
  )
}

/** Local helper so the blank draft lives in one place. */
function blankDraft(): ServerEntry {
  return {
    key: '',
    name: '',
    serverName: '',
    transport: 'streamable-http',
    enabled: true,
    url: '',
    headers: {},
    command: '',
    args: [],
    env: {},
    cwd: '',
    note: '',
    updatedAt: 0,
  }
}
