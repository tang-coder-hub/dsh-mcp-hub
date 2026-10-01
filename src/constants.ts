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
export const PLUGIN_ENTRY_ID = 'mcp-hub'

/** Namespace prefix for every loader id this page generates. */
export const GENERATED_ID_PREFIX = 'mcp-hub__'

/** Delimiter pair for the block this plugin owns in the profile patch. */
export const BLOCK_BEGIN = '# >>> mcp-hub (managed by the DSH settings page; edits here are overwritten) >>>'
export const BLOCK_END = '# <<< mcp-hub <<<'

/** The official client plugin this page writes rows for. */
export const MCP_CLIENT_PACKAGE = '@deepseek-ai/dsh-mcp-client'

/** Tool naming the official client uses: `mcp__<serverName>__<rawName>`. */
export const TOOL_PREFIX = 'mcp__'

/** Mirrors the official client's own `serverName` validation. */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** Valid transports, mirroring the official client's config union. */
export const TRANSPORTS = ['stdio', 'streamable-http'] as const

/** Official client default for a single tool call. */
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60000

/** MCP protocol version sent in probes. */
export const MCP_PROTOCOL_VERSION = '2025-06-18'

/** Route prefix for this page's HTTP API. */
export const ROUTE_PREFIX = '/api/mcp-hub'

/** Hard ceilings — config can lower these but never raise them. */
export const HARD_LIMITS = {
  serverNameLength: 32,
  roots: 16,
  maxEntries: 10_000,
  maxDepth: 10,
  maxFileBytes: 10 * 1024 * 1024,
  timeoutSeconds: 300,
  envKeys: 32,
  headerKeys: 16,
  args: 64,
  servers: 64,
} as const

/** Probe deadline; a hung server must not stall the page. */
export const PROBE_TIMEOUT_MS = 20_000

/** Marker probe client identity sent in `initialize`. */
export const PROBE_CLIENT = { name: 'dsh-mcp-hub', version: '1.0.0' } as const

/** Max number of validation issues reported per server. */
export const MAX_ISSUES_PER_SERVER = 8
