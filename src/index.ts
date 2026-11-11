/**
 * dsh-mcp-manager — host half.
 *
 * Manages MCP servers at runtime:
 *  - persists the server list in $DSH_HOME/mcp-servers.json (global, shared by
 *    every profile and session);
 *  - connects/disconnects each server by dynamically mounting a
 *    `@deepseek-ai/dsh-mcp-client` plugin instance via `ctx.plugin(...)`, so the
 *    server's tools appear as `mcp__<serverName>__<rawName>` to every agent;
 *  - exposes a small JSON API on the web server under `/mcp-manager/api/*` for
 *    the browser settings page (the settings-namespace allowlist cannot serve
 *    third-party namespaces, so the UI talks to these routes directly).
 *
 * @module dsh-mcp-manager
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unwatchFile, watchFile, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { apply as mcpClientApply } from '@deepseek-ai/dsh-mcp-client'
import {
  discoverOAuthServerInfo,
  startAuthorization,
  exchangeAuthorization,
  refreshAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js'
import type { Context, Fiber } from '@deepseek-ai/cordis'

/** Optional embedding policy; the manager keeps ownership of routes and connections. */
export interface McpManagerIntegration {
  /** Notify when embedding contributions or availability policy change. */
  subscribe?(listener: () => void): () => void
  /** Hide and refuse host-reserved entries without changing their persisted configuration. */
  isAvailable?(entry: McpServerEntry): boolean
  /** Override activation for this process without changing the saved enable flag. */
  isEnabled?(entry: McpServerEntry): boolean
  /** Product-owned server names. Unlisted servers remain available to every product. */
  products?: {
    /** No active product hides all product-owned servers. */
    active?: string
    servers: Record<string, readonly string[]>
  }
  transformEntry(entry: McpServerEntry, headers?: Record<string, string>): { entry: McpServerEntry; headers?: Record<string, string> }
  authorizeRequest(request: import('node:http').IncomingMessage): boolean
  /**
   * Register a client when none is usable. `configured` is true only for a
   * user-entered client or a dynamically registered client whose recorded
   * redirect URI equals this flow's; otherwise the integration must register a
   * fresh client and report it with `registered: true`.
   */
  prepareOAuthClient(client: { client_id: string; client_secret?: string }, discovery: Awaited<ReturnType<typeof discoverOAuthServerInfo>>, redirectUri: string, configured: boolean): Promise<void | { registered: boolean }>
  /** Ask the embedding product to open an SDK-generated authorization URL. */
  openAuthorizationUrl?(url: URL): Promise<void>
  onReady(start: () => void): () => void
}

/** Host composition options. */
export interface Config {
  /** Wait for an embedding policy before loading configuration or routes. */
  useIntegration?: boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    mcpManagerIntegration: McpManagerIntegration
    /** Same-process access to managed servers; credentials and transports stay private. */
    mcpManager: ManagedMcpServers
  }
}

/** Extend an existing managed connection without opening another transport or OAuth flow. */
export interface ManagedMcpServers {
  servers(): Array<{ serverName: string; status: string; toolCount: number }>
  /** Reconnect and refresh existing authorization without enabling a disabled server or opening OAuth. */
  reconnect(serverName: string, options: { signal: AbortSignal }): Promise<void>
  /** Explicit clicks may enable/connect and authorize; restoration never opens a browser. */
  ensureConnected(serverName: string, options: { interactive: boolean; signal: AbortSignal; onPhase?: (phase: string) => void }): Promise<void>
  tools(serverName: string): ReturnType<Context['tools']['schemas']>
  /** Run one managed tool call with already-parsed arguments in the caller's scope. */
  callTool(serverName: string, execution: ManagedToolCall): Promise<unknown>
}

type ToolBatch = Parameters<Context['tools']['execute']>[0]

/** One managed tool call; the batch executor owns parsing, dispatch and cancellation. */
export interface ManagedToolCall {
  callId: ToolBatch['calls'][number]['id']
  name: string
  arguments: unknown
  signal: AbortSignal
  agent?: ToolBatch['agent']
}

import type {} from '@deepseek-ai/dsh-host-webserver'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'mcp-manager'

/** Required host services. */
export const inject = ['tools', 'webServer']

/** OAuth tokens persisted for a server. */
export interface OAuthTokens {
  accessToken: string
  tokenType?: string
  refreshToken?: string
  expiresAt?: number
  scope?: string
}

/** OAuth configuration attached to an MCP server entry. */
export interface McpServerOAuthConfig {
  clientId?: string
  clientSecret?: string
  /**
   * Set when `clientId` came from dynamic client registration. Authorization
   * servers bind such clients to their registered redirect URI, so a client
   * registered for another port, host or product cannot be reused.
   */
  registeredRedirectUri?: string
  /** `clientId` was entered by the user; never replaced by registration. */
  userProvided?: boolean
  scopes?: string[]
  authorizationServerUrl?: string
  tokens?: OAuthTokens
}

/** One configured MCP server (a slim superset of the mcp-client Config). */
export interface McpServerEntry {
  /** Namespace for model-facing tool names (`mcp__<serverName>__<rawName>`). */
  serverName: string
  /** `stdio` spawns a child process; `streamable-http` talks HTTP/SSE. */
  transport: 'stdio' | 'streamable-http'
  /** streamable-http: MCP endpoint URL. */
  url?: string
  /** streamable-http: extra request headers (e.g. auth tokens). */
  headers?: Record<string, string>
  /** stdio: executable to spawn. */
  command?: string
  /** stdio: arguments passed directly, without shell interpolation. */
  args?: string[]
  /** stdio: extra env vars. */
  env?: Record<string, string>
  /** stdio: working directory for the child process. */
  cwd?: string
  /** Per-tool-call timeout in milliseconds. */
  toolCallTimeoutMs?: number
  /** Reject plugin activation when the initial connection fails. */
  failOnStartupError?: boolean
  /** Whether this server should be connected. Disabled servers stay disconnected. */
  enabled?: boolean
  /** Authentication mode: 'none' (or static headers) | 'oauth'. */
  authType?: 'none' | 'oauth'
  /** OAuth 2.0 / MCP spec configuration and tokens. */
  oauth?: McpServerOAuthConfig
}

/**
 * Settings saves carry the whole OAuth object back. Registration metadata and
 * tokens are manager-owned: keep them only while the client ID is unchanged;
 * a newly typed client ID is user-provided and starts without tokens.
 */
function reconcileOAuthClient(previous: McpServerOAuthConfig | undefined, incoming: McpServerOAuthConfig): McpServerOAuthConfig {
  const { registeredRedirectUri: _redirect, userProvided: _user, tokens: _tokens, clientSecret: _secret, ...fields } = incoming
  if (!fields.clientId) {
    // Clearing the field asks for automatic registration on the next sign-in;
    // the current tokens keep working until then.
    const { clientId: _id, ...rest } = fields
    return { ...rest, ...(previous?.tokens ? { tokens: previous.tokens } : {}) }
  }
  if (previous?.clientId === fields.clientId) {
    return {
      ...fields,
      ...(previous.clientSecret ? { clientSecret: previous.clientSecret } : {}),
      ...(previous.registeredRedirectUri ? { registeredRedirectUri: previous.registeredRedirectUri } : {}),
      ...(previous.userProvided ? { userProvided: true } : {}),
      ...(previous.tokens ? { tokens: previous.tokens } : {}),
    }
  }
  return { ...fields, ...(incoming.clientSecret ? { clientSecret: incoming.clientSecret } : {}), userProvided: true }
}

/** The persisted file shape. */
export interface StoredState {
  version: 1
  servers: McpServerEntry[]
  /**
   * Optional access token for the `/mcp-manager/*` API. When set, every
   * request must carry `Authorization: Bearer <token>`. When unset and the
   * web server binds to a non-loopback address, mutating requests are
   * rejected (the audit-mitigating posture).
   */
  token?: string
}

const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/
const MAX_BODY_BYTES = 1_000_000

/**
 * Plugin version surfaced by the health endpoint. Injected at build time from
 * package.json (`__DSH_MCP_MANAGER_VERSION__`), so package.json is the single
 * source of truth — bump it there and rebuild.
 */
declare const __DSH_MCP_MANAGER_VERSION__: string
const VERSION = __DSH_MCP_MANAGER_VERSION__

/** Probe cache TTL: reachability of streamable-http servers, refreshed at most this often. */
const PROBE_TTL_MS = 5_000
/** Per-probe timeout: an endpoint that hangs longer counts as unreachable. */
const PROBE_TIMEOUT_MS = 2_500
/** A server stuck in "connecting" for longer than this is reported as a timeout. */
const CONNECT_TIMEOUT_MS = 30_000
/** Config-file watcher poll interval (fs.watchFile polls; robust across platforms). */
const FILE_WATCH_INTERVAL_MS = 1_000
/** Debounce for externally triggered config reloads. */
const RELOAD_DEBOUNCE_MS = 300

/** Absolute path of the shared server list. */
export function storePath(): string {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'mcp-servers.json')
}

function loadState(path: string): StoredState {
  try {
    if (!existsSync(path)) return { version: 1, servers: [] }
    // Strip a UTF-8 BOM if present: Windows editors and PowerShell 5.1's
    // `-Encoding UTF8` write one, and JSON.parse rejects it, which would
    // silently degrade the whole list to empty.
    const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '')
    const raw: unknown = JSON.parse(text)
    if (
      raw !== null && typeof raw === 'object' &&
      Array.isArray((raw as StoredState).servers)
    ) return raw as StoredState
    return { version: 1, servers: [] }
  } catch (err) {
    console.error(`mcp-manager: cannot read ${path}: ${String(err)} — starting with an empty list`)
    return { version: 1, servers: [] }
  }
}

function saveState(path: string, state: StoredState): void {
  const tmp = `${path}.tmp`
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
}

/** Project the manager entry onto the mcp-client Config shape. */
function toMcpConfig(entry: McpServerEntry, resolvedHeaders?: Record<string, string>, integration?: McpManagerIntegration): unknown {
  if (integration) ({ entry, headers: resolvedHeaders } = integration.transformEntry(entry, resolvedHeaders))
  const base = {
    serverName: entry.serverName,
    transport: entry.transport,
    toolCallTimeoutMs: entry.toolCallTimeoutMs,
    // Surface an initial connection failure as an "error" status instead of an
    // endless "connecting": with failOnStartupError the first connect failure
    // rejects the fiber, which the manager records and the UI shows. Later
    // drops after a successful start still auto-reconnect (mcp-client keeps
    // its supervisor running; the flag only gates the initial await).
    failOnStartupError: entry.failOnStartupError ?? true,
  }
  return entry.transport === 'stdio'
    ? { ...base, command: entry.command, args: entry.args, env: entry.env, cwd: entry.cwd }
    : { ...base, url: entry.url, headers: resolvedHeaders ?? entry.headers }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

/**
 * The manager plugin. One instance per process; it owns the server list, the
 * live connection map, and the `/mcp-manager/api/*` routes.
 */
export function apply(ctx: Context, config: Config = {}): void {
  if (config.useIntegration) {
    ctx.inject(['mcpManagerIntegration'], scope => applyManager(scope, scope.mcpManagerIntegration))
  } else {
    applyManager(ctx)
  }
}

function applyManager(ctx: Context, integration?: McpManagerIntegration): void {
  const path = storePath()
  const state = loadState(path)
  const products = integration?.products
  const productServers = new Set(Object.values(products?.servers ?? {}).flat())
  const activeServers = new Set(products?.active === undefined ? [] : products.servers[products.active] ?? [])
  const available = (serverName: string, entry = state.servers.find(server => server.serverName === serverName)): boolean =>
    (!productServers.has(serverName) || activeServers.has(serverName)) && (!entry || integration?.isAvailable?.(entry) !== false)
  // Keep the complete file in memory so saving one product never removes another's entries.
  const visibleEntries = (): McpServerEntry[] => state.servers.filter(entry => available(entry.serverName, entry))
  const isEnabled = (entry: McpServerEntry): boolean => integration?.isEnabled?.(entry) ?? entry.enabled !== false

  // Cordis log records are not necessarily forwarded to an embedding host.
  // stderr is the host-visible diagnostic channel in both Debug and Release.
  // Severity belongs to the record, independently of its output stream.
  type DiagnosticLevel = 'INFO' | 'WARN' | 'ERROR'
  const manualDiagnosticsUntil = new Map<string, number>()
  function diagnostic(serverName: string, phase: string, detail = '', level: DiagnosticLevel = 'INFO'): void {
    if (phase === 'reconnect-requested' || phase === 'ui-click') manualDiagnosticsUntil.set(serverName, Date.now() + 180_000)
    if ((manualDiagnosticsUntil.get(serverName) ?? 0) <= Date.now()) {
      manualDiagnosticsUntil.delete(serverName)
      return
    }
    const entry = state.servers.find(server => server.serverName === serverName)
    const secrets = [state.token, entry?.oauth?.clientSecret, entry?.oauth?.tokens?.accessToken,
      entry?.oauth?.tokens?.refreshToken, ...Object.values(entry?.headers ?? {}), ...Object.values(entry?.env ?? {})]
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .sort((a, b) => b.length - a.length)
    for (const secret of secrets) detail = detail.split(secret).join('[redacted]')
    detail = detail.replace(/https?:\/\/[^\s"'<>]+/gi, '[url]')
      .replace(/Bearer\s+\S+|\b(?:sk|ck|ds)-[A-Za-z0-9_-]+/gi, '[redacted]')
      .replace(/(["']?(?:[\w-]*(?:token|secret|password|authorization|cookie)|api[_-]?key|code|state)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1[redacted]')
      .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 600)
    const safeName = SERVER_NAME_PATTERN.test(serverName) ? serverName : 'unknown'
    process.stderr.write(`[MCP][${level}] server=${safeName} phase=${phase}${detail ? ` ${detail}` : ''}\n`)
    if (phase === 'ui-connected' || phase === 'ui-failed' || phase === 'ui-cancelled') manualDiagnosticsUntil.delete(serverName)
  }

  // SDK errors can contain response bodies, headers or authorization URLs.
  // Extract known failure codes; never forward their arbitrary message/body.
  function diagnosticError(error: unknown): string {
    const cause = (error as { cause?: unknown } | null)?.cause
    const text = `${String(error)} ${String(cause ?? '')}`
    const type = error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name) ? error.name : 'UnknownError'
    const code = text.match(/\b(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|CERT_HAS_EXPIRED|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UND_ERR_CONNECT_TIMEOUT)\b/)?.[0]
    const oauth = text.match(/\b(?:invalid_grant|invalid_token|invalid_client|unauthorized_client|access_denied|invalid_scope|server_error|temporarily_unavailable)\b/i)?.[0].toLowerCase()
    const status = text.match(/(?:\bHTTP|\bstatus(?:\s+code)?|\bSSE error)[^\d\r\n]{0,32}([45]\d\d)\b/i)?.[1]
    const reason = /timeout|timed out|超时/i.test(text) ? 'timeout'
      : /client\s*id|client_id/i.test(text) ? 'oauth-client'
      : /OAuth|unauthorized|授权|\b401\b/i.test(text) ? 'authorization'
      : /fetch failed|network|socket|connect/i.test(text) ? 'transport' : 'operation'
    return `errorType=${type} reason=${reason}${code ? ` code=${code}` : ''}${status ? ` httpStatus=${status}` : ''}${oauth ? ` oauthError=${oauth}` : ''}`
  }

  // SDK-supported fetch injection records transport metadata without reading bodies,
  // headers, authorization URLs or credentials, and returns the original response.
  function diagnosticFetch(serverName: string, phase: string): typeof fetch {
    return async (input, init) => {
      const started = Date.now()
      try {
        const response = await fetch(input, init)
        diagnostic(serverName, phase, `httpStatus=${response.status} redirected=${response.redirected} elapsedMs=${Date.now() - started}`,
          response.ok ? 'INFO' : 'WARN')
        return response
      } catch (error) {
        diagnostic(serverName, phase, `elapsedMs=${Date.now() - started} ${diagnosticError(error)}`, 'ERROR')
        throw error
      }
    }
  }

  /** Whether the web server is reachable beyond loopback (needs an access token). */
  const exposed = ctx.webServer.host !== '127.0.0.1'
  const hasToken = typeof state.token === 'string' && state.token !== ''

  // ── access control for /mcp-manager/* ───────────────────────────────────────
  function safeEqual(a: string, b: string): boolean {
    const ha = createHash('sha256').update(a).digest()
    const hb = createHash('sha256').update(b).digest()
    return timingSafeEqual(ha, hb)
  }

  function isAuthorized(req: import('node:http').IncomingMessage): boolean {
    if (hasToken) {
      const header = req.headers.authorization
      if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false
      return safeEqual(header.slice('Bearer '.length), state.token as string)
    }
    return !exposed
  }

  function authError(): { status: number; message: string } {
    if (exposed && !hasToken) {
      return {
        status: 403,
        message: 'access denied: the web server is network-exposed and no access token is configured — set "token" in $DSH_HOME/mcp-servers.json, then restart',
      }
    }
    return { status: 401, message: 'unauthorized: send "Authorization: Bearer <token>" (set "token" in $DSH_HOME/mcp-servers.json)' }
  }

  /** serverName → live mcp-client fiber. */
  const fibers = new Map<string, Fiber>()
  /** serverName → last start failure message. */
  const errors = new Map<string, string>()
  /** serverName → cached reachability probe result for streamable-http servers. */
  const probeCache = new Map<string, { reachable: boolean; at: number }>()
  /** serverName → when its current connect attempt started (connecting-timeout heuristic). */
  const connectingSince = new Map<string, number>()
  /** serverName → serialized operation chain (prevents connect/disconnect races). */
  const queues = new Map<string, Promise<void>>()
  const reportedTimeouts = new Set<string>()

  /** Pending OAuth authorization sessions keyed by state. */
  interface PendingOAuthSession {
    state: string
    serverName: string
    url: string
    codeVerifier: string
    redirectUri: string
    resource: string
    authorizationServerUrl: string
    metadata?: any
    clientInformation: { client_id: string; client_secret?: string }
    /** Redirect URI the client was dynamically registered with, if any. */
    registeredRedirectUri?: string
    /** The client ID was entered by the user rather than registered. */
    userProvided?: boolean
    createdAt: number
  }
  const pendingOAuthSessions = new Map<string, PendingOAuthSession>()
  // The system browser has no WebView opener. Keep a short-lived result for
  // the initiating settings page to observe without exposing any credentials.
  const oauthResults = new Map<string, {
    serverName: string; status: 'pending' | 'authorized' | 'error'; error?: string; createdAt: number; lastDiagnosticAt?: number
  }>()
  const authorizationJobs = new Map<string, Promise<void>>()
  const lifetime = new AbortController()

  // Both the settings page and an explicit capability click use this same
  // PKCE flow, callback, token store and managed connection.
  async function beginOAuth(body: {
    serverName: string; url?: string; clientId?: string; clientSecret?: string; scopes?: string[]; redirectUri?: string
  }, defaultRedirectUri: string) {
    diagnostic(body.serverName, 'oauth-start')
    const entry = findEntry(body.serverName)
    const targetUrl = body.url || entry?.url
    if (!targetUrl || !available(body.serverName, { ...entry, serverName: body.serverName, transport: 'streamable-http', url: targetUrl }))
      throw new Error('MCP server is unavailable for authorization.')
    const serverInfo = await discoverOAuthServerInfo(targetUrl).catch(() => ({
      authorizationServerUrl: targetUrl, authorizationServerMetadata: undefined, resourceMetadata: undefined,
    }))
    const authServerUrl = serverInfo.authorizationServerUrl || targetUrl
    const redirectUri = body.redirectUri || defaultRedirectUri
    const saved = entry?.oauth
    // A client ID typed into the form (different from the saved one) is the
    // user's choice. A saved client is reused only when it cannot have been
    // bound to another redirect URI: the user entered it, it was dynamically
    // registered for exactly this URI, or the server offers no registration
    // (so a pre-registered client is the only option). Any other saved client —
    // registered for another sidecar port or host, or migrated from another
    // product without a record — is rejected by the authorization server
    // before sign-in, so a fresh client is registered instead.
    const userClient = body.clientId && body.clientId !== saved?.clientId ? body.clientId : undefined
    const canRegister = Boolean(serverInfo.authorizationServerMetadata?.registration_endpoint)
    const keepSaved = !userClient && Boolean(saved?.clientId) && (
      saved?.userProvided === true
      || saved?.registeredRedirectUri === redirectUri
      || (saved?.registeredRedirectUri === undefined && !canRegister))
    const clientInformation = {
      client_id: userClient || (keepSaved ? saved!.clientId! : 'dsh-mcp-manager'),
      client_secret: userClient ? body.clientSecret : (keepSaved ? saved?.clientSecret : undefined),
    }
    const prepared = await integration?.prepareOAuthClient(clientInformation, serverInfo, redirectUri, Boolean(userClient || keepSaved))
    diagnostic(body.serverName, 'oauth-client-ready', `registration=${prepared && prepared.registered ? 'new' : 'reused'}`)
    const registration: Pick<PendingOAuthSession, 'registeredRedirectUri' | 'userProvided'> = userClient
      ? { userProvided: true }
      : prepared && prepared.registered
        ? { registeredRedirectUri: redirectUri }
        : keepSaved
          ? { registeredRedirectUri: saved?.registeredRedirectUri, userProvided: saved?.userProvided }
          : {}
    if (saved?.clientId && !keepSaved && !userClient)
      ctx.logger.info(`mcp-manager: "${body.serverName}" OAuth client ${saved.clientId} is not registered for ${redirectUri}; registered ${clientInformation.client_id}`)
    const resource = serverInfo.resourceMetadata?.resource || targetUrl
    const stateVal = randomBytes(16).toString('hex')
    const { authorizationUrl, codeVerifier } = await startAuthorization(authServerUrl, {
      metadata: serverInfo.authorizationServerMetadata, clientInformation, redirectUrl: redirectUri,
      scope: body.scopes?.join(' ') || entry?.oauth?.scopes?.join(' '), state: stateVal, resource: new URL(resource),
    })
    pendingOAuthSessions.set(stateVal, {
      state: stateVal, serverName: body.serverName, url: targetUrl, codeVerifier, redirectUri, resource,
      authorizationServerUrl: authServerUrl, metadata: serverInfo.authorizationServerMetadata,
      clientInformation, ...registration, createdAt: Date.now(),
    })
    oauthResults.set(stateVal, { serverName: body.serverName, status: 'pending', createdAt: Date.now() })
    return { ok: true, authorizationUrl: authorizationUrl.toString(), state: stateVal, redirectUri }
  }

  /** Resolve dynamic headers for an entry (e.g. injecting or refreshing OAuth access tokens). */
  async function resolveEntryHeaders(entry: McpServerEntry, onSave?: () => void): Promise<Record<string, string>> {
    const headers: Record<string, string> = { ...(entry.headers ?? {}) }
    if (entry.authType === 'oauth' && entry.oauth?.tokens?.accessToken) {
      const tokens = entry.oauth.tokens
      // Refresh token automatically if expiring within 60 seconds
      if (tokens.refreshToken && tokens.expiresAt && Date.now() > tokens.expiresAt - 60_000) {
        const started = Date.now()
        diagnostic(entry.serverName, 'oauth-refresh-start')
        let stage = 'discovery'
        try {
          const authServerUrl = entry.oauth.authorizationServerUrl || entry.url || ''
          if (authServerUrl) {
            const discovered = await discoverOAuthServerInfo(entry.url || authServerUrl,
              { fetchFn: diagnosticFetch(entry.serverName, 'oauth-discovery-http') })
            diagnostic(entry.serverName, 'oauth-discovery-complete', `metadata=${Boolean(discovered.authorizationServerMetadata)}`)
            stage = 'token-refresh'
            const refreshed = await refreshAuthorization(authServerUrl, {
              metadata: discovered.authorizationServerMetadata,
              clientInformation: {
                client_id: entry.oauth.clientId || 'dsh-mcp-manager',
                client_secret: entry.oauth.clientSecret,
              },
              refreshToken: tokens.refreshToken,
              resource: entry.url ? new URL(discovered.resourceMetadata?.resource || entry.url) : undefined,
              fetchFn: diagnosticFetch(entry.serverName, 'oauth-refresh-http'),
            })
            if (refreshed.access_token) {
              tokens.accessToken = refreshed.access_token
              if (refreshed.refresh_token) tokens.refreshToken = refreshed.refresh_token
              if (refreshed.expires_in) tokens.expiresAt = Date.now() + refreshed.expires_in * 1000
              if (onSave) onSave()
              diagnostic(entry.serverName, 'oauth-refresh-complete', `elapsedMs=${Date.now() - started}`)
            }
          }
        } catch (err) {
          diagnostic(entry.serverName, 'oauth-refresh-failed', `stage=${stage} elapsedMs=${Date.now() - started} ${diagnosticError(err)}`, 'ERROR')
          ctx.logger.warn(`mcp-manager: token refresh failed for "${entry.serverName}": ${String(err)}`)
          throw new Error(`服务器「${entry.serverName}」的 OAuth 授权刷新失败，请重新授权后连接。`)
        }
      }
      headers['Authorization'] = `Bearer ${tokens.accessToken}`
    }
    return headers
  }

  /** Serialize per-server mutations: each op waits for the previous one to finish. */
  function enqueue<T>(serverName: string, fn: () => Promise<T>): Promise<T> {
    const prev = queues.get(serverName) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    queues.set(serverName, next.then(() => {}, () => {}))
    return next
  }

  async function connectNow(entry: McpServerEntry, attempt = 1): Promise<void> {
    if (!isEnabled(entry) || !available(entry.serverName, entry)) return
    if (fibers.has(entry.serverName)) return
    errors.delete(entry.serverName)
    connectingSince.set(entry.serverName, Date.now())
    reportedTimeouts.delete(entry.serverName)
    const started = Date.now()
    diagnostic(entry.serverName, 'connect-start', `transport=${entry.transport} attempt=${attempt}`)

    // If OAuth is configured but no access token is available, mark as error/awaiting auth
    if (entry.authType === 'oauth' && !entry.oauth?.tokens?.accessToken) {
      errors.set(entry.serverName, '需要 OAuth 授权登录：请在配置中完成授权')
      connectingSince.delete(entry.serverName)
      diagnostic(entry.serverName, 'connect-auth-required', '', 'WARN')
      return
    }

    try {
      const resolvedHeaders = await resolveEntryHeaders(entry, () => saveState(path, state))
      const fiber = ctx.plugin(mcpClientApply, toMcpConfig(entry, resolvedHeaders, integration) as any)
      fibers.set(entry.serverName, fiber)
      await fiber
      const status = statusOf(entry)
      diagnostic(entry.serverName, 'connect-complete', `status=${status.status} tools=${status.toolCount} elapsedMs=${Date.now() - started}`, status.status === 'error' ? 'ERROR' : 'INFO')
    } catch (err) {
      fibers.delete(entry.serverName)
      const cause = (err as { cause?: unknown } | null)?.cause
      const message = err instanceof Error ? err.message : String(err)
      const detail = cause !== undefined && cause !== null ? `${message}（原因: ${String(cause)}）` : message
      errors.set(entry.serverName, detail)
      connectingSince.delete(entry.serverName)
      diagnostic(entry.serverName, 'connect-failed', `elapsedMs=${Date.now() - started} ${diagnosticError(err)}`, 'ERROR')
      ctx.logger.error(`mcp-manager: server "${entry.serverName}" failed to start: ${detail}`)
    }
  }

  async function disconnectNow(serverName: string): Promise<void> {
    const started = Date.now()
    diagnostic(serverName, 'disconnect-start')
    const fiber = fibers.get(serverName)
    if (!fiber) { diagnostic(serverName, 'disconnect-complete', 'connection=absent'); return }
    fibers.delete(serverName)
    errors.delete(serverName)
    probeCache.delete(serverName)
    connectingSince.delete(serverName)
    const stalled = setTimeout(() => diagnostic(serverName, 'disconnect-pending', `elapsedMs=${Date.now() - started}`, 'WARN'), CONNECT_TIMEOUT_MS)
    stalled.unref()
    try {
      await fiber.dispose()
      diagnostic(serverName, 'disconnect-complete', `elapsedMs=${Date.now() - started}`)
    } catch (err) {
      diagnostic(serverName, 'disconnect-failed', `elapsedMs=${Date.now() - started} ${diagnosticError(err)}`, 'ERROR')
      ctx.logger.warn(`mcp-manager: disposing server "${serverName}" reported: ${String(err)}`)
    } finally { clearTimeout(stalled) }
  }

  /** Enqueued connect: serialized with other mutations of the same server. */
  function connect(entry: McpServerEntry, attempt = 1): Promise<void> {
    if (!available(entry.serverName, entry)) return Promise.resolve()
    return enqueue(entry.serverName, () => connectNow(entry, attempt))
  }

  /** Enqueued disconnect: serialized with other mutations of the same server. */
  function disconnect(serverName: string): Promise<void> {
    return enqueue(serverName, () => disconnectNow(serverName))
  }

  /** Live status of one server: connected / connecting / error / disabled / disconnected. */
  function statusOf(entry: McpServerEntry): { status: string; toolCount: number; error?: string } {
    if (!isEnabled(entry)) return { status: 'disabled', toolCount: 0 }
    const error = errors.get(entry.serverName)
    if (error !== undefined) {
      connectingSince.delete(entry.serverName)
      return { status: 'error', toolCount: 0, error }
    }
    const mounted = fibers.has(entry.serverName)
    const since = connectingSince.get(entry.serverName)
    if (!mounted && since === undefined) return { status: 'disconnected', toolCount: 0 }
    const prefix = `mcp__${entry.serverName}__`
    const toolCount = mounted ? ctx.tools.schemas().filter(schema => schema.name.startsWith(prefix)).length : 0
    if (toolCount > 0) {
      connectingSince.delete(entry.serverName)
      return { status: 'connected', toolCount }
    }
    if (since !== undefined && Date.now() - since > CONNECT_TIMEOUT_MS) {
      if (!reportedTimeouts.has(entry.serverName)) {
        reportedTimeouts.add(entry.serverName)
        diagnostic(entry.serverName, 'connect-timeout', `elapsedMs=${Date.now() - since}`, 'WARN')
      }
      return { status: 'error', toolCount: 0, error: `连接超时（超过 ${Math.round(CONNECT_TIMEOUT_MS / 1000)} 秒未建立连接）` }
    }
    return { status: 'connecting', toolCount }
  }

  // Consumers borrow the existing ToolRuntime bridge. Credentials and transports
  // remain private; only explicit user interaction may request authorization.
  const requireConnected = (serverName: string): void => {
    const entry = visibleEntries().find(candidate => candidate.serverName === serverName)
    if (!entry || statusOf(entry).status !== 'connected') {
      throw new Error(`MCP server "${serverName}" is unavailable; enable and authorize it in MCP settings.`)
    }
  }
  ctx.provide('mcpManager', {
    servers: () => visibleEntries().map(entry => {
      const { status, toolCount } = statusOf(entry)
      return { serverName: entry.serverName, status, toolCount }
    }),
    async reconnect(serverName, { signal }) {
      signal.throwIfAborted()
      const entry = visibleEntries().find(candidate => candidate.serverName === serverName)
      if (!entry) throw new Error('The managed MCP server is unavailable in this product.')
      if (!isEnabled(entry)) { requireConnected(serverName); return }
      const connection = enqueue(serverName, async () => {
        await disconnectNow(serverName)
        await connectNow(entry)
      })
      const waiting = new AbortController()
      try {
        await Promise.race([
          connection,
          delay(CONNECT_TIMEOUT_MS, undefined, { signal: AbortSignal.any([signal, waiting.signal]) }).then(() => {
            throw new Error('MCP connection timed out; retry in MCP settings.')
          }),
        ])
      } finally { waiting.abort() }
      while (statusOf(entry).status === 'connecting')
        await delay(250, undefined, { signal })
      if (statusOf(entry).status !== 'connected')
        throw new Error(statusOf(entry).error || 'MCP connection failed; retry in MCP settings.')
    },
    async ensureConnected(serverName, { interactive, signal, onPhase }) {
      signal.throwIfAborted()
      const entry = visibleEntries().find(candidate => candidate.serverName === serverName)
      if (!entry) throw new Error('The managed MCP server is unavailable in this product.')
      if (statusOf(entry).status === 'connected') return
      if (!interactive) { requireConnected(serverName); return }
      let job = authorizationJobs.get(serverName)
      if (job) onPhase?.('authorizing')
      else {
        job = (async () => {
          const waitSignal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(180000)])
          if (!isEnabled(entry)) { entry.enabled = true; saveState(path, state) }
          let failure: unknown
          try { await connect(entry) } catch (error) { failure = error }
          const connectionDeadline = Date.now() + CONNECT_TIMEOUT_MS
          while (statusOf(entry).status === 'connecting' && Date.now() < connectionDeadline && !failure)
            await delay(250, undefined, { signal: waitSignal })
          if (statusOf(entry).status === 'connected') return
          const message = failure instanceof Error ? failure.message : statusOf(entry).error ?? ''
          if (entry.authType !== 'oauth' || (entry.oauth?.tokens?.accessToken && !/OAuth|\b401\b|unauthorized|invalid[_ ]token|invalid_grant/i.test(message)))
            throw new Error(message || 'The managed MCP server could not connect.')
          if (!integration?.openAuthorizationUrl) throw new Error('Complete OAuth authorization in MCP settings.')
          const authorization = await beginOAuth({ serverName }, `http://127.0.0.1:${ctx.webServer.port}/mcp-manager/api/oauth/callback`)
          try {
            waitSignal.throwIfAborted()
            if (!visibleEntries().some(candidate => candidate.serverName === serverName && isEnabled(candidate))) throw new Error('The managed MCP server is unavailable.')
            onPhase?.('authorizing')
            await integration.openAuthorizationUrl(new URL(authorization.authorizationUrl))
            while (statusOf(entry).status !== 'connected') {
              await delay(500, undefined, { signal: waitSignal })
              if (!visibleEntries().some(candidate => candidate.serverName === serverName && isEnabled(candidate))) throw new Error('The managed MCP server is unavailable.')
              const result = oauthResults.get(authorization.state)
              if (result?.status === 'error' || (result?.status === 'authorized' && statusOf(entry).status === 'error'))
                throw new Error('OAuth authorization or connection failed; retry in MCP settings.')
            }
          } finally { pendingOAuthSessions.delete(authorization.state) }
        })().finally(() => { authorizationJobs.delete(serverName) })
        authorizationJobs.set(serverName, job)
      }
      // Cancelling a capability removes only its waiter; another session may
      // still be using the manager-owned authorization/connection.
      let abort: () => void
      try {
        await Promise.race([job, new Promise<never>((_, reject) => {
          abort = () => reject(signal.reason)
          signal.addEventListener('abort', abort, { once: true })
          if (signal.aborted) abort()
        })])
      } finally { signal.removeEventListener('abort', abort!) }
    },
    tools(serverName) {
      requireConnected(serverName)
      return ctx.tools.schemas().filter(tool => tool.name.startsWith(`mcp__${serverName}__`))
    },
    async callTool(serverName, execution) {
      requireConnected(serverName)
      if (!execution.name.startsWith(`mcp__${serverName}__`)
        || ctx.tools.get(execution.name) === undefined
        || ctx.tools.get(execution.name) !== ctx.tools.get(execution.name, execution.agent)) {
        throw new Error('The managed MCP tool is not available in this execution scope.')
      }
      const { callId, name, signal, agent } = execution
      const batch = await ctx.tools.execute({
        calls: [{ type: 'tool-call', id: callId, name, arguments: JSON.stringify(execution.arguments ?? {}) }],
        signal,
        ...(agent === undefined ? {} : { agent }),
      })
      const result = batch.results[0]?.result
      if (result === undefined) throw new Error('Managed MCP tool produced no result.')
      if (result.isError) {
        throw new Error(result.content.filter(block => block.type === 'text').map(block => block.text).join('\n') || 'Managed MCP tool failed.')
      }
      return result.value
    },
  })

  /**
   * Cheap reachability check for streamable-http servers: a GET that gets any
   * HTTP response (including 4xx/5xx) proves the process is up, without
   * opening an MCP session (which some single-client servers reject). stdio
   * servers are not probed (the child process is owned by mcp-client).
   */
  async function probeReachable(entry: McpServerEntry): Promise<boolean> {
    if (entry.transport !== 'streamable-http' || entry.url === undefined) return true
    const cached = probeCache.get(entry.serverName)
    if (cached !== undefined && Date.now() - cached.at < PROBE_TTL_MS) return cached.reachable
    let reachable = false
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
    try {
      const probeHeaders: Record<string, string> = { Accept: 'application/json', ...(entry.headers ?? {}) }
      if (entry.authType === 'oauth' && entry.oauth?.tokens?.accessToken) {
        probeHeaders['Authorization'] = `Bearer ${entry.oauth.tokens.accessToken}`
      }
      const res = await fetch(entry.url, {
        method: 'GET',
        headers: probeHeaders,
        signal: controller.signal,
        redirect: 'manual',
      })
      reachable = true
      void res.body?.cancel().catch(() => { /* best-effort body discard */ })
    } catch {
      reachable = false
    } finally {
      clearTimeout(timer)
    }
    probeCache.set(entry.serverName, { reachable, at: Date.now() })
    return reachable
  }

  /** Entry + live status; probes reachability so a closed server is not shown as connected. */
  async function decorateEntry(entry: McpServerEntry): Promise<McpServerEntry & { status: string; toolCount: number; error?: string }> {
    const base = statusOf(entry)
    if (base.status === 'connected') {
      const reachable = await probeReachable(entry)
      if (!reachable) return { ...entry, ...base, status: 'offline' }
    } else if (base.status === 'connecting') {
      const reachable = await probeReachable(entry)
      if (!reachable) {
        return { ...entry, ...base, status: 'error', error: '服务器不可达（可能已关闭）' }
      }
    }
    return { ...entry, ...base }
  }

  function findEntry(serverName: string): McpServerEntry | undefined {
    return state.servers.find(server => server.serverName === serverName && available(serverName))
  }

  /**
   * Re-read the config file from disk and reconcile the live connections:
   * connect newly added / re-enabled / changed servers, disconnect removed /
   * disabled / changed ones. No-op when nothing changed, so the manager's own
   * saveState() writes do not cause churn.
   */
  async function reloadFromDisk(): Promise<void> {
    const disk = loadState(path)
    for (const entry of disk.servers) entry.enabled = entry.enabled ?? true
    const diskSigs = new Map(disk.servers.map(entry => [entry.serverName, JSON.stringify(entry)]))
    const currentSigs = new Map(state.servers.map(entry => [entry.serverName, JSON.stringify(entry)]))

    // Disconnect servers that were removed, disabled, or changed on disk.
    for (const entry of [...state.servers]) {
      const diskSig = diskSigs.get(entry.serverName)
      if (diskSig === undefined || diskSig !== currentSigs.get(entry.serverName)) {
        await disconnect(entry.serverName)
      }
    }

    // Connect servers that are new or changed and enabled on disk.
    for (const diskEntry of disk.servers) {
      const currentSig = currentSigs.get(diskEntry.serverName)
      if (currentSig === undefined || currentSig !== diskSigs.get(diskEntry.serverName)) {
        if (isEnabled(diskEntry)) {
          void connect(diskEntry).catch(err => {
            ctx.logger.error(`mcp-manager: reload connect "${diskEntry.serverName}" failed: ${String(err)}`)
          })
        }
      }
    }

    state.servers = disk.servers
  }

  /** Validate transport-specific fields only (shared by create and update). */
  function validateFields(entry: McpServerEntry): void {
    if (entry.transport !== 'stdio' && entry.transport !== 'streamable-http') {
      throw new Error('transport must be "stdio" or "streamable-http"')
    }
    if (entry.transport === 'streamable-http') {
      if (typeof entry.url !== 'string' || !/^https?:\/\//.test(entry.url)) {
        throw new Error('streamable-http requires a url starting with http:// or https://')
      }
    } else {
      if (typeof entry.command !== 'string' || entry.command.trim() === '') {
        throw new Error('stdio requires a command')
      }
    }
  }

  function validateEntry(body: unknown): McpServerEntry {
    if (body === null || typeof body !== 'object') {
      throw new Error('body must be a JSON object')
    }
    const entry = body as McpServerEntry
    if (typeof entry.serverName !== 'string' || !SERVER_NAME_PATTERN.test(entry.serverName)) {
      throw new Error('serverName must match [A-Za-z0-9_-]{1,32}')
    }
    if (!available(entry.serverName, entry)) throw new Error(`server "${entry.serverName}" is not available in this product`)
    if (state.servers.some(server => server.serverName === entry.serverName)) {
      throw new Error(`server "${entry.serverName}" already exists`)
    }
    validateFields(entry)
    entry.enabled = entry.enabled ?? true
    return entry
  }

  /** Validate an update body: the identity is the URL path (serverName immutable). */
  function validateUpdate(serverName: string, body: unknown): McpServerEntry {
    if (body === null || typeof body !== 'object') {
      throw new Error('body must be a JSON object')
    }
    const entry = body as McpServerEntry
    if (entry.serverName !== undefined && entry.serverName !== serverName) {
      throw new Error(`serverName cannot be changed (stays "${serverName}")`)
    }
    entry.serverName = serverName
    validateFields(entry)
    if (!available(serverName, { ...findEntry(serverName), ...entry })) throw new Error(`server "${serverName}" is not available in this product`)
    return entry
  }

  // ── JSON API routes ────────────────────────────────────────────────────────

  const json = (res: import('node:http').ServerResponse, status: number, body: unknown): void => {
    res.statusCode = status
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.end(JSON.stringify(body))
  }

  const readBody = (req: import('node:http').IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      req.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          reject(new Error('request body too large'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })

  const handler = async (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<void> => {
    let diagnosticServer = 'unknown'
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const parts = url.pathname.split('/').filter(Boolean) // mcp-manager / api / ...
      if (parts[0] !== 'mcp-manager' || parts[1] !== 'api') {
        json(res, 404, { ok: false, error: 'not found' })
        return
      }

      const [action, serverName, sub] = parts.slice(2)
      if (action === 'servers' && serverName) diagnosticServer = serverName

      // OAuth callback is loaded directly by user browser redirect, bypass standard token check
      if (req.method === 'GET' && action === 'oauth' && serverName === 'callback') {
        const code = url.searchParams.get('code')
        const stateVal = url.searchParams.get('state')
        const errorParam = url.searchParams.get('error')
        const errorDescription = url.searchParams.get('error_description')

        res.statusCode = 200
        res.setHeader('Content-Type', 'text/html; charset=utf-8')

        if (errorParam || !code || !stateVal) {
          const errMsg = errorDescription || errorParam || 'Missing code or state parameter'
          const result = stateVal ? oauthResults.get(stateVal) : undefined
          if (result && stateVal) {
            diagnostic(result.serverName, 'oauth-callback-failed', diagnosticError(errMsg), 'ERROR')
            result.status = 'error'
            result.error = errMsg
            pendingOAuthSessions.delete(stateVal)
          }
          res.end(`<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>OAuth Authorization Failed</title><style>body{font-family:system-ui,-apple-system,sans-serif;background:#18181b;color:#f4f4f5;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}.card{background:#27272a;padding:32px;border-radius:12px;max-width:480px;text-align:center;box-shadow:0 4px 20px rgba(0,0,0,0.5)}.err{color:#ef4444;margin-top:12px}</style></head>
<body>
  <div class="card">
    <h2>❌ 授权失败 (Authorization Failed)</h2>
    <div class="err">${escapeHtml(errMsg)}</div>
    <p style="margin-top:24px;color:#a1a1aa;font-size:13px">窗口将在 5 秒后自动关闭…</p>
  </div>
  <script>
    if (window.opener) {
      window.opener.postMessage({ type: 'mcp-oauth-error', error: ${JSON.stringify(errMsg)} }, '*');
    }
    setTimeout(() => window.close(), 5000);
  </script>
</body>
</html>`)
          return
        }

        const session = pendingOAuthSessions.get(stateVal)
        if (!session || !available(session.serverName, { serverName: session.serverName, transport: 'streamable-http', url: session.url })) {
          res.end(`<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>OAuth Session Expired</title><style>body{font-family:system-ui,-apple-system,sans-serif;background:#18181b;color:#f4f4f5;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}.card{background:#27272a;padding:32px;border-radius:12px;max-width:480px;text-align:center}</style></head>
<body>
  <div class="card">
    <h2>⚠️ 会话已过期 (Session Expired)</h2>
    <p style="color:#a1a1aa">请返回 MCP 管理面板重新点击授权。</p>
  </div>
  <script>setTimeout(() => window.close(), 3000);</script>
</body>
</html>`)
          return
        }

        pendingOAuthSessions.delete(stateVal)
        diagnostic(session.serverName, 'oauth-callback-received')

        try {
          const tokens = await exchangeAuthorization(session.authorizationServerUrl, {
            metadata: session.metadata,
            clientInformation: session.clientInformation,
            authorizationCode: code,
            codeVerifier: session.codeVerifier,
            redirectUri: session.redirectUri,
            resource: new URL(session.resource),
            fetchFn: diagnosticFetch(session.serverName, 'oauth-exchange-http'),
          })

          let entry = findEntry(session.serverName)
          if (!entry) {
            entry = {
              serverName: session.serverName,
              transport: 'streamable-http',
              url: session.url,
              authType: 'oauth',
              enabled: true,
            }
            state.servers.push(entry)
          }
          entry.authType = 'oauth'
          // Replace the client identity as a unit so a stale secret or
          // registration record never outlives the client it belonged to.
          const { registeredRedirectUri: _redirect, clientSecret: _secret, userProvided: _user, ...savedOAuth } = entry.oauth ?? {}
          entry.oauth = {
            ...savedOAuth,
            clientId: session.clientInformation.client_id,
            ...(session.clientInformation.client_secret ? { clientSecret: session.clientInformation.client_secret } : {}),
            ...(session.registeredRedirectUri ? { registeredRedirectUri: session.registeredRedirectUri } : {}),
            ...(session.userProvided ? { userProvided: true } : {}),
            authorizationServerUrl: session.authorizationServerUrl,
            tokens: {
              accessToken: tokens.access_token,
              refreshToken: tokens.refresh_token,
              expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined,
              tokenType: tokens.token_type,
              scope: tokens.scope,
            },
          }
          saveState(path, state)
          const result = oauthResults.get(stateVal)
          if (result) result.status = 'authorized'
          diagnostic(session.serverName, 'oauth-authorized')

          // Reconnect server immediately with the newly acquired token
          void enqueue(entry.serverName, async () => {
            await disconnectNow(entry.serverName)
            await connectNow(entry)
          })

          res.end(`<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>OAuth Authorized</title><style>body{font-family:system-ui,-apple-system,sans-serif;background:#18181b;color:#f4f4f5;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}.card{background:#27272a;padding:32px;border-radius:12px;max-width:480px;text-align:center;box-shadow:0 4px 20px rgba(0,0,0,0.5)}.ok{color:#10b981;font-size:20px;font-weight:600}</style></head>
<body>
  <div class="card">
    <div class="ok">🎉 授权成功！(Authorized)</div>
    <p style="color:#a1a1aa;margin-top:12px">服务器 <b>${escapeHtml(session.serverName)}</b> 授权完成，已保存令牌并正在建立连接…</p>
    <p style="margin-top:20px;color:#71717a;font-size:12px">该窗口将在 1.5 秒后自动关闭。</p>
  </div>
  <script>
    if (window.opener) {
      window.opener.postMessage({ type: 'mcp-oauth-success', serverName: ${JSON.stringify(session.serverName)} }, '*');
    }
    setTimeout(() => window.close(), 1500);
  </script>
</body>
</html>`)
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err)
          diagnostic(session.serverName, 'oauth-exchange-failed', diagnosticError(err), 'ERROR')
          const result = oauthResults.get(stateVal)
          if (result) { result.status = 'error'; result.error = errMsg }
          res.end(`<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>OAuth Exchange Failed</title><style>body{font-family:system-ui,-apple-system,sans-serif;background:#18181b;color:#f4f4f5;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}.card{background:#27272a;padding:32px;border-radius:12px;max-width:480px;text-align:center}</style></head>
<body>
  <div class="card">
    <h2>❌ 交换令牌失败 (Token Exchange Failed)</h2>
    <p style="color:#ef4444">${escapeHtml(errMsg)}</p>
  </div>
  <script>
    if (window.opener) {
      window.opener.postMessage({ type: 'mcp-oauth-error', error: ${JSON.stringify(errMsg)} }, '*');
    }
    setTimeout(() => window.close(), 4000);
  </script>
</body>
</html>`)
        }
        return
      }

      if (integration && !integration.authorizeRequest(req)) {
        if (action === 'servers' && sub === 'reconnect') diagnostic(diagnosticServer, 'request-rejected', 'httpStatus=403', 'WARN')
        json(res, 403, { ok: false, error: 'Request not authorized' })
        return
      }

      if (!isAuthorized(req)) {
        const denied = authError()
        if (action === 'servers' && sub === 'reconnect') diagnostic(diagnosticServer, 'request-rejected', `httpStatus=${denied.status}`, 'WARN')
        json(res, denied.status, { ok: false, error: denied.message })
        return
      }

      if (req.method === 'GET' && action === 'health') {
        json(res, 200, { ok: true, name, version: VERSION, storePath: path })
        return
      }

      if (req.method === 'POST' && action === 'reload') {
        await reloadFromDisk()
        json(res, 200, { ok: true, servers: visibleEntries().length })
        return
      }

      // ── OAuth Management Endpoints ──────────────────────────────────────────
      if (req.method === 'GET' && action === 'oauth' && serverName === 'status') {
        const result = sub ? oauthResults.get(sub) : undefined
        if (!result || !available(result.serverName) || Date.now() - result.createdAt > 180_000) {
          if (result) diagnostic(result.serverName, 'oauth-status-expired', `ageMs=${Date.now() - result.createdAt}`, 'WARN')
          json(res, 404, { ok: false, error: 'OAuth session expired; please authorize again.' })
          return
        }
        if (!result.lastDiagnosticAt || Date.now() - result.lastDiagnosticAt >= 15_000 || result.status !== 'pending') {
          diagnostic(result.serverName, 'oauth-status-polled', `status=${result.status} ageMs=${Date.now() - result.createdAt}`)
          result.lastDiagnosticAt = Date.now()
        }
        json(res, 200, { ok: true, serverName: result.serverName, status: result.status, error: result.error })
        return
      }
      if (req.method === 'POST' && action === 'oauth') {
        if (serverName === 'discover') {
          const body = JSON.parse(await readBody(req)) as { url?: string }
          if (!body.url) {
            json(res, 400, { ok: false, error: 'url is required' })
            return
          }
          if (!available('', { serverName: '', transport: 'streamable-http', url: body.url })) {
            json(res, 400, { ok: false, error: 'server is not available in this product' })
            return
          }
          try {
            const info = await discoverOAuthServerInfo(body.url)
            json(res, 200, {
              ok: true,
              authorizationServerUrl: info.authorizationServerUrl,
              supportsOAuth: Boolean(info.authorizationServerMetadata || info.resourceMetadata),
              metadata: info.authorizationServerMetadata,
            })
          } catch (err) {
            json(res, 200, { ok: true, supportsOAuth: false, error: String(err) })
          }
          return
        }

        if (serverName === 'start') {
          const body = JSON.parse(await readBody(req)) as {
            serverName: string
            url?: string
            clientId?: string
            clientSecret?: string
            scopes?: string[]
            redirectUri?: string
            openBrowser?: boolean
          }
          diagnosticServer = body.serverName
          if (!available(body.serverName)) {
            json(res, 404, { ok: false, error: 'server not found' })
            return
          }
          const entry = findEntry(body.serverName)
          const targetUrl = body.url || entry?.url
          if (!available(body.serverName, { ...entry, serverName: body.serverName, transport: 'streamable-http', url: targetUrl })) {
            json(res, 404, { ok: false, error: 'server not found' })
            return
          }
          if (!targetUrl) {
            json(res, 400, { ok: false, error: 'url or valid serverName is required' })
            return
          }

          const hostHeader = (req.headers.host || `127.0.0.1:${ctx.webServer.port}`).split(':')[0]
          const port = ctx.webServer.port
          const authorization = await beginOAuth(body, `http://${hostHeader}:${port}/mcp-manager/api/oauth/callback`)
          const authorizationUrl = new URL(authorization.authorizationUrl)
          let browserOpened = false
          if (body.openBrowser && integration?.openAuthorizationUrl && authorizationUrl.protocol === 'https:') {
            diagnostic(body.serverName, 'oauth-browser-opening')
            await integration.openAuthorizationUrl(authorizationUrl)
            browserOpened = true
          }
          diagnostic(body.serverName, 'oauth-browser-ready', `browser=${browserOpened ? 'host' : 'popup'} callbackReceived=false`)
          json(res, 200, { ...authorization, browserOpened })
          return
        }

        if (serverName === 'revoke') {
          const body = JSON.parse(await readBody(req)) as { serverName: string }
          const entry = findEntry(body.serverName)
          if (!entry) {
            json(res, 404, { ok: false, error: `server "${body.serverName}" not found` })
            return
          }
          if (entry.oauth) {
            delete entry.oauth.tokens
            saveState(path, state)
          }
          await enqueue(entry.serverName, async () => {
            await disconnectNow(entry.serverName)
          })
          json(res, 200, { ok: true, server: await decorateEntry(entry) })
          return
        }
      }

      if (req.method === 'GET' && action === 'servers' && serverName === undefined) {
        const entries = visibleEntries()
        const servers = await Promise.all(entries.map(entry => decorateEntry(entry)))
        json(res, 200, { ok: true, servers })
        return
      }

      if (req.method === 'POST' && action === 'servers' && serverName === undefined) {
        const body = JSON.parse(await readBody(req)) as unknown
        const entry = validateEntry(body)
        if (entry.oauth) entry.oauth = reconcileOAuthClient(undefined, entry.oauth)
        state.servers.push(entry)
        saveState(path, state)
        void connect(entry).catch(err => {
          ctx.logger.error(`mcp-manager: connect "${entry.serverName}" failed: ${String(err)}`)
        })
        json(res, 201, { ok: true, server: { ...entry, ...statusOf(entry) } })
        return
      }

      if (serverName !== undefined && !available(serverName)) {
        json(res, 404, { ok: false, error: 'server not found' })
        return
      }

      if (serverName !== undefined) {
        if (req.method === 'POST' && sub === 'diagnostics') {
          if (!findEntry(serverName)) { json(res, 404, { ok: false, error: 'server not found' }); return }
          const body = JSON.parse(await readBody(req)) as { phase?: string; reason?: string }
          const phases = ['click', 'popup-reserved', 'popup-unavailable', 'request-accepted', 'oauth-required',
            'oauth-start-received', 'oauth-poll-start', 'oauth-authorized', 'connected', 'failed', 'cancelled']
          const reasons = ['popup-blocked', 'popup-closed', 'timeout', 'cancelled', 'request-failed', 'system-browser', 'host-browser', 'popup-browser']
          if (!phases.includes(body.phase ?? '') || (body.reason !== undefined && !reasons.includes(body.reason))) {
            json(res, 400, { ok: false, error: 'invalid diagnostic phase or reason' }); return
          }
          const level: DiagnosticLevel = body.phase === 'failed'
            ? body.reason === 'request-failed' || body.reason === undefined ? 'ERROR' : 'WARN'
            : body.phase === 'oauth-required' ? 'WARN' : 'INFO'
          diagnostic(serverName, `ui-${body.phase}`, body.reason ? `reason=${body.reason}` : '', level)
          json(res, 200, { ok: true })
          return
        }
        if (req.method === 'DELETE') {
          await disconnect(serverName)
          const before = state.servers.length
          state.servers = state.servers.filter(entry => entry.serverName !== serverName)
          if (state.servers.length !== before) saveState(path, state)
          json(res, 200, { ok: true })
          return
        }

        if (req.method === 'POST' && sub === 'update') {
          const entry = findEntry(serverName)
          if (!entry) {
            json(res, 404, { ok: false, error: `server "${serverName}" not found` })
            return
          }
          const body = JSON.parse(await readBody(req)) as unknown
          const updated = validateUpdate(serverName, body)
          if (updated.oauth) updated.oauth = reconcileOAuthClient(entry.oauth, updated.oauth)
          // Assign only the fields the client actually sent, so flags like
          // `enabled` set through the toggle endpoint are preserved.
          for (const [key, value] of Object.entries(updated)) {
            if (value !== undefined) (entry as unknown as Record<string, unknown>)[key] = value
          }
          saveState(path, state)
          // Reconfigure the live connection in place: fiber.update() validates
          // and hot-restarts the mcp-client instance without a full teardown,
          // so the serverName reservation never goes through a race window.
          await enqueue(serverName, async () => {
            if (!isEnabled(entry)) {
              await disconnectNow(serverName)
              return
            }
            const fiber = fibers.get(serverName)
            if (fiber === undefined) {
              await connectNow(entry)
              return
            }
            errors.delete(serverName)
            connectingSince.set(serverName, Date.now())
            try {
              const resolvedHeaders = await resolveEntryHeaders(entry, () => saveState(path, state))
              await fiber.update(toMcpConfig(entry, resolvedHeaders, integration))
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err)
              errors.set(serverName, message)
              connectingSince.delete(serverName)
              ctx.logger.error(`mcp-manager: update "${serverName}" failed: ${message}`)
            }
          })
          json(res, 200, { ok: true, server: { ...entry, ...statusOf(entry) } })
          return
        }

        if (req.method === 'POST' && sub === 'toggle') {
          const entry = findEntry(serverName)
          if (!entry) {
            json(res, 404, { ok: false, error: `server "${serverName}" not found` })
            return
          }
          const body = JSON.parse(await readBody(req)) as { enabled?: unknown }
          const enabled = body?.enabled === true
          entry.enabled = enabled
          saveState(path, state)
          if (isEnabled(entry)) {
            void connect(entry).catch(err => {
              ctx.logger.error(`mcp-manager: enable "${serverName}" connect failed: ${String(err)}`)
            })
          } else {
            await disconnect(serverName)
          }
          json(res, 200, { ok: true, server: { ...entry, ...statusOf(entry) } })
          return
        }

        if (req.method === 'POST' && sub === 'reconnect') {
          diagnostic(serverName, 'reconnect-requested')
          const entry = findEntry(serverName)
          if (!entry) {
            json(res, 404, { ok: false, error: `server "${serverName}" not found` })
            return
          }
          await disconnect(serverName)
          void connect(entry).catch(err => {
            ctx.logger.error(`mcp-manager: reconnect "${serverName}" failed: ${String(err)}`)
          })
          diagnostic(serverName, 'reconnect-accepted')
          json(res, 200, { ok: true, server: { ...entry, ...statusOf(entry) } })
          return
        }

        if (req.method === 'GET') {
          const entry = findEntry(serverName)
          if (!entry) {
            json(res, 404, { ok: false, error: `server "${serverName}" not found` })
            return
          }
          json(res, 200, { ok: true, server: await decorateEntry(entry) })
          return
        }
      }

      json(res, 404, { ok: false, error: 'not found' })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (req.method === 'POST') diagnostic(diagnosticServer, 'request-failed', diagnosticError(err), 'ERROR')
      json(res, 400, { ok: false, error: message })
    }
  }

  // ── lifecycle ───────────────────────────────────────────────────────────────

  // Routes are registered through an effect so unload removes them; the
  // register() disposer doubles as the effect disposer.
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/mcp-manager', handler }), 'mcp-manager.routes')

  // Connections are owned by this fiber: unloading the manager disposes every
  // mounted mcp-client fiber, which disconnects and unregisters all its tools.
  // The config-file watcher is torn down with the same effect.
  ctx.effect(() => {
    let reloadTimer: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = integration?.subscribe?.(() => {
      void reloadFromDisk().then(async () => {
        for (const entry of state.servers) {
          if (!available(entry.serverName, entry) || !isEnabled(entry)) await disconnect(entry.serverName)
          else if (!fibers.has(entry.serverName)) void connect(entry).catch(err => ctx.logger.warn('mcp-manager: contribution connect failed: %s', String(err)))
        }
      }).catch(err => ctx.logger.warn('mcp-manager: contribution refresh failed: %s', String(err)))
    })
    const oauthCleanup = setInterval(() => {
      for (const [stateId, result] of oauthResults) {
        if (Date.now() - result.createdAt > 180_000) {
          oauthResults.delete(stateId)
          pendingOAuthSessions.delete(stateId)
        }
      }
    }, 30_000)
    const onConfigChange = (): void => {
      if (reloadTimer !== undefined) return
      reloadTimer = setTimeout(() => {
        reloadTimer = undefined
        void reloadFromDisk()
      }, RELOAD_DEBOUNCE_MS)
    }
    // Poll-based watch (works across platforms, including when the file does
    // not exist yet). External edits to mcp-servers.json are picked up
    // automatically; the manager's own saveState() writes reconcile as no-ops.
    watchFile(path, { interval: FILE_WATCH_INTERVAL_MS }, onConfigChange)
    return () => {
      unsubscribe?.()
      lifetime.abort()
      clearInterval(oauthCleanup)
      oauthResults.clear()
      pendingOAuthSessions.clear()
      if (reloadTimer !== undefined) clearTimeout(reloadTimer)
      unwatchFile(path, onConfigChange)
      for (const fiber of fibers.values()) {
        void fiber.dispose().catch(() => { /* best-effort teardown */ })
      }
      fibers.clear()
      errors.clear()
      queues.clear()
      connectingSince.clear()
      probeCache.clear()
      manualDiagnosticsUntil.clear()
    }
  }, 'mcp-manager.connections')

  // Connect every configured server at startup (best-effort; failures log and
  // show as status "error" in the UI, the list stays intact for a retry).
  const start = (): void => {
    for (const entry of visibleEntries()) {
      void connect(entry).catch(err => {
        ctx.logger.error(`mcp-manager: startup connect "${entry.serverName}" failed: ${String(err)}`)
      })
    }
  }
  if (integration) ctx.effect(() => integration.onReady(start), 'mcp-manager.ready')
  else start()
  ctx.logger.info(`mcp-manager: loaded ${visibleEntries().length} server(s) from ${path}`)
  if (hasToken) {
    ctx.logger.info('mcp-manager: access token configured — /mcp-manager/* requests require "Authorization: Bearer <token>"')
  } else if (exposed) {
    ctx.logger.error(
      'mcp-manager: SECURITY — the web server is network-exposed (host 0.0.0.0) and no access token is set; '
      + 'all /mcp-manager/* requests are rejected until you set "token" in mcp-servers.json (stdio servers execute arbitrary commands)',
    )
  } else {
    ctx.logger.warn(
      'mcp-manager: no access token configured — /mcp-manager/* is open on loopback only; '
      + 'set "token" in mcp-servers.json before binding dsh to a non-loopback address',
    )
  }
}
