window.__ModuleLoader__.load({ id: "dsh-mcp-hub", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
let react = require("react");
let react_jsx_runtime = require("react/jsx-runtime");

//#region src/client/api.ts
const BASE = "/api/mcp-hub";
/** One request against the page's routes, surfacing the host's error text. */
async function request(path, init) {
	const response = await fetch(`${BASE}${path}`, {
		headers: { "content-type": "application/json" },
		...init
	});
	let payload = null;
	try {
		payload = await response.json();
	} catch {
		throw new Error(`设置服务返回了无法解析的响应（HTTP ${response.status}）`);
	}
	const record = payload ?? {};
	if (!response.ok || record.ok === false) {
		const error = new Error(typeof record.error === "string" ? record.error : `请求失败（HTTP ${response.status}）`);
		if (record.issues !== void 0) error.issues = record.issues;
		throw error;
	}
	return payload;
}
/** Read interpreter-independent state: profile, applied flag, problem list. */
function fetchStatus() {
	return request("/status", { method: "GET" });
}
/** Read the server list, the problem map and a preview of the managed block. */
function fetchServers() {
	return request("/servers", { method: "GET" });
}
/** Create or update one server. */
function upsertServer(server) {
	return request("/servers", {
		method: "POST",
		body: JSON.stringify({
			action: "upsert",
			server
		})
	});
}
/** Delete one server. */
function deleteServer(key) {
	return request("/servers", {
		method: "POST",
		body: JSON.stringify({
			action: "delete",
			key
		})
	});
}
/** Enable or disable one server without deleting it. */
function toggleServer(key, enabled) {
	return request("/servers", {
		method: "POST",
		body: JSON.stringify({
			action: "toggle",
			key,
			enabled
		})
	});
}
/** Write (or, with enabled=false, remove) the managed block in the profile. */
function applyServers(enabled) {
	return request("/apply", {
		method: "POST",
		body: JSON.stringify({ enabled })
	});
}
/** Start one server and list its tools (best effort). */
function probeServer(key) {
	return request("/probe", {
		method: "POST",
		body: JSON.stringify({ key })
	});
}
/** Parse a `key: value` / `key=value` textarea into a string map. */
function parsePairText(text) {
	const out = {};
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (line.length === 0 || line.startsWith("#")) continue;
		const match = /^([^:=]+)[:=](.*)$/.exec(line);
		if (match === null) {
			out[line] = "";
			continue;
		}
		out[match[1].trim()] = match[2].trim();
	}
	return out;
}
/** Render a string map back into `key: value` lines for editing. */
function renderPairText(map) {
	return Object.entries(map ?? {}).map(([key, value]) => `${key}: ${value}`).join("\n");
}

//#endregion
//#region src/client/catalog.ts
/** Curated entries, in display order. */
const CATALOG = [
	{
		id: "github",
		name: "GitHub",
		icon: "🐙",
		category: "开发工具",
		summary: "仓库、Issue、Pull Request、Actions、代码搜索",
		transport: "streamable-http",
		url: "https://api.githubcopilot.com/mcp/",
		headers: { Accept: "application/json, text/event-stream" },
		tokenUrl: "https://github.com/settings/personal-access-tokens/new",
		credentialLabel: "GitHub Personal Access Token",
		credentialHelp: "fine-grained PAT，只勾你真正需要的仓库和权限",
		note: "Token 越小越安全：只读用途就不要给 write 权限。"
	},
	{
		id: "notion",
		name: "Notion",
		icon: "📓",
		category: "办公协作",
		summary: "搜索、读取和创建页面与数据库",
		transport: "streamable-http",
		url: "https://mcp.notion.com/mcp",
		headers: { Accept: "application/json, text/event-stream" },
		tokenUrl: "https://www.notion.so/profile/integrations",
		credentialLabel: "Notion Internal Integration Token",
		credentialHelp: "在集成里创建一个内部集成，并把它连接到你要访问的页面",
		note: "Notion 的集成默认访问不到任何页面，需要在页面里手动把它连上。"
	},
	{
		id: "linear",
		name: "Linear",
		icon: "📐",
		category: "办公协作",
		summary: "Issue、项目、周期与团队协作",
		transport: "streamable-http",
		url: "https://mcp.linear.app/sse",
		headers: { Accept: "application/json, text/event-stream" },
		tokenUrl: "https://linear.app/settings/api",
		credentialLabel: "Linear Personal API Key",
		credentialHelp: "在设置 → API 里创建个人 API Key",
		note: "个人 Key 拥有你账号的权限，建议只给自己用。"
	},
	{
		id: "sentry",
		name: "Sentry",
		icon: "🛡️",
		category: "开发工具",
		summary: "错误追踪、事件与发布分析",
		transport: "streamable-http",
		url: "https://mcp.sentry.dev/mcp",
		headers: { Accept: "application/json, text/event-stream" },
		tokenUrl: "https://sentry.io/settings/auth/",
		credentialLabel: "Sentry Auth Token",
		credentialHelp: "在设置 → Auth Tokens 里创建，scope 只给需要的项目",
		note: "建议用只读 scope 起步。"
	}
];
/** Build a server entry from a catalog row plus the user's credential. */
function entryFromCatalog(entry, credential) {
	const headers = { ...entry.headers };
	if (credential.trim().length > 0) headers.Authorization = `Bearer ${credential.trim()}`;
	return {
		key: "",
		name: entry.name,
		serverName: entry.id,
		transport: entry.transport,
		enabled: true,
		url: entry.url,
		headers,
		note: entry.note
	};
}

//#endregion
//#region src/client/SettingsPage.tsx
/**
* The 「MCP 服务器」 page in the DSH Settings panel (v2).
*
* Layout is catalogue-first: pick a vendor entry, the credential panel opens
* with a browser link to the vendor's own token page, save, then apply.
*
* The credential editor is embedded INSIDE each server card — there is exactly
* one place to paste a token, next to the server it belongs to.
*
* @module dsh-mcp-hub/src/client/SettingsPage
*/
/** Human-readable text for any thrown value. */
function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}
/** A checkbox styled as a labelled switch. */
function Switch({ label, checked, onChange }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
		className: "dmhb-switch",
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
			type: "checkbox",
			checked,
			onChange: (event) => onChange(event.target.checked)
		}), label]
	});
}
/** One labelled row. */
function Row({ label, children }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: "dmhb-row",
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
			className: "dmhb-label",
			children: label
		}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
			className: "dmhb-control",
			children
		})]
	});
}
/** A status chip with a coloured dot. */
function Chip({ label, dot, title }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
		className: "dmhb-chip",
		title,
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: `dmhb-dot dmhb-dot-${dot}` }), label]
	});
}
/**
* The credential editor, embedded in each server card.
*
* Accepts either a bare token (wrapped as `Bearer …`) or a full `Header: value`
* line, so pasting straight from a vendor's docs works without the user having
* to know which one it is.
*/
function CredentialPanel({ entry, onSave, onTest, busy }) {
	const [token, setToken] = (0, react.useState)("");
	const hasAuth = Object.keys(entry.headers ?? {}).some((key) => key.toLowerCase() === "authorization");
	const catalog = CATALOG.find((item) => item.id === entry.serverName);
	const commit = () => {
		const text = token.trim();
		if (text.length === 0) return;
		const headerMatch = /^([A-Za-z0-9_-]+)\s*:\s*(.+)$/.exec(text);
		if (headerMatch !== null && !/^bearer\s/i.test(text)) onSave({
			...entry,
			headers: {
				...entry.headers ?? {},
				[headerMatch[1]]: headerMatch[2].trim()
			}
		});
		else {
			const value = /^bearer\s/i.test(text) ? text : `Bearer ${text}`;
			onSave({
				...entry,
				headers: {
					...entry.headers ?? {},
					Authorization: value
				}
			});
		}
		setToken("");
	};
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: "dmhb-form",
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dmhb-actions",
				children: [catalog !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					className: "dmhb-btn",
					disabled: busy,
					onClick: () => window.open(catalog.tokenUrl, "_blank", "noopener"),
					children: [
						"↗ 打开 ",
						catalog.name,
						" 的凭证页"
					]
				}), hasAuth ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "dmhb-hint dmhb-ok",
					children: "已配置凭证 ✓"
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "dmhb-hint",
					children: "还没有配置凭证"
				})]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dmhb-cred",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
					className: "dmhb-input",
					type: "text",
					spellCheck: false,
					autoComplete: "off",
					placeholder: catalog !== void 0 ? catalog.credentialLabel : "粘贴凭证（Bearer <token> 或完整请求头）",
					value: token,
					onChange: (event) => setToken(event.target.value),
					onKeyDown: (event) => {
						if (event.key === "Enter" && token.trim().length > 0) commit();
					}
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: "dmhb-btn dmhb-btn-primary",
					disabled: busy || token.trim().length === 0,
					onClick: commit,
					children: "填入并保存"
				})]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				className: "dmfb-hint",
				children: [
					catalog !== void 0 ? catalog.credentialHelp : "支持粘贴完整请求头（如 Authorization: Bearer xxx），或只贴 token。",
					"  ",
					"保存后立即生效（写入 profile 需再点「应用到 DSH」）。"
				]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "dmhb-actions",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: "dmhb-btn dmhb-btn-primary",
					disabled: busy,
					onClick: () => onTest(entry.key),
					children: "探测（列出工具）"
				})
			})
		]
	});
}
/** The expert form: full control over command / args / env / url / headers. */
function CustomServerForm({ onSave, busy }) {
	const [draft, setDraft] = (0, react.useState)(() => blankDraft());
	const [open, setOpen] = (0, react.useState)(false);
	const [showHeaders, setShowHeaders] = (0, react.useState)(false);
	if (!open) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
		type: "button",
		className: "dmhb-btn",
		disabled: busy,
		onClick: () => setOpen(true),
		children: "+ 自定义（手动填 URL / 命令 / 环境变量）"
	});
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: "dmhb-form",
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Row, {
				label: "显示名",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
					className: "dmhb-input",
					value: draft.name,
					onChange: (event) => setDraft({
						...draft,
						name: event.target.value
					})
				})
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Row, {
				label: "服务名",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
					className: "dmhb-input",
					style: { maxWidth: 240 },
					value: draft.serverName,
					placeholder: "字母数字下划线连字符",
					onChange: (event) => setDraft({
						...draft,
						serverName: event.target.value.replace(/[^A-Za-z0-9_-]/g, "_")
					})
				})
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Row, {
				label: "传输方式",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
					className: "dmhb-select",
					value: draft.transport,
					onChange: (event) => setDraft({
						...draft,
						transport: event.target.value
					}),
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
						value: "streamable-http",
						children: "streamable-http（远程，填 URL）"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
						value: "stdio",
						children: "stdio（本地，填命令）"
					})]
				})
			}),
			draft.transport === "streamable-http" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Row, {
				label: "URL",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
					className: "dmhb-input",
					value: draft.url,
					placeholder: "https://…",
					onChange: (event) => setDraft({
						...draft,
						url: event.target.value
					})
				})
			}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Row, {
					label: "命令",
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						className: "dmhb-input",
						value: draft.command,
						onChange: (event) => setDraft({
							...draft,
							command: event.target.value
						})
					})
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Row, {
					label: "参数",
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						className: "dmhb-input",
						value: draft.args.join(" "),
						onChange: (event) => setDraft({
							...draft,
							args: event.target.value.split(/\s+/).filter((part) => part.length > 0)
						})
					})
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dmhb-row",
					style: { alignItems: "flex-start" },
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dmhb-label",
						children: "环境变量"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dmhb-control",
						style: {
							flexDirection: "column",
							alignItems: "stretch"
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
							className: "dmhb-area",
							value: renderPairText(draft.env),
							onChange: (event) => setDraft({
								...draft,
								env: parsePairText(event.target.value)
							})
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dmfb-hint",
							children: "每行一个 键: 值；值按字符串处理。"
						})]
					})]
				})
			] }),
			draft.transport === "streamable-http" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dmhb-row",
				style: { alignItems: "flex-start" },
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "dmhb-label",
					children: "请求头"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: "dmhb-control",
					style: {
						flexDirection: "column",
						alignItems: "stretch"
					},
					children: showHeaders ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
						className: "dmhb-area",
						value: renderPairText(draft.headers),
						onChange: (event) => setDraft({
							...draft,
							headers: parsePairText(event.target.value)
						})
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dmhb-actions",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "dmhb-hint",
							children: [
								"已配置 ",
								Object.keys(draft.headers ?? {}).length,
								" 个请求头（隐藏显示）"
							]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "dmhb-btn",
							onClick: () => setShowHeaders(true),
							children: "显示 / 编辑"
						})]
					})
				})]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dmhb-actions",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: "dmhb-btn dmhb-btn-primary",
					disabled: busy,
					onClick: () => {
						onSave(draft);
						setOpen(false);
						setDraft(blankDraft());
					},
					children: "保存"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: "dmhb-btn",
					onClick: () => {
						setOpen(false);
						setDraft(blankDraft());
					},
					children: "取消"
				})]
			})
		]
	});
}
/** A blank editing draft. */
function blankDraft() {
	return {
		key: "",
		name: "",
		serverName: "",
		transport: "streamable-http",
		enabled: true,
		url: "",
		headers: {},
		command: "",
		args: [],
		env: {},
		cwd: "",
		note: "",
		updatedAt: 0
	};
}
/**
* The settings page. Registered into `settings.section`.
*/
function McpServersPage() {
	const [servers, setServers] = (0, react.useState)([]);
	const [problems, setProblems] = (0, react.useState)({});
	const [status, setStatus] = (0, react.useState)(null);
	const [probe, setProbe] = (0, react.useState)(null);
	const [probeKey, setProbeKey] = (0, react.useState)(null);
	const [busy, setBusy] = (0, react.useState)(false);
	const [notice, setNotice] = (0, react.useState)("");
	const [error, setError] = (0, react.useState)("");
	const [editingKey, setEditingKey] = (0, react.useState)(null);
	const [editDraft, setEditDraft] = (0, react.useState)(null);
	const noticeTimer = (0, react.useRef)(null);
	const announce = (0, react.useCallback)((text) => {
		setNotice(text);
		setError("");
		if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
		noticeTimer.current = window.setTimeout(() => setNotice(""), 5e3);
	}, []);
	const fail = (0, react.useCallback)((cause) => {
		const withIssues = cause;
		if (withIssues?.issues !== void 0 && withIssues.issues !== null) {
			const first = Object.values(withIssues.issues)[0];
			if (Array.isArray(first) && first.length > 0) {
				setError(first.map((item) => `${item.field}: ${item.problem}`).join("；"));
				setNotice("");
				return;
			}
		}
		setError(messageOf(cause));
		setNotice("");
	}, []);
	const refresh = (0, react.useCallback)(async () => {
		setBusy(true);
		try {
			const [list, statusPayload] = await Promise.all([fetchServers(), fetchStatus()]);
			setServers(list.servers);
			setProblems(list.problems ?? {});
			setStatus(statusPayload);
		} catch (cause) {
			fail(cause);
		} finally {
			setBusy(false);
		}
	}, [fail]);
	(0, react.useEffect)(() => {
		refresh();
		return () => {
			if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
		};
	}, [refresh]);
	/** Connect a catalog entry: store it, then reload. */
	const connect = (0, react.useCallback)(async (item) => {
		setBusy(true);
		try {
			const payload = await upsertServer(entryFromCatalog(item, ""));
			setServers(payload.servers);
			setProblems(payload.problems ?? {});
			setStatus(await fetchStatus());
			announce(`${item.name} 已添加，请在它的卡片里填入凭证`);
		} catch (cause) {
			fail(cause);
		} finally {
			setBusy(false);
		}
	}, [announce, fail]);
	const saveCustom = (0, react.useCallback)(async (entry) => {
		setBusy(true);
		try {
			const payload = await upsertServer(entry);
			setServers(payload.servers);
			setProblems(payload.problems ?? {});
			setStatus(await fetchStatus());
			announce("已保存");
		} catch (cause) {
			fail(cause);
		} finally {
			setBusy(false);
		}
	}, [announce, fail]);
	const remove = (0, react.useCallback)(async (key) => {
		const target = servers.find((item) => item.key === key);
		if (!window.confirm(`删除「${target?.name ?? key}」？`)) return;
		setBusy(true);
		try {
			const payload = await deleteServer(key);
			setServers(payload.servers);
			setStatus(await fetchStatus());
			announce("已删除");
		} catch (cause) {
			fail(cause);
		} finally {
			setBusy(false);
		}
	}, [
		servers,
		announce,
		fail
	]);
	const toggle = (0, react.useCallback)(async (key, enabled) => {
		setBusy(true);
		try {
			const payload = await toggleServer(key, enabled);
			setServers(payload.servers);
			setStatus(await fetchStatus());
		} catch (cause) {
			fail(cause);
		} finally {
			setBusy(false);
		}
	}, [fail]);
	const applyServers$1 = (0, react.useCallback)(async (enabled) => {
		setBusy(true);
		try {
			const payload = await applyServers(enabled);
			announce(enabled ? `已写入 ${payload.servers} 个服务到 profile，重启 DSH 后生效` : "已移除托管块，重启后生效");
			setStatus(await fetchStatus());
		} catch (cause) {
			fail(cause);
		} finally {
			setBusy(false);
		}
	}, [announce, fail]);
	const runProbe = (0, react.useCallback)(async (key) => {
		setBusy(true);
		setProbe(null);
		setProbeKey(key);
		try {
			const payload = await probeServer(key);
			setProbe(payload);
			if (payload.result.ok) announce(`探测成功：${(payload.result.tools ?? []).length} 个工具`);
			else setError(`探测失败：${payload.result.error ?? "未知原因"}`);
		} catch (cause) {
			fail(cause);
		} finally {
			setBusy(false);
		}
	}, [announce, fail]);
	const connectedCount = servers.filter((item) => Object.keys(item.headers ?? {}).some((key) => key.toLowerCase() === "authorization")).length;
	const catalogConnected = (catalogId) => servers.some((item) => item.serverName === catalogId);
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: "dmhb",
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
				className: "dmfb-intro",
				children: [
					"把外部 MCP 服务接进 DSH。点下面的服务卡片添加，按提示在浏览器创建凭证、粘贴回来， 然后「应用到 DSH」；重启后工具以 ",
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dmhb-mono",
						children: "mcp__服务名__工具名"
					}),
					" 出现。"
				]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dmhb-strip",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Chip, {
						label: `已接入 ${servers.length} 个`,
						dot: servers.length > 0 ? "ok" : "warn"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Chip, {
						label: `带凭证 ${connectedCount} 个`,
						dot: connectedCount > 0 ? "ok" : "warn"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Chip, {
						label: status?.block.applied ? `已写入 profile（${status.block.servers} 个）` : "未写入 profile",
						dot: status?.block.applied ? "ok" : "warn",
						title: status?.profile.patchFile
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Chip, {
						label: status?.profile.profileDir ?? "profile 未知",
						dot: status?.profile.source === "argv" || status?.profile.source === "DSH_PROFILE_DIR" ? "ok" : "warn",
						title: `判定来源：${status?.profile.source ?? "-"}\n补丁文件：${status?.profile.patchFile ?? "-"}`
					})
				]
			}),
			error.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "dmhb-error",
				children: error
			}),
			notice.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "dmhb-status dmhb-ok",
				children: notice
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: "dmhb-card",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("h3", { children: ["连接一个服务 ", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dmhb-count",
						children: "点卡片 → 创建凭证 → 粘贴回来"
					})] }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dmhb-cat",
						children: CATALOG.map((item) => {
							const isAdded = catalogConnected(item.id);
							return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
								type: "button",
								className: "dmhb-tile",
								disabled: busy || isAdded,
								onClick: () => void connect(item),
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: "dmhb-tile-head",
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "dmhb-tile-icon",
											children: item.icon
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "dmhb-tile-name",
											children: item.name
										}),
										isAdded && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: "dmhb-tile-badge",
											children: "已添加"
										})
									]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dmhb-tile-summary",
									children: item.summary
								})]
							}, item.id);
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dmhb-hint",
						children: "这些条目指向各厂商自己发布的端点，添加后仍可在下面编辑。 目录刻意保持很小，只收录厂商文档里明确给出的端点。"
					})
				]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: "dmhb-card",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("h3", { children: ["已接入的服务 ", /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: "dmhb-count",
						children: [servers.length, " 个"]
					})] }),
					servers.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dmhb-empty",
						children: "上面选一个开始，或往下用自定义表单添加。"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dmhb-list",
						children: servers.map((entry) => {
							const issues = problems[entry.key] ?? [];
							const isProbed = probeKey === entry.key && probe !== null;
							const isEditing = editingKey === entry.key;
							return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: `dmhb-server ${entry.enabled ? "dmhb-server-on" : "dmhb-server-off"}`,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dmhb-server-head",
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "dmhb-server-name",
												children: entry.name || entry.serverName
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: `dmhb-badge ${entry.enabled ? "dmhb-badge-on" : ""}`,
												children: entry.enabled ? "启用" : "停用"
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: `dmhb-badge ${entry.transport === "streamable-http" ? "dmhb-badge-http" : ""}`,
												children: entry.transport === "stdio" ? "stdio" : "远程"
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
												className: "dmhb-badge dmhb-mono",
												children: [
													"mcp__",
													entry.serverName,
													"__"
												]
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
												className: "dmhb-actions",
												style: { marginLeft: "auto" },
												children: [
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Switch, {
														label: "",
														checked: entry.enabled,
														onChange: (next) => void toggle(entry.key, next)
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
														type: "button",
														className: "dmhb-btn",
														disabled: busy,
														onClick: () => void runProbe(entry.key),
														children: "探测"
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
														type: "button",
														className: "dmhb-btn",
														disabled: busy,
														onClick: () => {
															if (isEditing) {
																setEditingKey(null);
																setEditDraft(null);
															} else {
																setEditingKey(entry.key);
																setEditDraft({ ...entry });
															}
														},
														children: isEditing ? "收起" : "编辑"
													}),
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
														type: "button",
														className: "dmhb-btn dmhb-btn-danger",
														disabled: busy,
														onClick: () => void remove(entry.key),
														children: "删除"
													})
												]
											})
										]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: "dmhb-server-target",
										children: entry.transport === "stdio" ? `${entry.command} ${entry.args.join(" ")}`.trim() : entry.url
									}),
									issues.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: "dmhb-problem",
										children: issues.map((item) => `${item.field}: ${item.problem}`).join("；")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)(CredentialPanel, {
										entry,
										onSave: (next) => void saveCustom(next),
										onTest: (key) => void runProbe(key),
										busy
									}),
									isEditing && editDraft !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dmhb-form",
										style: {
											borderTop: "1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.18))",
											paddingTop: 10
										},
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Row, {
												label: "显示名",
												children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
													className: "dmhb-input",
													value: editDraft.name,
													onChange: (event) => setEditDraft({
														...editDraft,
														name: event.target.value
													})
												})
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Row, {
												label: "服务名",
												children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
													className: "dmhb-input",
													style: { maxWidth: 240 },
													value: editDraft.serverName,
													onChange: (event) => setEditDraft({
														...editDraft,
														serverName: event.target.value.replace(/[^A-Za-z0-9_-]/g, "_")
													})
												})
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
												className: "dmhb-actions",
												children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
													type: "button",
													className: "dmhb-btn dmhb-btn-primary",
													disabled: busy,
													onClick: () => void saveCustom(editDraft).then(() => {
														setEditingKey(null);
														setEditDraft(null);
													}),
													children: "保存修改"
												}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
													type: "button",
													className: "dmhb-btn",
													onClick: () => {
														setEditingKey(null);
														setEditDraft(null);
													},
													children: "取消"
												})]
											})
										]
									}),
									entry.note.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: "dmhb-hint",
										children: entry.note
									}),
									isProbed && probe !== null && probe.result.ok && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: "dmhb-tools",
										children: (probe.result.tools ?? []).map((tool) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: "dmhb-tool",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("code", { children: [
												"mcp__",
												entry.serverName,
												"__",
												tool.name
											] }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [tool.description.slice(0, 160), tool.description.length > 160 ? "…" : ""] })]
										}, tool.name))
									}),
									isProbed && probe !== null && !probe.result.ok && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "dmhb-problem",
										children: ["探测失败：", probe.result.error ?? "未知原因"]
									})
								]
							}, entry.key);
						})
					})
				]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: "dmhb-card",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: "应用到 DSH" }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dmhb-actions",
					children: [
						status?.block.applied === true ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "dmhb-btn dmhb-btn-primary",
							disabled: busy,
							onClick: () => void applyServers$1(true),
							children: "重新写入"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "dmhb-btn dmhb-btn-danger",
							disabled: busy,
							onClick: () => void applyServers$1(false),
							children: "断开"
						})] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: "dmhb-btn dmhb-btn-primary",
							disabled: busy || servers.length === 0,
							onClick: () => void applyServers$1(true),
							children: "应用到 DSH"
						}),
						busy && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "dmhb-spin" }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dmhb-hint",
							children: "写入后需要重启 DSH 才会生效。"
						})
					]
				})]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: "dmhb-card",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("h3", { children: ["自定义 / 高级 ", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "dmhb-count",
					children: "stdio、任意端点"
				})] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CustomServerForm, {
					onSave: (entry) => void saveCustom(entry),
					busy
				})]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				className: "dmhb-card",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: "写入 profile 的内容" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dmhb-preview",
						children: [
							servers.length > 0 ? servers.map((entry) => `mcp-hub__${entry.serverName}${entry.enabled ? "" : "（停用）"}`).join("\n") : "（还没有服务）",
							"\n",
							"→ ",
							status?.profile.patchFile ?? "-"
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dmhb-hint",
						children: "完整 YAML 由宿主生成（每个标量加引号、env/headers 值强制字符串），这里只显示摘要。 凭证以明文存在该文件里，请确保权限仅限本机当前用户。"
					})
				]
			})
		]
	});
}
/** Local helper so the blank draft lives in one place. */
function blankDraft() {
	return {
		key: "",
		name: "",
		serverName: "",
		transport: "streamable-http",
		enabled: true,
		url: "",
		headers: {},
		command: "",
		args: [],
		env: {},
		cwd: "",
		note: "",
		updatedAt: 0
	};
}

//#endregion
//#region src/client/styles.ts
/**
* Stylesheet for the 「MCP 服务器」 settings page (v2 layout).
* @module dsh-mcp-hub/src/client/styles
*/
const STYLE_ID = "dsh-mcp-hub-style";
/** The whole stylesheet. */
const CSS = `
.dmhb { display: flex; flex-direction: column; gap: 16px; padding: 2px 0 28px; max-width: 820px; font-size: 13px; }
.dmhb-intro { font-size: 12.5px; color: var(--dsw-alias-label-secondary, #777); line-height: 1.65; margin: 0; }

.dmhb-card {
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.2));
  border-radius: 12px; padding: 14px 16px 16px;
  display: flex; flex-direction: column; gap: 12px;
  background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.03));
}
.dmhb-card > h3 { margin: 0; font-size: 13.5px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
.dmhb-card > h3 .dmhb-count { font-weight: 400; font-size: 12px; color: var(--dsw-alias-label-secondary, #888); }

/* ---- status strip ---- */
.dmhb-strip { display: flex; gap: 8px; flex-wrap: wrap; }
.dmhb-chip {
  display: inline-flex; align-items: center; gap: 6px; font-size: 12px;
  padding: 5px 11px; border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.2));
  background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.05));
  color: var(--dsw-alias-label-secondary, #777); max-width: 100%;
}
.dmhb-dot { width: 7px; height: 7px; border-radius: 50%; flex: 0 0 auto; }
.dmhb-dot-ok { background: var(--dsw-alias-state-success-primary, #2a2); }
.dmhb-dot-warn { background: var(--dsw-alias-state-warn-primary, #c80); }
.dmhb-dot-bad { background: var(--dsw-alias-state-error-primary, #d33); }
.dmhb-chip strong { color: var(--dsw-alias-label-primary, #111); font-weight: 600; }
.dmhb-chip .dmhb-mono { max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dmhb-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; word-break: break-all; }

/* ---- catalog grid ---- */
.dmhb-cat { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 10px; }
.dmhb-tile {
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.2));
  border-radius: 11px; padding: 12px 13px; text-align: left; cursor: pointer;
  display: flex; flex-direction: column; gap: 6px;
  background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.03));
  color: inherit; font: inherit; transition: border-color .12s ease, transform .12s ease;
}
.dmhb-tile:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary, #4d6bfe); transform: translateY(-1px); }
.dmhb-tile:disabled { opacity: .55; cursor: default; }
.dmhb-tile-head { display: flex; align-items: center; gap: 8px; }
.dmhb-tile-icon { font-size: 18px; line-height: 1; }
.dmhb-tile-name { font-weight: 600; font-size: 13px; flex: 1 1 auto; min-width: 0; }
.dmhb-tile-badge { font-size: 10.5px; padding: 1px 7px; border-radius: 999px;
  background: var(--dsw-alias-state-success-primary, #2a2); color: #fff; white-space: nowrap; }
.dmhb-tile-summary { font-size: 11.5px; color: var(--dsw-alias-label-secondary, #888); line-height: 1.5; }
.dmhb-tile-note { font-size: 11px; color: var(--dsw-alias-state-warn-primary, #c80); }

/* ---- server list ---- */
.dmhb-list { display: flex; flex-direction: column; gap: 8px; }
.dmhb-server {
  border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.2)); border-radius: 11px; padding: 11px 13px;
  display: flex; flex-direction: column; gap: 7px;
  background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.03));
}
.dmhb-server-on { border-color: var(--dsw-alias-state-success-primary, #2a2); }
.dmhb-server-off { opacity: .6; }
.dmhb-server-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dmhb-server-name { font-weight: 600; font-size: 13px; }
.dmhb-badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: rgba(127,127,127,0.14);
  color: var(--dsw-alias-label-secondary, #777); white-space: nowrap; }
.dmhb-badge-on { background: var(--dsw-alias-state-success-primary, #2a2); color: #fff; }
.dmhb-badge-http { background: rgba(77,107,254,.14); color: var(--dsw-alias-brand-primary, #4d6bfe); }
.dmhb-server-target { font-size: 11.5px; color: var(--dsw-alias-label-secondary, #888);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dmhb-problem { font-size: 11.5px; color: var(--dsw-alias-state-error-primary, #d33); word-break: break-word; }

/* ---- form ---- */
.dmhb-form { display: flex; flex-direction: column; gap: 11px; }
.dmhb-row { display: flex; align-items: center; gap: 12px; min-height: 28px; }
.dmhb-row > .dmhb-label { flex: 0 0 118px; font-size: 12.5px; }
.dmhb-row > .dmhb-control { flex: 1 1 auto; display: flex; align-items: center; gap: 10px; min-width: 0; }
.dmhb-label { font-size: 12.5px; }
.dmhb-hint { font-size: 11.5px; color: var(--dsw-alias-label-secondary, #8a8a8a); line-height: 1.5; }
.dmhb-input, .dmhb-area, .dmhb-select {
  font: inherit; font-size: 12.5px; padding: 6px 10px; border-radius: 8px; color: inherit; width: 100%; box-sizing: border-box;
  border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.3));
  background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.06));
}
.dmhb-select { max-width: 250px; width: auto; }
.dmhb-input:focus, .dmhb-area:focus, .dmhb-select:focus { outline: none; border-color: var(--dsw-alias-brand-primary, #4d6bfe); }
.dmhb-area { min-height: 64px; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; line-height: 1.5; }
.dmhb-switch { display: inline-flex; align-items: center; gap: 8px; font-size: 12.5px; cursor: pointer; user-select: none; }
.dmhb-switch input { width: 15px; height: 15px; accent-color: var(--dsw-alias-brand-primary, #4d6bfe); margin: 0; cursor: pointer; }

/* ---- buttons ---- */
.dmhb-btn {
  appearance: none; font: inherit; font-size: 12.5px; padding: 6px 14px; border-radius: 8px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.3));
  background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.05)); color: inherit; white-space: nowrap;
}
.dmhb-btn:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary, #4d6bfe); }
.dmhb-btn:disabled { opacity: .5; cursor: default; }
.dmhb-btn-primary { background: var(--dsw-alias-label-primary, #111); color: var(--dsw-alias-bg-base, #fff); border-color: transparent; }
.dmhb-btn-danger { color: var(--dsw-alias-state-error-primary, #d33); }
.dmhb-link { appearance: none; border: none; background: none; color: var(--dsw-alias-brand-primary, #4d6bfe);
  cursor: pointer; font: inherit; font-size: 12px; padding: 0; text-decoration: underline; }
.dmhb-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }

/* ---- misc ---- */
.dmhb-spin { width: 12px; height: 12px; border-radius: 50%; border: 2px solid rgba(127,127,127,.3);
  border-top-color: var(--dsw-alias-brand-primary, #4d6bfe); animation: dmhb-spin .7s linear infinite; }
@keyframes dmhb-spin { to { transform: rotate(360deg); } }
.dmhb-empty { text-align: center; color: var(--dsw-alias-label-secondary, #999); font-size: 12.5px; padding: 22px 10px; }
.dmhb-tools { display: flex; flex-direction: column; gap: 6px; max-height: 250px; overflow: auto; }
.dmhb-tool { border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,0.18)); border-radius: 8px; padding: 7px 10px;
  display: flex; flex-direction: column; gap: 2px;
  background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,0.03)); }
.dmhb-tool code { font-size: 12px; font-weight: 600; }
.dmhb-tool span { font-size: 11.5px; color: var(--dsw-alias-label-secondary, #888); }
.dmhb-status { font-size: 12px; min-height: 18px; }
.dmhb-error { font-size: 12px; color: var(--dsw-alias-state-error-primary, #d33); word-break: break-word; }
.dmhb-ok { color: var(--dsw-alias-state-success-primary, #2a2); }
.dmhb-cred { display: flex; gap: 8px; align-items: center; }
.dmhb-cred .dmhb-input { flex: 1 1 auto; }
`;
/** Inject the stylesheet once; safe to call on every apply(). */
function ensureStyles() {
	if (typeof document === "undefined") return;
	if (document.getElementById(STYLE_ID) !== null) return;
	const element = document.createElement("style");
	element.id = STYLE_ID;
	element.textContent = CSS;
	document.head.appendChild(element);
}

//#endregion
//#region src/client/index.ts
/** Services this half needs before it can register anything. */
const inject = ["slots"];
/** Guards against a duplicate loader row applying the plugin twice. */
let applied = false;
/**
* Register the Settings page.
* @param ctx - the client context.
*/
function apply(ctx) {
	if (applied) return;
	applied = true;
	ensureStyles();
	ctx.slots.inject("settings.section", () => {
		try {
			return ctx.slots.register({
				name: "settings.section",
				id: "mcp-hub",
				order: 97,
				label: "MCP 服务器"
			}, McpServersPage);
		} catch (error) {
			if (error instanceof Error && /already|duplicate/i.test(error.message)) return () => {};
			throw error;
		}
	});
}

//#endregion
exports.apply = apply;
exports.inject = inject;
return module.exports; } });