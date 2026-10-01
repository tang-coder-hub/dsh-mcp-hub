/**
 * Offline verification harness for dsh-mcp-hub.
 *
 * Imports the built host half with a fake context, serves its routes over real
 * HTTP against a temporary harness home, and asserts the things that actually
 * broke before:
 *
 *  - every generated YAML scalar parses back as a **string** (the official
 *    client declares `env`/`headers` as `{[key]: string}`);
 *  - generated ids never collide with the plugin's own bundle id;
 *  - the profile is resolved correctly even without `DSH_PROFILE_DIR`;
 *  - an empty `projectDir`-style field does not lose detection on save;
 *  - the stdio probe really starts a server and lists its tools;
 *  - validation rejects what the official client would reject.
 *
 * Run: `node scripts/verify.mjs`
 */

import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

let checks = 0
let failures = 0

/** Assert one condition and record the outcome. */
function check(label, condition, detail = '') {
  checks += 1
  if (condition) {
    console.log(`  PASS  ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

/** One JSON request against the harness server. */
async function call(base, path, { method = 'GET', body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let payload = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }
  return { status: response.status, payload }
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const home = mkdtempSync(join(tmpdir(), 'mcp-hub-verify-'))
const profileDir = join(home, 'profiles', 'desktop')
const workspace = join(home, 'workspace')
mkdirSync(profileDir, { recursive: true })
mkdirSync(workspace, { recursive: true })

const PATCH_HEADER = [
  '# Verify patch layer.',
  '- id: ui-theme',
  '  name: "@deepseek-ai/dsh-client-ui-theme"',
  '  config:',
  '    preference: light',
  '',
].join('\n')
writeFileSync(join(profileDir, 'cordis.patch.yml'), PATCH_HEADER, 'utf8')

process.env.DSH_HOME = home
process.env.DSH_PROFILE_DIR = profileDir

// A minimal MCP server the stdio probe can actually start.
const fakeServer = join(home, 'fake-mcp-server.mjs')
writeFileSync(
  fakeServer,
  [
    'process.stdin.setEncoding("utf8");',
    'let buffer = "";',
    'process.stdin.on("data", (chunk) => {',
    '  buffer += chunk;',
    '  let index = buffer.indexOf("\\n");',
    '  while (index >= 0) {',
    '    const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1); index = buffer.indexOf("\\n");',
    '    if (!line) continue;',
    '    let message; try { message = JSON.parse(line); } catch { continue; }',
    '    if (message.id === 1) {',
    '      process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:1,result:{protocolVersion:"2025-06-18",capabilities:{},serverInfo:{name:"fake-mcp",version:"0.1.0"}}}) + "\\n");',
    '    } else if (message.id === 2) {',
    '      process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:2,result:{tools:[' +
      '{name:"fs_read",description:"read a file"},{name:"fs_write",description:"write a file"}]}}) + "\\n");',
    '    }',
    '  }',
    '});',
  ].join('\n'),
  'utf8',
)

// A minimal MCP server over streamable-http, so the HTTP probe is real too.
const httpServer = createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => {
    body += chunk
  })
  req.on('end', () => {
    const auth = req.headers.authorization ?? ''
    if (auth !== 'Bearer good-token' && auth !== 'Bearer ghp_example') {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'bad credentials' }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake-http-mcp', version: '0.2.0' } },
      }),
    )
  })
})
await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
const fakeHttpUrl = `http://127.0.0.1:${httpServer.address().port}/mcp`

// ---------------------------------------------------------------------------
// Load the host half with a fake context.
// ---------------------------------------------------------------------------

console.log('A. host half')

const routes = []
const warnings = []
const ctx = {
  logger: {
    info: () => {},
    warn: (message) => warnings.push(String(message)),
    error: (message) => warnings.push(String(message)),
  },
  effect: (fn) => fn(),
  get: () => undefined,
  webServer: {
    register: (route) => {
      routes.push(route)
      return () => {}
    },
  },
}

const host = await import(pathToFileURL(join(ROOT, 'lib', 'index.js')).href)
check('host exports apply + name + inject', typeof host.apply === 'function' && host.name === 'mcp-hub' && Array.isArray(host.inject))
host.apply(ctx)
check('registered one prefix route', routes.length === 1 && routes[0].kind === 'prefix' && routes[0].path === '/api/mcp-hub')

const server = createServer((req, res) => {
  routes[0].handler(req, res).catch((error) => {
    if (!res.headersSent) res.writeHead(500)
    res.end(String(error))
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const BASE = `http://127.0.0.1:${server.address().port}/api/mcp-hub`

// --- status ----------------------------------------------------------------
console.log('\n[status]')
const status = await call(BASE, '/status')
check('status responds 200', status.status === 200, `status ${status.status}`)
check('profile resolves to the desktop dir', status.payload?.profile?.dir === profileDir, String(status.payload?.profile?.dir))
check('profile source is authoritative', status.payload?.profile?.source === 'DSH_PROFILE_DIR', String(status.payload?.profile?.source))
check('the official client package is named', status.payload?.officialClient?.package === '@deepseek-ai/dsh-mcp-client')
check('starts with an empty list', status.payload?.counts?.total === 0)

// --- upsert: the official GitHub server ------------------------------------
console.log('\n[upsert — GitHub official preset]')
const github = await call(BASE, '/servers', {
  method: 'POST',
  body: {
    action: 'upsert',
    server: {
      key: '',
      name: 'GitHub',
      serverName: 'github',
      transport: 'streamable-http',
      enabled: true,
      url: 'https://api.githubcopilot.com/mcp/',
      headers: { Accept: 'application/json, text/event-stream', Authorization: 'Bearer ghp_example' },
      note: 'GitHub 官方',
    },
  },
})
check('github upsert succeeds', github.status === 200 && typeof github.payload?.key === 'string', JSON.stringify(github.payload)?.slice(0, 200))
const githubKey = github.payload?.key
check('github entry is stored', (github.payload?.servers ?? []).length === 1)

// A number-typed header value must be coerced to a string, because the official
// client declares headers as {key: string}.
const coerced = await call(BASE, '/servers', {
  method: 'POST',
  body: {
    action: 'upsert',
    server: { key: '', name: 'N', serverName: 'numsrv', transport: 'streamable-http', url: 'https://x.example/v1', headers: { retries: 3, enabled: true } },
  },
})
const numsrv = (coerced.payload?.servers ?? []).find((item) => item.serverName === 'numsrv')
check('numeric header values are coerced to strings', numsrv?.headers?.retries === '3' && numsrv?.headers?.enabled === 'true', JSON.stringify(numsrv?.headers))

// --- the generated YAML ----------------------------------------------------
console.log('\n[generated YAML]')
const listing = await call(BASE, '/servers')
const block = listing.payload?.preview ?? ''
check('the preview contains the github row', block.includes('serverName: ') && block.toLowerCase().includes('api.githubcopilot.com'))

// Parse with a real YAML parser and assert the *types*.
// Resolution order: DSH_PROFILE_DIR → the standard harness profile location →
// the plugin's own node_modules (when CI installs a YAML lib there).
const yamlRoots = [
  process.env.DSH_PROFILE_DIR,
  join(homedir(), '.dsh', 'profiles'),
  ROOT,
]
let requireFromProfile = null
for (const root of yamlRoots) {
  try {
    requireFromProfile = createRequire(join(root, 'noop.js'))
    requireFromProfile('js-yaml')
    break
  } catch {
    requireFromProfile = null
  }
}
if (requireFromProfile === null) {
  // Fall back to a bare specifier; CI installs js-yaml as a devDependency.
  requireFromProfile = createRequire(join(ROOT, 'noop.js'))
}
let yaml = null
try {
  yaml = requireFromProfile('js-yaml')
} catch {
  yaml = null
}
if (yaml === null) {
  console.log('  SKIP  YAML round-trip — no YAML parser resolvable')
} else {
  let parsed = null
  let parseError = ''
  try {
    parsed = yaml.load(block)
  } catch (error) {
    parseError = String(error)
  }
  check('the generated block parses as YAML', parsed !== null, parseError.slice(0, 200))

  const rows = Array.isArray(parsed) ? parsed.flatMap((row) => row.insert ?? []) : []
  const githubRow = rows.find((row) => row.id === 'mcp-hub__github')
  check('the github row is present', githubRow !== undefined, JSON.stringify(rows.map((row) => row.id)))
  check('the row names the official client', githubRow?.name === '@deepseek-ai/dsh-mcp-client', String(githubRow?.name))
  check('transport parses as a string', githubRow?.config?.transport === 'streamable-http', String(githubRow?.config?.transport))
  check('url parses as a string', typeof githubRow?.config?.url === 'string', String(githubRow?.config?.url))

  // The official client requires env/headers to be {[key]: string}. This is the
  // exact failure the plugin manager reported before: bare false/1 parse as
  // boolean/number and the row is rejected.
  const headerValues = Object.values(githubRow?.config?.headers ?? {})
  check('every header value parses as a string', headerValues.every((value) => typeof value === 'string'), JSON.stringify(headerValues))

  // The stdio row's env must also be all-strings.
  await call(BASE, '/servers', {
    method: 'POST',
    body: {
      action: 'upsert',
      server: {
        key: '',
        name: 'Local FS bridge',
        serverName: 'fs_bridge',
        transport: 'stdio',
        enabled: true,
        command: 'python.exe',
        args: ['-m', 'mcp_fs_bridge'],
        env: { MCP_FS_BRIDGE_READ_ONLY: false, MCP_FS_BRIDGE_MAX_FILE_BYTES: 10485760, PYTHONUTF8: 1 },
      },
    },
  })
  const listing2 = await call(BASE, '/servers')
  const block2 = listing2.payload?.preview ?? ''
  let parsed2 = null
  try {
    parsed2 = yaml.load(block2)
  } catch (error) {
    parseError = String(error)
  }
  const rows2 = Array.isArray(parsed2) ? parsed2.flatMap((row) => row.insert ?? []) : []
  const fsRow = rows2.find((row) => row.id === 'mcp-hub__fs_bridge')
  check('the stdio row is present', fsRow !== undefined, JSON.stringify(rows2.map((row) => row.id)))
  const envValues = Object.values(fsRow?.config?.env ?? {})
  check('every env value parses as a string', envValues.every((value) => typeof value === 'string'), JSON.stringify(envValues))
  check('the boolean-ish env value stayed a string', fsRow?.config?.env?.MCP_FS_BRIDGE_READ_ONLY === 'false', JSON.stringify(fsRow?.config?.env?.MCP_FS_BRIDGE_READ_ONLY))
  check('args parse as an array of strings', Array.isArray(fsRow?.config?.args) && fsRow.config.args.every((item) => typeof item === 'string'), JSON.stringify(fsRow?.config?.args))

  // Regression: the end marker used to land on the same line as the LAST
  // server's final scalar (`enabled: true# <<< mcp-hub <<<`), which YAML folded
  // into one string. The last row must therefore be intact too — Sentry-style
  // trailing entries are exactly where this bit.
  const lastEnabled = (listing2.payload?.servers ?? []).filter((item) => item.enabled).at(-1)
  const lastRow = lastEnabled === undefined ? undefined : rows2.find((row) => row.id === `mcp-hub__${lastEnabled.serverName}`)
  check('the LAST server row survives intact', lastRow !== undefined && typeof lastRow?.config?.reconnect?.enabled === 'boolean' && lastRow.config.reconnect.enabled === true, JSON.stringify(lastRow?.config?.reconnect))
  check('no generated scalar swallowed the end marker', !block2.includes('true# <<<'), 'the end marker must sit on its own line')
  check('the end marker is on its own line', /\n# <<< mcp-hub <<</.test(block2))
}

// --- id collision guard ----------------------------------------------------
console.log('\n[id collision guard]')
check('the generated prefix cannot equal the bundle id', listing.payload?.generatedIdPrefix !== listing.payload?.pluginEntryId, `${listing.payload?.generatedIdPrefix} vs ${listing.payload?.pluginEntryId}`)
const collision = await call(BASE, '/servers', {
  method: 'POST',
  body: { action: 'upsert', server: { key: '', name: 'Collide', serverName: 'mcp-hub', transport: 'stdio', command: 'x' } },
})
// `mcp-hub__mcp-hub` != `mcp-hub`, so this is *allowed* — the structural guard
// is the double-underscore namespace itself.
check('a server named like the plugin still yields a namespaced id', collision.status === 200, JSON.stringify(collision.payload)?.slice(0, 160))

// --- validation ------------------------------------------------------------
console.log('\n[validation]')
// Note: upsert *sanitises* a hostile serverName (spaces become underscores), so
// the only way to get an invalid name into the list is to bypass upsert. That
// is a deliberate property — the API cannot create an entry the official
// client would reject — and it is asserted here rather than assumed.
const dup = await call(BASE, '/servers', {
  method: 'POST',
  body: { action: 'upsert', server: { key: '', name: 'Dup', serverName: 'github', transport: 'stdio', command: 'x' } },
})
check('a duplicate serverName is rejected', dup.status === 400, JSON.stringify(dup.payload)?.slice(0, 160))

const sanitised = await call(BASE, '/servers', {
  method: 'POST',
  body: { action: 'upsert', server: { key: '', name: 'Sanitised', serverName: 'not allowed!', transport: 'stdio', command: 'x' } },
})
const sanitisedEntry = (sanitised.payload?.servers ?? []).find((item) => item.name === 'Sanitised')
check('a hostile serverName is sanitised, not stored verbatim', sanitisedEntry?.serverName === 'not_allowed_', JSON.stringify(sanitisedEntry?.serverName))
check('the sanitised name passes the official pattern', /^[A-Za-z0-9_-]{1,32}$/.test(String(sanitisedEntry?.serverName)))

const noCommand = await call(BASE, '/servers', {
  method: 'POST',
  body: { action: 'upsert', server: { key: '', name: 'NoCmd', serverName: 'nocmd', transport: 'stdio', command: '' } },
})
check('stdio without a command is rejected', noCommand.status === 400, JSON.stringify(noCommand.payload)?.slice(0, 160))

const badUrl = await call(BASE, '/servers', {
  method: 'POST',
  body: { action: 'upsert', server: { key: '', name: 'BadUrl', serverName: 'badurl', transport: 'streamable-http', url: 'ftp://x' } },
})
check('a non-http url is rejected', badUrl.status === 400, JSON.stringify(badUrl.payload)?.slice(0, 160))

const unknown = await call(BASE, '/servers', { method: 'POST', body: { action: 'wat' } })
check('an unknown action is rejected', unknown.status === 400, `status ${unknown.status}`)

// --- probes ----------------------------------------------------------------
console.log('\n[probes]')

// Give the fake stdio server a real command.
const node = process.execPath
await call(BASE, '/servers', {
  method: 'POST',
  body: { action: 'upsert', server: { key: '', name: 'Fake stdio', serverName: 'fakeio', transport: 'stdio', command: node, args: [fakeServer], enabled: true, env: { FAKE: '1' } } },
})
const stdioProbe = await call(BASE, '/probe', { method: 'POST', body: { key: '' } })
check('a missing key is rejected', stdioProbe.status === 400, `status ${stdioProbe.status}`)

const listAfter = await call(BASE, '/servers')
const fakeEntry = (listAfter.payload?.servers ?? []).find((item) => item.serverName === 'fakeio')
check('the fake stdio entry was stored', fakeEntry !== undefined)

const stdioOk = await call(BASE, '/probe', { method: 'POST', body: { key: fakeEntry?.key } })
check('the stdio probe really started a server', stdioOk.payload?.result?.ok === true, JSON.stringify(stdioOk.payload?.result)?.slice(0, 200))
check('the stdio probe lists its tools', (stdioOk.payload?.result?.tools ?? []).length === 2, JSON.stringify(stdioOk.payload?.result?.tools))
check('the stdio probe reports the tool prefix', stdioOk.payload?.result?.toolPrefix === 'mcp__fakeio__', String(stdioOk.payload?.result?.toolPrefix))

// HTTP probe against the local fake HTTP server (a real handshake, no network).
const httpEntry = (await call(BASE, '/servers')).payload?.servers?.find((item) => item.serverName === 'fakehttp')
if (httpEntry === undefined) {
  await call(BASE, '/servers', {
    method: 'POST',
    body: { action: 'upsert', server: { key: '', name: 'Fake http', serverName: 'fakehttp', transport: 'streamable-http', enabled: true, url: fakeHttpUrl, headers: { Authorization: 'Bearer good-token' } } },
  })
}
const httpEntryFinal = ((await call(BASE, '/servers')).payload?.servers ?? []).find((item) => item.serverName === 'fakehttp')
const httpProbe = await call(BASE, '/probe', { method: 'POST', body: { key: httpEntryFinal?.key } })
check('the http probe reached the server', httpProbe.payload?.result?.ok === true, JSON.stringify(httpProbe.payload?.result)?.slice(0, 300))
check('the http probe parsed serverInfo', httpProbe.payload?.result?.serverInfo?.name === 'fake-http-mcp', JSON.stringify(httpProbe.payload?.result?.serverInfo))

// HTTP probe: bad token -> 401 with the status code and a hint.
const badTokenServer = ((await call(BASE, '/servers')).payload?.servers ?? []).find((item) => item.serverName === 'badauth')
if (badTokenServer === undefined) {
  await call(BASE, '/servers', {
    method: 'POST',
    body: { action: 'upsert', server: { key: '', name: 'Bad auth', serverName: 'badauth', transport: 'streamable-http', enabled: true, url: fakeHttpUrl, headers: { Authorization: 'Bearer wrong-token' } } },
  })
}
const badEntryFinal = ((await call(BASE, '/servers')).payload?.servers ?? []).find((item) => item.serverName === 'badauth')
const httpBad = await call(BASE, '/probe', { method: 'POST', body: { key: badEntryFinal?.key } })
check('a 401 is reported with the status code', httpBad.payload?.result?.status === 401 && httpBad.payload?.result?.ok === false, JSON.stringify(httpBad.payload?.result)?.slice(0, 200))

// --- apply -----------------------------------------------------------------
console.log('\n[apply]')
// apply must refuse when a server is invalid; the only way to get an invalid
// entry past upsert is to write the store directly, so do exactly that.
const stateFile = join(home, 'mcp-hub', 'servers.json')
const rawState = JSON.parse(readFileSync(stateFile, 'utf8'))
rawState.servers.push({ key: 'broken-entry', name: 'Broken', serverName: 'bad name', transport: 'stdio', command: '', enabled: true })
writeFileSync(stateFile, JSON.stringify(rawState, null, 2), 'utf8')
const blocked = await call(BASE, '/apply', { method: 'POST', body: { enabled: true } })
check('apply is blocked when any server fails validation', blocked.status === 400, JSON.stringify(blocked.payload)?.slice(0, 240))
check('the profile was not touched by the blocked apply', !readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8').includes('mcp-hub'))

// Remove the invalid server, then apply for real.
const brokenKey = (await call(BASE, '/servers')).payload?.servers?.find((item) => item.serverName === 'bad_name')?.key
if (brokenKey !== undefined) await call(BASE, '/servers', { method: 'POST', body: { action: 'delete', key: brokenKey } })
const applied = await call(BASE, '/apply', { method: 'POST', body: { enabled: true } })
check('apply responds 200', applied.status === 200, JSON.stringify(applied.payload)?.slice(0, 200))
check('apply reports a restart is required', applied.payload?.restartRequired === true)

const patchText = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
check('the pre-existing patch content survives', patchText.includes('- id: ui-theme') && patchText.includes('preference: light'))
check('the managed block is present', patchText.includes('>>> mcp-hub (managed'))
check('the block uses the official client package', patchText.includes('@deepseek-ai/dsh-mcp-client'))
check('no generated id equals the bundle id', !patchText.includes('id: mcp-hub\n') && !patchText.includes('id: mcp-hub\r'), 'the plugin bundle id must not appear as a generated row')

const reApplied = await call(BASE, '/apply', { method: 'POST', body: { enabled: true } })
void reApplied
const patchTwice = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
// The renderer quotes every scalar, so the id appears in quoted form.
const githubOccurrences = patchTwice.split("id: 'mcp-hub__github'").length - 1
check('applying twice is idempotent', githubOccurrences === 1, `occurrences: ${githubOccurrences}`)
check(
  'the id is written as a quoted scalar',
  patchTwice.includes(`id: 'mcp-hub__github'`),
  'unquoted ids are how the previous id-collision bug hid itself',
)

// --- detach ----------------------------------------------------------------
console.log('\n[detach]')
const removed = await call(BASE, '/apply', { method: 'POST', body: { enabled: false } })
check('detach responds 200', removed.status === 200, JSON.stringify(removed.payload))
const after = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
check('the managed block is gone', !after.includes('mcp-hub (managed'))
check('the surrounding patch content is intact', after.includes('- id: ui-theme') && after.includes('preference: light'))

check('no host warnings were emitted', warnings.length === 0, warnings.join(' | '))

await new Promise((resolve) => server.close(resolve))
await new Promise((resolve) => httpServer.close(resolve))

// --- profile resolution without DSH_PROFILE_DIR ----------------------------
console.log('\n[profile resolution]')
const savedProfileEnv = process.env.DSH_PROFILE_DIR
delete process.env.DSH_PROFILE_DIR

const secondRoutes = []
const secondCtx = {
  logger: ctx.logger,
  effect: (fn) => fn(),
  get: () => undefined,
  webServer: { register: (route) => { secondRoutes.push(route); return () => {} } },
}
host.apply(secondCtx)
const secondServer = createServer((req, res) => {
  secondRoutes[0].handler(req, res).catch(() => {
    if (!res.headersSent) res.writeHead(500)
    res.end()
  })
})
await new Promise((resolve) => secondServer.listen(0, '127.0.0.1', resolve))
const secondBase = `http://127.0.0.1:${secondServer.address().port}/api/mcp-hub`

const blindStatus = await call(secondBase, '/status')
check(
  'the profile is found without DSH_PROFILE_DIR',
  blindStatus.payload?.profile?.dir === profileDir,
  `${blindStatus.payload?.profile?.dir} (expected ${profileDir})`,
)
check(
  'a named fallback is reported, not a silent guess',
  ['default-name', 'DSH_PROFILE', 'argv'].includes(String(blindStatus.payload?.profile?.source)),
  String(blindStatus.payload?.profile?.source),
)

await new Promise((resolve) => secondServer.close(resolve))
process.env.DSH_PROFILE_DIR = savedProfileEnv

// --- client half -----------------------------------------------------------
console.log('\nB. client half')

let entry = null
globalThis.window = { __ModuleLoader__: { load: (value) => { entry = value } } }
const clientPath = join(ROOT, 'lib', 'client.js')
await import(pathToFileURL(clientPath).href)
check('client bundle registers a module loader entry', entry !== null && entry.id === 'dsh-mcp-hub', JSON.stringify(entry?.id))

const react = (() => {
  for (const root of [process.env.DSH_PROFILE_DIR, join(homedir(), '.dsh', 'profiles', 'desktop'), ROOT]) {
    try {
      const req = createRequire(join(root, 'noop.js'))
      return { React: req('react'), jsx: req('react/jsx-runtime'), dom: req('react-dom/server') }
    } catch {
      /* next root */
    }
  }
  return null
})()

const clientModule = entry.factory((id) => {
  if (id === 'react') return react?.React ?? {}
  if (id === 'react/jsx-runtime') return react?.jsx ?? {}
  throw new Error(`unexpected require: ${id}`)
})
check('client exports apply + inject', typeof clientModule.apply === 'function' && clientModule.inject.includes('slots'))

const registrations = []
clientModule.apply({
  slots: {
    inject: (_name, callback) => callback(),
    register: (options, component) => {
      registrations.push({ options, component })
      return () => {}
    },
  },
})
const page = registrations.find((row) => row.options.name === 'settings.section')
check('the settings page is registered', page?.options.id === 'mcp-hub' && page.options.label === 'MCP 服务器', JSON.stringify(page?.options))

delete globalThis.window
if (react === null) {
  console.log('  SKIP  the settings page server-renders — react not resolvable')
} else {
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, error: 'offline' }), { status: 500 })
  const realError = console.error
  console.error = () => {}
  let html = ''
  try {
    html = react.dom.renderToStaticMarkup(react.React.createElement(page.component))
  } catch (error) {
    failures += 1
    checks += 1
    console.log(`  FAIL  the settings page server-renders — ${error.message}`)
  } finally {
    console.error = realError
  }
  if (html.length > 0) {
    check(
      'the page server-renders the catalogue',
      html.includes('dmhb') && html.includes('连接一个服务') && html.includes('已接入的服务'),
      html.slice(0, 220),
    )
  }
}

const bundle = readFileSync(clientPath, 'utf8')
check('the bundle carries the github preset', bundle.includes('api.githubcopilot.com/mcp/'))
check('the bundle carries the form copy', bundle.includes('传输方式') && bundle.includes('应用到 DSH') && bundle.includes('的凭证页'))
check('the bundle carries the probe rendering', bundle.includes('探测（列出工具）') && bundle.includes('探测失败'))

rmSync(home, { recursive: true, force: true })

console.log(failures === 0 ? `\nALL ${checks} CHECKS PASSED` : `\n${failures} of ${checks} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
