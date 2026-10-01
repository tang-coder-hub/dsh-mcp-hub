import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";

//#region src/constants.ts
/**
* Shared constants for the mcp-hub host half.
*
* Every magic value that used to be inlined across the routes lives here, so
* the protocol limits, the official client's field contract and the generated
* id namespace are each defined exactly once.
*
* @module dsh-mcp-hub/constants
*/
/** Loader entry id of this plugin's own bundle. */
const PLUGIN_ENTRY_ID = "mcp-hub";
/** Namespace prefix for every loader id this page generates. */
const GENERATED_ID_PREFIX = "mcp-hub__";
/** Delimiter pair for the block this plugin owns in the profile patch. */
const BLOCK_BEGIN = "# >>> mcp-hub (managed by the DSH settings page; edits here are overwritten) >>>";
const BLOCK_END = "# <<< mcp-hub <<<";
/** The official client plugin this page writes rows for. */
const MCP_CLIENT_PACKAGE = "@deepseek-ai/dsh-mcp-client";
/** Mirrors the official client's own `serverName` validation. */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
/** Valid transports, mirroring the official client's config union. */
const TRANSPORTS = ["stdio", "streamable-http"];
/** Route prefix for this page's HTTP API. */
const ROUTE_PREFIX = "/api/mcp-hub";
/** Hard ceilings — config can lower these but never raise them. */
const HARD_LIMITS = {
	serverNameLength: 32,
	roots: 16,
	maxEntries: 1e4,
	maxDepth: 10,
	maxFileBytes: 10 * 1024 * 1024,
	timeoutSeconds: 300,
	envKeys: 32,
	headerKeys: 16,
	args: 64,
	servers: 64
};
/** Probe deadline; a hung server must not stall the page. */
const PROBE_TIMEOUT_MS = 2e4;
/** Marker probe client identity sent in `initialize`. */
const PROBE_CLIENT = {
	name: "dsh-mcp-hub",
	version: "1.0.0"
};

//#endregion
//#region src/profile.ts
/**
* Profile discovery and managed-block IO.
*
* `resolveProfileDir` exists because the desktop host does **not** export
* `DSH_PROFILE_DIR` to itself — the app receives its profile directory as a
* command-line argument. Falling back to a hard-coded profile name would
* silently edit the wrong profile, so every step records where it came from
* and the source is surfaced in the UI.
*
* @module dsh-mcp-hub/profile
*/
/** Resolve the harness home without importing `@deepseek-ai/dsh-home-paths`. */
function resolveHome() {
	const fromEnv = process.env.DSH_HOME;
	return typeof fromEnv === "string" && fromEnv.length > 0 ? fromEnv : join(homedir(), ".dsh");
}
/** Whether a directory carries a patch layer we could edit. */
function hasPatch(candidate) {
	try {
		return existsSync(join(candidate, "cordis.patch.yml"));
	} catch {
		return false;
	}
}
/**
* Find the profile directory whose patch layer this page should edit.
*
* Resolution order: `DSH_PROFILE_DIR` → the desktop host's command-line
* arguments → `DSH_PROFILE` → well-known profile names. Each fallback is
* recorded so a wrong guess is visible in the UI instead of silent.
*/
function resolveProfileDir(home) {
	const profilesRoot = join(home, "profiles");
	const fromEnv = process.env.DSH_PROFILE_DIR;
	if (typeof fromEnv === "string" && fromEnv.length > 0 && hasPatch(fromEnv)) return {
		dir: fromEnv,
		source: "DSH_PROFILE_DIR"
	};
	for (const argument of process.argv) {
		if (typeof argument !== "string" || argument.length === 0) continue;
		let candidate;
		try {
			candidate = resolve(argument);
		} catch {
			continue;
		}
		if (candidate.startsWith(profilesRoot) && hasPatch(candidate)) return {
			dir: candidate,
			source: "argv"
		};
	}
	const named = process.env.DSH_PROFILE;
	if (typeof named === "string" && named.length > 0) {
		const candidate = join(profilesRoot, named);
		if (hasPatch(candidate)) return {
			dir: candidate,
			source: "DSH_PROFILE"
		};
	}
	for (const candidate of [join(profilesRoot, "desktop"), join(profilesRoot, "web")]) if (hasPatch(candidate)) return {
		dir: candidate,
		source: "default-name"
	};
	return {
		dir: join(profilesRoot, "web"),
		source: "fallback"
	};
}
/** Resolve every location this page reads and writes. */
function resolveLocations() {
	const home = resolveHome();
	const dataDir = join(home, "mcp-hub");
	const storeFile = join(dataDir, "servers.json");
	const { dir: profileDir, source: profileSource } = resolveProfileDir(home);
	return {
		home,
		dataDir,
		storeFile,
		profileDir,
		patchFile: join(profileDir, "cordis.patch.yml"),
		profileSource
	};
}
/** Read the profile patch text (empty when absent). */
function readPatch(patchFile) {
	try {
		return existsSync(patchFile) ? readFileSync(patchFile, "utf8") : "";
	} catch {
		return "";
	}
}
/** Atomically write text over a file, creating parent directories. */
function atomicWrite(file, text) {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, text, "utf8");
	renameSync(tmp, file);
}
/** Remove a previously managed block, if present. */
function stripBlock(text, beginMarker, endMarker) {
	const start = text.indexOf(beginMarker);
	if (start < 0) return text;
	const end = text.indexOf(endMarker, start);
	if (end < 0) return text.slice(0, start);
	return text.slice(0, start) + text.slice(end + endMarker.length);
}

//#endregion
//#region src/probe.ts
/**
* Connectivity probes for managed servers.
*
* Both probes speak real JSON-RPC: `initialize` followed by `tools/list`.
* A probe never throws — every outcome, including timeouts and transport
* failures, is returned as data so the page can render it inline.
*
* @module dsh-mcp-hub/probe
*/
/** Deadline shared by both probe kinds. */
function withDeadline(work) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
	return work(controller.signal).finally(() => clearTimeout(timer));
}
/** Extract an MCP `initialize` result from raw bytes (JSON or an SSE stream). */
function extractInitialize(raw) {
	const candidate = raw.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).find((line) => line.length > 0) ?? raw;
	let message = null;
	try {
		message = JSON.parse(candidate);
	} catch {
		message = null;
	}
	return {
		serverInfo: message?.result?.serverInfo ?? null,
		raw
	};
}
/** Start one stdio server, run the handshake, and list its tools. */
function probeStdio(server) {
	return new Promise((done) => {
		const child = spawn(server.command, server.args, {
			cwd: server.cwd.length > 0 ? server.cwd : void 0,
			env: {
				...process.env,
				...server.env
			},
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			],
			windowsHide: true
		});
		let buffer = "";
		let stderr = "";
		let settled = false;
		const finish = (payload) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try {
				child.kill();
			} catch {}
			done({
				transport: "stdio",
				...payload
			});
		};
		const timer = setTimeout(() => finish({
			ok: false,
			stage: "timeout",
			error: `服务在 ${PROBE_TIMEOUT_MS / 1e3} 秒内没有应答。`,
			stderr: stderr.slice(-1200)
		}), PROBE_TIMEOUT_MS);
		child.on("error", (error) => finish({
			ok: false,
			stage: "spawn",
			error: String(error)
		}));
		child.stderr?.on("data", (chunk) => {
			stderr += String(chunk);
		});
		child.stdout?.on("data", (chunk) => {
			buffer += String(chunk);
			let index = buffer.indexOf("\n");
			while (index >= 0) {
				const line = buffer.slice(0, index).trim();
				buffer = buffer.slice(index + 1);
				index = buffer.indexOf("\n");
				if (line.length === 0) continue;
				let message;
				try {
					message = JSON.parse(line);
				} catch {
					continue;
				}
				if (message.id === 2) {
					const tools = message.result?.tools ?? [];
					finish({
						ok: true,
						serverInfo: message.result?.serverInfo ?? null,
						tools: tools.map((tool) => ({
							name: tool.name,
							description: tool.description ?? ""
						})),
						toolPrefix: `mcp__${server.serverName}__`
					});
				}
			}
		});
		child.on("exit", (code) => finish({
			ok: false,
			stage: "exit",
			error: `服务在应答前退出了（退出码 ${code}）。`,
			stderr: stderr.slice(-1200)
		}));
		const write = (payload) => {
			child.stdin?.write(`${JSON.stringify(payload)}\n`);
		};
		write({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: PROBE_CLIENT
			}
		});
		write({
			jsonrpc: "2.0",
			method: "notifications/initialized"
		});
		write({
			jsonrpc: "2.0",
			id: 2,
			method: "tools/list"
		});
	});
}
/** Handshake with one streamable-http server. */
async function probeHttp(server) {
	return withDeadline(async (signal) => {
		try {
			const response = await fetch(server.url, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
					...server.headers
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "initialize",
					params: {
						protocolVersion: "2025-06-18",
						capabilities: {},
						clientInfo: PROBE_CLIENT
					}
				}),
				signal
			});
			const raw = (await response.text()).slice(0, 2e5);
			if (!response.ok) return {
				ok: false,
				stage: "http",
				status: response.status,
				error: `HTTP ${response.status}。${response.status === 401 || response.status === 403 ? "通常是凭证无效或过期。" : ""}`,
				body: raw.slice(0, 600)
			};
			const { serverInfo } = extractInitialize(raw);
			return {
				ok: serverInfo !== null,
				status: response.status,
				serverInfo,
				error: serverInfo === null ? "收到了响应，但没有解析到 MCP 的 initialize 结果。" : void 0,
				body: raw.slice(0, 400)
			};
		} catch (error) {
			const aborted = error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
			return {
				ok: false,
				stage: aborted ? "timeout" : "network",
				error: aborted ? `请求在 ${PROBE_TIMEOUT_MS / 1e3} 秒内没有完成。` : String(error)
			};
		}
	});
}
/** Probe any server, dispatching on its transport. */
function probe(server) {
	return server.transport === "stdio" ? probeStdio(server) : probeHttp(server);
}

//#endregion
//#region src/render.ts
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
/** Generated loader id for one server, with a collision guard. */
function entryIdFor(server, pluginEntryId) {
	const id = `${GENERATED_ID_PREFIX}${server.serverName}`;
	if (id === pluginEntryId) throw new Error(`生成的条目 id 与本插件自身的 bundle id 冲突：${id}`);
	return id;
}
/** Render a YAML scalar as an explicit **string**. */
function yamlString(value) {
	return `'${value.replace(/'/g, "''")}'`;
}
/** Render one server as an `insert` row for the official client. */
function renderRow(server, pluginEntryId) {
	const lines = [
		`    - id: ${yamlString(entryIdFor(server, pluginEntryId))}`,
		`      name: ${yamlString(MCP_CLIENT_PACKAGE)}`,
		"      config:",
		`        transport: ${yamlString(server.transport)}`,
		`        serverName: ${yamlString(server.serverName)}`
	];
	if (server.transport === "streamable-http") {
		lines.push(`        url: ${yamlString(server.url)}`);
		if (Object.keys(server.headers).length > 0) {
			lines.push("        headers:");
			for (const [key, value] of Object.entries(server.headers)) lines.push(`          ${key}: ${yamlString(value)}`);
		}
	} else {
		lines.push(`        command: ${yamlString(server.command)}`);
		if (server.args.length > 0) {
			lines.push("        args:");
			for (const arg of server.args) lines.push(`          - ${yamlString(arg)}`);
		}
		if (Object.keys(server.env).length > 0) {
			lines.push("        env:");
			for (const [key, value] of Object.entries(server.env)) lines.push(`          ${key}: ${yamlString(value)}`);
		}
		if (server.cwd.length > 0) lines.push(`        cwd: ${yamlString(server.cwd)}`);
	}
	lines.push("        toolCallTimeoutMs: 60000");
	lines.push("        reconnect:");
	lines.push("          enabled: true");
	return lines.join("\n");
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
function renderBlock(servers, pluginEntryId) {
	const enabled = servers.filter((server) => server.enabled);
	const rows = enabled.map((server) => `- insert:\n${renderRow(server, pluginEntryId)}`).join("\n");
	return `${`${BLOCK_BEGIN}\n# ${enabled.length} 个已启用的 MCP 服务；此块由 DSH 设置页整体重写。\n`}${rows.length > 0 ? `${rows}\n` : "# （当前没有启用的服务）\n"}${BLOCK_END}\n`;
}

//#endregion
//#region src/model.ts
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
/** Trim and bound one line of user text. */
function oneLine(value, max) {
	return typeof value === "string" ? value.replace(/\r?\n/g, " ").trim().slice(0, max) : "";
}
/**
* Coerce an unknown `key: value` bag into a `{[key: string]: string}` map.
*
* Coercing here means the user can type `PORT=8080` and it just works — the
* value would otherwise reach YAML as a number and fail official validation.
*/
function toStringMap(value, maxKeys) {
	const out = {};
	if (value === null || typeof value !== "object" || Array.isArray(value)) return out;
	for (const [key, raw] of Object.entries(value).slice(0, maxKeys)) {
		const cleanKey = key.trim().slice(0, 128);
		if (cleanKey.length === 0) continue;
		out[cleanKey] = raw === null || raw === void 0 ? "" : String(raw).slice(0, 4096);
	}
	return out;
}
/** Coerce an unknown value onto the known shape, filling gaps from `base`. */
function normalizeServer(value, base) {
	const raw = value ?? {};
	const pick = (key) => key in raw ? raw[key] : base !== null ? base[key] : "";
	const transport = oneLine(pick("transport"), 24);
	const args = Array.isArray(raw.args) ? raw.args.map((item) => oneLine(item, 500)).filter((item) => item.length > 0).slice(0, HARD_LIMITS.args) : Array.isArray(base?.args) ? base.args : [];
	return {
		key: oneLine(pick("key"), 64) || (base?.key ?? ""),
		name: oneLine(pick("name"), 80) || (base?.name ?? ""),
		serverName: (oneLine(pick("serverName"), HARD_LIMITS.serverNameLength) || (base?.serverName ?? "")).replace(/[^A-Za-z0-9_-]/g, "_"),
		transport: TRANSPORTS.includes(transport) ? transport : base?.transport ?? "stdio",
		enabled: typeof raw.enabled === "boolean" ? raw.enabled : base?.enabled ?? false,
		url: oneLine(pick("url"), 500),
		headers: toStringMap(raw.headers, HARD_LIMITS.headerKeys),
		command: oneLine(pick("command"), 500),
		args,
		env: toStringMap(raw.env, HARD_LIMITS.envKeys),
		cwd: oneLine(pick("cwd"), 500),
		note: oneLine(pick("note"), 300),
		updatedAt: Date.now()
	};
}
/** Validate one server against the official client's own rules. */
function validateServer(server, others) {
	const issues = [];
	if (!SERVER_NAME_PATTERN.test(server.serverName)) issues.push({
		field: "serverName",
		problem: "只能包含字母、数字、下划线和连字符，长度 1–32。"
	});
	if (others.some((item) => item.key !== server.key && item.serverName === server.serverName)) issues.push({
		field: "serverName",
		problem: "已被列表里的另一个服务器占用。"
	});
	if (server.transport === "streamable-http") {
		if (!/^https?:\/\//i.test(server.url)) issues.push({
			field: "url",
			problem: "必须是 http(s) 地址。"
		});
	} else if (server.command.length === 0) issues.push({
		field: "command",
		problem: "stdio 传输需要填写要启动的命令。"
	});
	return issues.slice(0, 8);
}
/** Validate the whole list, cross-checking names and generated ids. */
function validateAll(servers, entryIdFor) {
	const problems = {};
	for (const server of servers) {
		const issues = validateServer(server, servers);
		try {
			entryIdFor(server);
		} catch (error) {
			issues.push({
				field: "serverName",
				problem: error.message
			});
		}
		if (issues.length > 0) problems[server.key] = issues;
	}
	return problems;
}

//#endregion
//#region src/identity.ts
/**
* Plugin identity, split out so the loader entry name has exactly one source.
* @module dsh-mcp-hub/identity
*/
/** Loader entry id; must match the `insert` row in cordis.patch.yml. */
const name = "mcp-hub";

//#endregion
//#region src/index.ts
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
const inject = ["webServer"];
/** Send one JSON response with no caching. */
function send(res, status, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"content-length": Buffer.byteLength(body)
	});
	res.end(body);
}
/** Read and parse a bounded JSON request body. */
async function readJson(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buf.length;
		if (size > 512 * 1024) throw new Error("请求体过大");
		chunks.push(buf);
	}
	if (size === 0) return {};
	const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("请求体必须是 JSON 对象");
	return parsed;
}
/**
* Register the settings-page routes.
* @param ctx - the host context (injects `webServer`).
*/
function apply(ctx) {
	const { dataDir, storeFile, profileDir, patchFile, profileSource } = resolveLocations();
	/** All validation flows through one id resolver, so the guard is single-sourced. */
	const idFor = (server) => {
		const id = `${GENERATED_ID_PREFIX}${server.serverName}`;
		if (id === "mcp-hub") throw new Error(`生成的条目 id 与本插件自身的 bundle id 冲突：${id}`);
		return id;
	};
	const issues = (servers) => validateAll(servers, idFor);
	const load = () => {
		try {
			if (!existsSync(storeFile)) return {
				version: 1,
				servers: []
			};
			const raw = JSON.parse(readFileSync(storeFile, "utf8"))?.servers;
			const servers = [];
			if (Array.isArray(raw)) for (const item of raw) {
				const normalized = normalizeServer(item, null);
				if (normalized.key.length > 0 && normalized.serverName.length > 0) servers.push(normalized);
			}
			return {
				version: 1,
				servers
			};
		} catch (error) {
			ctx.logger?.warn?.(`mcp-hub: 读取服务列表失败，按空列表继续: ${String(error)}`);
			return {
				version: 1,
				servers: []
			};
		}
	};
	const persist = (state) => atomicWrite(storeFile, JSON.stringify(state, null, 2));
	const handleStatus = (res) => {
		const state = load();
		const patchText = readPatch(patchFile);
		send(res, 200, {
			ok: true,
			profile: {
				dir: profileDir,
				source: profileSource,
				patchFile
			},
			block: {
				applied: patchText.includes(BLOCK_BEGIN),
				servers: state.servers.filter((s) => s.enabled).length
			},
			officialClient: { package: MCP_CLIENT_PACKAGE },
			counts: {
				total: state.servers.length,
				enabled: state.servers.filter((s) => s.enabled).length
			},
			problems: issues(state.servers),
			dataDir,
			storeFile,
			pluginEntryId: PLUGIN_ENTRY_ID,
			generatedIdPrefix: GENERATED_ID_PREFIX
		});
	};
	const handleList = (res) => {
		const state = load();
		send(res, 200, {
			ok: true,
			servers: state.servers,
			problems: issues(state.servers),
			preview: renderBlock(state.servers, PLUGIN_ENTRY_ID),
			pluginEntryId: PLUGIN_ENTRY_ID,
			generatedIdPrefix: GENERATED_ID_PREFIX
		});
	};
	const handleMutate = async (req, res) => {
		const body = await readJson(req);
		const action = typeof body.action === "string" ? body.action : "";
		const state = load();
		if (action === "upsert") {
			const incoming = body.server;
			const rawKey = incoming !== null && typeof incoming === "object" ? oneLine(incoming.key, 64) : "";
			const existing = rawKey.length > 0 ? state.servers.find((item) => item.key === rawKey) : void 0;
			const entry = normalizeServer(incoming, existing ?? null);
			if (entry.key.length === 0) entry.key = `srv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
			const others = state.servers.filter((item) => item.key !== entry.key);
			const entryIssues = issues([entry, ...others]);
			if (Object.keys(entryIssues).length > 0) {
				send(res, 400, {
					ok: false,
					error: "配置未通过校验。",
					issues: entryIssues
				});
				return;
			}
			state.servers = existing ? state.servers.map((item) => item.key === entry.key ? entry : item) : [...state.servers, entry];
			persist(state);
			send(res, 200, {
				ok: true,
				servers: state.servers,
				key: entry.key,
				problems: issues(state.servers)
			});
			return;
		}
		if (action === "delete") {
			const key = oneLine(body.key, 64);
			state.servers = state.servers.filter((item) => item.key !== key);
			persist(state);
			send(res, 200, {
				ok: true,
				servers: state.servers
			});
			return;
		}
		if (action === "toggle") {
			const key = oneLine(body.key, 64);
			const enabled = body.enabled === true;
			if (!state.servers.some((item) => item.key === key)) {
				send(res, 400, {
					ok: false,
					error: `没有 key 为 ${key} 的服务。`
				});
				return;
			}
			state.servers = state.servers.map((item) => item.key === key ? {
				...item,
				enabled
			} : item);
			persist(state);
			send(res, 200, {
				ok: true,
				servers: state.servers
			});
			return;
		}
		send(res, 400, {
			ok: false,
			error: `未知操作 "${action}"`
		});
	};
	const handleApply = async (req, res) => {
		const detach = (await readJson(req)).enabled === false;
		const state = load();
		if (!detach) {
			const entryIssues = issues(state.servers);
			if (Object.keys(entryIssues).length > 0) {
				send(res, 400, {
					ok: false,
					error: "有服务未通过校验，已阻止写入。",
					problems: entryIssues
				});
				return;
			}
		}
		try {
			const stripped = stripBlock(readPatch(patchFile), BLOCK_BEGIN, BLOCK_END).replace(/\s+$/, "");
			const next = detach ? `${stripped}\n` : `${stripped}\n\n${renderBlock(state.servers, PLUGIN_ENTRY_ID)}\n`;
			atomicWrite(patchFile, next);
		} catch (error) {
			send(res, 500, {
				ok: false,
				error: String(error)
			});
			return;
		}
		const count = detach ? 0 : state.servers.filter((server) => server.enabled).length;
		ctx.logger?.info?.(`mcp-hub: ${detach ? "已移除" : `已写入 ${count} 个`} MCP 服务注册块 (${patchFile})`);
		send(res, 200, {
			ok: true,
			applied: !detach,
			servers: count,
			patchFile,
			restartRequired: true
		});
	};
	const handleProbe = async (req, res) => {
		const key = oneLine((await readJson(req)).key, 64);
		const target = load().servers.find((item) => item.key === key);
		if (target === void 0) {
			send(res, 400, {
				ok: false,
				error: `没有 key 为 ${key} 的服务。`
			});
			return;
		}
		const targetIssues = issues([target]);
		if (Object.keys(targetIssues).length > 0) {
			send(res, 400, {
				ok: false,
				error: "该服务配置未通过校验，无法探测。",
				issues: targetIssues
			});
			return;
		}
		send(res, 200, {
			ok: true,
			result: await probe(target)
		});
	};
	const handler = (req, res) => {
		const run = async () => {
			const path = new URL(req.url ?? "/", "http://x").pathname;
			const method = (req.method ?? "GET").toUpperCase();
			try {
				if (path === `${"/api/mcp-hub"}/status` && method === "GET") return handleStatus(res);
				if (path === `${"/api/mcp-hub"}/servers` && method === "GET") return handleList(res);
				if (path === `${"/api/mcp-hub"}/servers` && method === "POST") return await handleMutate(req, res);
				if (path === `${"/api/mcp-hub"}/apply` && method === "POST") return await handleApply(req, res);
				if (path === `${"/api/mcp-hub"}/probe` && method === "POST") return await handleProbe(req, res);
				send(res, 404, {
					ok: false,
					error: "not found"
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.logger?.warn?.(`mcp-hub: ${message}`);
				if (!res.headersSent) send(res, 500, {
					ok: false,
					error: message
				});
				else res.end();
			}
		};
		return run();
	};
	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: ROUTE_PREFIX,
		handler
	}), "mcp-hub: routes");
	ctx.logger?.info?.(`mcp-hub: 通用 MCP 管理页路由就绪 (${storeFile})`);
}

//#endregion
export { apply, inject, name };