/**
 * dsh-mcp-manager — browser half.
 *
 * Registers the "MCP Manager" section into the Web settings page
 * (`settings.section` slot) and renders the server management card. The card
 * talks to the host half through plain HTTP routes under `/mcp-manager/api/*`
 * (the settings-namespace allowlist cannot expose third-party namespaces, so
 * the UI deliberately does not use `settingsScope`).
 *
 * Two views: a list of server cards, and a form page (add / edit). Opening the
 * form hides the list; editing shows a delete danger zone whose confirmation
 * hint only appears after the first click, on the same row as the button.
 *
 * Theming: every color references the harness's `--dsw-alias-*` token family,
 * so the page follows DSH's light/dark mode automatically.
 * i18n: all strings come from the `mcpManager` locale namespace (zh/en).
 *
 * @module dsh-mcp-manager/client
 */

import { useEffect, useRef, useState } from 'react'
import {
  Button, IconChevronLeftOutlineRegular, IconPlusOutlineRegular, IconRefreshOutlineRegular,
  Modal, StateDot, Switch, Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { en, fmt, zh, type LocaleKey } from './locales.ts'
import { authorizeOAuth, reconnectWithOAuth } from './reconnect.ts'
import styles from './McpManagerSection.module.css'

export interface OAuthTokensView {
  accessToken: string
  tokenType?: string
  refreshToken?: string
  expiresAt?: number
  scope?: string
}

export interface McpServerOAuthConfigView {
  clientId?: string
  clientSecret?: string
  scopes?: string[]
  authorizationServerUrl?: string
  tokens?: OAuthTokensView
}

export interface McpServerView {
  serverName: string
  transport: 'stdio' | 'streamable-http'
  url?: string
  headers?: Record<string, string>
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  toolCallTimeoutMs?: number
  failOnStartupError?: boolean
  enabled?: boolean
  status?: string
  toolCount?: number
  error?: string
  authType?: 'none' | 'oauth'
  oauth?: McpServerOAuthConfigView
}

export interface McpManagerSectionInjected {
  list: () => Promise<McpServerView[]>
  add: (entry: McpServerView) => Promise<void>
  update: (serverName: string, entry: McpServerView) => Promise<void>
  setEnabled: (serverName: string, enabled: boolean) => Promise<void>
  remove: (serverName: string) => Promise<void>
  reconnect: (serverName: string) => Promise<void>
}

export interface McpManagerSectionProps extends McpManagerSectionInjected {
  /** Bound to the `mcpManager` locale namespace by the settings shell. */
  t: (key: LocaleKey) => string
  // The settings shell may bind additional runtime props; we only need the face above.
  [key: string]: unknown
}

/** Locale namespace owned by this plugin. */
export const NS = 'mcpManager'

const API = '/mcp-manager/api'

/** Poll cadence while waiting for a connection to settle. */
const POLL_INTERVAL_MS = 800
/** Default connection wait before giving up (seconds). */
const DEFAULT_WAIT_SECONDS = 15
/** localStorage key for the optional access token entered by the user. */
const TOKEN_STORAGE_KEY = 'mcpManager.accessToken'

/** Current access token sent on every request ("" = none configured). */
let accessToken = ''

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  headers.set('Content-Type', 'application/json')
  if (accessToken !== '') headers.set('Authorization', `Bearer ${accessToken}`)
  const response = await fetch(url, { ...init, headers })
  let body: { ok: boolean; error?: string } & T
  try {
    body = await response.json() as typeof body
  } catch {
    throw new Error(`MCP manager: invalid response (${response.status})`)
  }
  if (!response.ok || body.ok === false) {
    throw new Error(body.error ?? `request failed (${response.status})`)
  }
  return body
}

/** Poll the server list until every entry settles (terminal states) or the timeout elapses. */
async function pollServers(timeoutMs: number): Promise<{ servers: McpServerView[]; timedOut: boolean }> {
  const deadline = Date.now() + timeoutMs
  let servers: McpServerView[] = []
  for (;;) {
    const body = await request<{ servers: McpServerView[] }>(`${API}/servers`)
    servers = body.servers
    const settled = servers.every(s =>
      s.status === 'connected' || s.status === 'error' || s.status === 'disabled'
      || s.status === 'disconnected' || s.status === 'offline')
    if (settled) return { servers, timedOut: false }
    if (Date.now() >= deadline) return { servers, timedOut: true }
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
  }
}

// ── presentation ─────────────────────────────────────────────────────────────
// Controls come from the platform ui-primitives table and layout from the
// section's CSS module, matching the native settings pages.

type DotState = 'done' | 'warning' | 'ongoing' | 'error' | 'idle'

const statusDot = (status: string | undefined): DotState => {
  switch (status) {
    case 'connected': return 'done'
    case 'connecting': return 'ongoing'
    case 'error': return 'error'
    case 'offline': return 'warning'
    default: return 'idle'
  }
}

export function McpManagerSection({ list, add, update, setEnabled, remove, reconnect, t }: McpManagerSectionProps) {
  const [servers, setServers] = useState<McpServerView[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState<string>()
  /** 'list' shows the server cards; 'form' shows the add/edit page (cards hidden). */
  const [view, setView] = useState<'list' | 'form'>('list')
  /** Server currently being edited (null = the form is in add mode). */
  const [editing, setEditing] = useState<McpServerView | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  // form fields
  const [serverName, setServerName] = useState('')
  const [transport, setTransport] = useState<'stdio' | 'streamable-http'>('streamable-http')
  const [url, setUrl] = useState('')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [headers, setHeaders] = useState('')
  const [waitSeconds, setWaitSeconds] = useState(DEFAULT_WAIT_SECONDS)

  // OAuth form states
  const [authType, setAuthType] = useState<'none' | 'oauth'>('none')
  const [oauthClientId, setOauthClientId] = useState('')
  const [oauthScopes, setOauthScopes] = useState('')
  const [oauthAuthorizing, setOauthAuthorizing] = useState(false)
  const [oauthMsg, setOauthMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)
  const oauthCancellation = useRef<AbortController | null>(null)
  useEffect(() => () => oauthCancellation.current?.abort(), [])

  /** Optional access token, persisted locally so the settings page keeps working. */
  const [token, setToken] = useState<string>(() => window.localStorage.getItem(TOKEN_STORAGE_KEY) ?? '')

  useEffect(() => {
    accessToken = window.localStorage.getItem(TOKEN_STORAGE_KEY) ?? ''
  }, [])

  const handleTokenChange = (value: string): void => {
    const trimmed = value.trim()
    setToken(trimmed)
    accessToken = trimmed
    if (trimmed === '') window.localStorage.removeItem(TOKEN_STORAGE_KEY)
    else window.localStorage.setItem(TOKEN_STORAGE_KEY, trimmed)
  }

  const refresh = async (): Promise<void> => {
    setLoading(true)
    setError(undefined)
    try {
      const body = await request<{ servers: McpServerView[] }>(`${API}/servers`)
      setServers(body.servers)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void refresh() }, [])

  /** Run an action, then poll until the connection settles or the wait times out, and refresh. */
  const runWithPoll = async (busyKey: string, action: () => Promise<void>, signal?: AbortSignal): Promise<void> => {
    setBusy(busyKey)
    setError(undefined)
    try {
      await action()
      if (signal?.aborted) return
      const timeoutMs = Number.isFinite(waitSeconds) && waitSeconds > 0 ? waitSeconds * 1000 : DEFAULT_WAIT_SECONDS * 1000
      const { servers: settled, timedOut } = await pollServers(timeoutMs)
      setServers(settled)
      if (timedOut) {
        setError(fmt(t('timeoutMsg'), { n: Math.round(timeoutMs / 1000) }))
      }
    } catch (err) {
      if (signal?.aborted) return
      const message = err instanceof Error ? err.message : String(err)
      await refresh()
      if (!signal?.aborted) setError(message)
    } finally {
      setBusy(current => current === busyKey ? undefined : current)
    }
  }

  const resetForm = (): void => {
    oauthCancellation.current?.abort()
    setServerName(''); setUrl(''); setCommand(''); setArgs(''); setHeaders(''); setTransport('streamable-http')
    setAuthType('none'); setOauthClientId(''); setOauthScopes(''); setOauthAuthorizing(false); setOauthMsg(null)
  }

  const openAddForm = (): void => {
    setEditing(null)
    resetForm()
    setConfirmingDelete(false)
    setView('form')
  }

  const startEdit = (server: McpServerView): void => {
    setEditing(server)
    setTransport(server.transport)
    setUrl(server.url ?? '')
    setCommand(server.command ?? '')
    setArgs((server.args ?? []).join(' '))
    setHeaders(server.headers !== undefined ? JSON.stringify(server.headers, null, 2) : '')
    setAuthType(server.authType ?? 'none')
    setOauthClientId(server.oauth?.clientId ?? '')
    setOauthScopes((server.oauth?.scopes ?? []).join(' '))
    setOauthMsg(null)
    setConfirmingDelete(false)
    setView('form')
  }

  const closeForm = (): void => {
    setEditing(null)
    setConfirmingDelete(false)
    setView('list')
    resetForm()
  }

  const submit = async (): Promise<void> => {
    const entry: McpServerView = {
      serverName: (editing?.serverName ?? serverName).trim(),
      transport,
    }
    if (transport === 'streamable-http') {
      entry.url = url.trim()
      entry.authType = authType
      if (authType === 'oauth') {
        entry.oauth = {
          ...(editing?.oauth ?? {}),
          clientId: oauthClientId.trim() || undefined,
          scopes: oauthScopes.split(/\s+/).filter(Boolean),
        }
      } else if (headers.trim() !== '') {
        try {
          entry.headers = JSON.parse(headers) as Record<string, string>
        } catch {
          setError(t('invalidHeaders'))
          return
        }
      }
    } else {
      entry.command = command.trim()
      entry.args = args.split(/\s+/).filter(Boolean)
    }
    if (editing !== null) {
      await runWithPoll(editing.serverName, async () => {
        await update(editing.serverName, entry)
        closeForm()
      })
    } else {
      await runWithPoll('add', async () => {
        await add(entry)
        closeForm()
      })
    }
  }

  const startOAuthFlow = async (): Promise<void> => {
    const targetServerName = (editing?.serverName ?? serverName).trim()
    const targetUrl = url.trim()
    if (!targetServerName) {
      setError(t('addFailed') + ': serverName is required')
      return
    }
    if (!targetUrl) {
      setError(t('addFailed') + ': URL is required')
      return
    }
    setOauthAuthorizing(true)
    setOauthMsg(null)
    setError(undefined)
    const cancellation = new AbortController()
    oauthCancellation.current?.abort()
    oauthCancellation.current = cancellation

    try {
      await authorizeOAuth(request, API, t, {
        serverName: targetServerName, url: targetUrl,
        clientId: oauthClientId.trim() || undefined,
        scopes: oauthScopes.split(/\s+/).filter(Boolean),
      }, cancellation.signal)
      const res = await request<{ server: McpServerView }>(`${API}/servers/${encodeURIComponent(targetServerName)}`, { signal: cancellation.signal })
      setEditing(res.server)
      setOauthClientId(res.server.oauth?.clientId ?? '')
      setOauthMsg({ type: 'ok', text: t('oauthSuccessMsg') })
      await refresh()
    } catch (err) {
      if (cancellation.signal.aborted) return
      setOauthMsg({ type: 'err', text: fmt(t('oauthFailedMsg'), { error: err instanceof Error ? err.message : String(err) }) })
    } finally {
      if (oauthCancellation.current === cancellation) setOauthAuthorizing(false)
    }
  }

  const revokeOAuth = async (targetServerName: string): Promise<void> => {
    setBusy(targetServerName)
    try {
      await request(`${API}/oauth/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverName: targetServerName }),
      })
      if (editing && editing.serverName === targetServerName) {
        setEditing({ ...editing, oauth: undefined })
      }
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(undefined)
    }
  }

  /** Delete the edited server once the confirmation dialog is accepted. */
  const handleDelete = async (): Promise<void> => {
    if (editing === null) return
    setBusy(editing.serverName)
    setError(undefined)
    try {
      await remove(editing.serverName)
      setConfirmingDelete(false)
      closeForm()
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(undefined)
    }
  }

  const removeServer = async (serverName: string): Promise<void> => {
    setBusy(serverName)
    setError(undefined)
    try {
      await remove(serverName)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(undefined)
    }
  }

  const reconnectServer = async (serverName: string): Promise<void> => {
    const server = servers.find(item => item.serverName === serverName)
    if (!server) return
    const cancellation = new AbortController()
    oauthCancellation.current?.abort()
    oauthCancellation.current = cancellation
    await runWithPoll(serverName, () => reconnectWithOAuth(server, request, API, reconnect, t, cancellation.signal), cancellation.signal)
  }

  /** Enable or disable a server: enabling connects (with poll), disabling disconnects immediately. */
  const toggleEnabled = (server: McpServerView): void => {
    const enabling = server.enabled === false
    void runWithPoll(server.serverName, async () => { await setEnabled(server.serverName, enabling) })
  }

  const formBusy = busy !== undefined
  const deleting = editing !== null && busy === editing.serverName

  const statusText = (server: McpServerView): string => {
    switch (server.status) {
      case 'connected': return fmt(t('connected'), { n: server.toolCount ?? 0 })
      case 'connecting': return t('connecting')
      case 'error': return t('error')
      case 'offline': return t('offline')
      case 'disabled': return t('disabled')
      case 'disconnected': return t('disconnected')
      default: return server.status ?? t('unknown')
    }
  }

  const currentOAuthTokens = editing?.oauth?.tokens

  const headersField = (
    <div className={styles.field}>
      <span className={styles.fieldLabel}>{t('fieldHeaders')}</span>
      <textarea
        className={`${styles.input} ${styles.textarea}`}
        aria-label={t('fieldHeaders')}
        placeholder='{"Authorization": "Bearer <token>"}'
        value={headers}
        onChange={e => setHeaders(e.target.value)}
      />
    </div>
  )

  const editorView = (
    <div className={styles.editor}>
      <div className={styles.editorHeader}>
        <button type="button" className={styles.iconButton} aria-label={t('backToList')} title={t('backToList')} onClick={closeForm}>
          <IconChevronLeftOutlineRegular size={14} />
        </button>
        <span className={styles.editorTitle}>
          {editing !== null ? fmt(t('editTitle'), { name: editing.serverName }) : t('addTitle')}
        </span>
      </div>

      <div className={styles.field}>
        <span className={styles.fieldLabel}>{t('fieldServerName')}</span>
        <input
          className={styles.input}
          aria-label={t('fieldServerName')}
          placeholder="my-server"
          value={editing !== null ? editing.serverName : serverName}
          disabled={editing !== null}
          title={editing !== null ? t('serverNameLocked') : undefined}
          onChange={e => setServerName(e.target.value)}
        />
      </div>

      <div className={styles.field}>
        <span className={styles.fieldLabel}>{t('fieldTransport')}</span>
        <select
          className={`${styles.input} ${styles.selectInput}`}
          aria-label={t('fieldTransport')}
          value={transport}
          onChange={e => setTransport(e.target.value as 'stdio' | 'streamable-http')}
        >
          <option value="streamable-http">streamable-http (HTTP/SSE)</option>
          <option value="stdio">stdio</option>
        </select>
      </div>

      {transport === 'streamable-http' ? (
        <>
          <div className={styles.field}>
            <span className={styles.fieldLabel}>{t('fieldUrl')}</span>
            <input
              className={styles.input}
              aria-label={t('fieldUrl')}
              placeholder="http://127.0.0.1:8080/mcp"
              value={url}
              onChange={e => setUrl(e.target.value)}
            />
          </div>

          <div className={styles.field}>
            <span className={styles.fieldLabel}>{t('authType')}</span>
            <select
              className={`${styles.input} ${styles.selectInput}`}
              aria-label={t('authType')}
              value={authType}
              onChange={e => setAuthType(e.target.value as 'none' | 'oauth')}
            >
              <option value="none">{t('authTypeNone')}</option>
              <option value="oauth">{t('authTypeOAuth')}</option>
            </select>
          </div>

          {authType === 'oauth' ? (
            <div className={styles.group}>
              <div className={styles.groupHead}>
                <span className={styles.fieldLabel}>{t('oauthStatus')}</span>
                {currentOAuthTokens?.accessToken ? (
                  <Tag tone="neutral">
                    {t('oauthAuthorized')}
                    {currentOAuthTokens.expiresAt ? ` · ${fmt(t('oauthExpiresAt'), { time: new Date(currentOAuthTokens.expiresAt).toLocaleTimeString() })}` : ''}
                  </Tag>
                ) : (
                  <Tag tone="outline">{t('oauthNotAuthorized')}</Tag>
                )}
              </div>

              {oauthMsg && <p className={oauthMsg.type === 'ok' ? styles.ok : styles.error}>{oauthMsg.text}</p>}

              <div className={styles.groupActions}>
                <Button variant="outline" size="sm" disabled={oauthAuthorizing} onClick={() => void startOAuthFlow()}>
                  {oauthAuthorizing ? t('oauthAuthorizing') : t('oauthAuthorizeBtn')}
                </Button>
                {currentOAuthTokens?.accessToken && (
                  <Button
                    size="sm"
                    className={styles.dangerButton}
                    disabled={oauthAuthorizing || busy === (editing?.serverName ?? serverName)}
                    onClick={() => void revokeOAuth(editing?.serverName ?? serverName)}
                  >
                    {t('oauthRevokeBtn')}
                  </Button>
                )}
              </div>

              <div className={styles.field}>
                <span className={styles.fieldLabel}>{t('oauthClientId')}</span>
                <input
                  className={styles.input}
                  aria-label={t('oauthClientId')}
                  placeholder="client-id-123"
                  value={oauthClientId}
                  onChange={e => setOauthClientId(e.target.value)}
                />
                <p className={styles.hint}>{t('oauthClientIdHint')}</p>
              </div>
              <div className={styles.field}>
                <span className={styles.fieldLabel}>{t('oauthScopes')}</span>
                <input
                  className={styles.input}
                  aria-label={t('oauthScopes')}
                  placeholder="read write"
                  value={oauthScopes}
                  onChange={e => setOauthScopes(e.target.value)}
                />
                <p className={styles.hint}>{t('oauthScopesHint')}</p>
              </div>
            </div>
          ) : headersField}
        </>
      ) : (
        <>
          <div className={styles.field}>
            <span className={styles.fieldLabel}>{t('fieldCommand')}</span>
            <input
              className={styles.input}
              aria-label={t('fieldCommand')}
              placeholder="npx"
              value={command}
              onChange={e => setCommand(e.target.value)}
            />
          </div>
          <div className={styles.field}>
            <span className={styles.fieldLabel}>{t('fieldArgs')}</span>
            <input
              className={styles.input}
              aria-label={t('fieldArgs')}
              placeholder="--flag value"
              value={args}
              onChange={e => setArgs(e.target.value)}
            />
          </div>
          {headersField}
        </>
      )}

      <div className={styles.field}>
        <span className={styles.fieldLabel}>{t('fieldTimeout')}</span>
        <input
          className={`${styles.input} ${styles.numberInput}`}
          aria-label={t('fieldTimeout')}
          type="number"
          min={1}
          max={120}
          value={String(waitSeconds)}
          onChange={e => { const n = Number(e.target.value); setWaitSeconds(Number.isFinite(n) ? n : DEFAULT_WAIT_SECONDS) }}
        />
        <p className={styles.hint}>{t('timeoutHint')}</p>
      </div>

      <div className={styles.editorActions}>
        {editing !== null && (
          <Button data-danger className={styles.dangerButton} disabled={formBusy || oauthAuthorizing} onClick={() => setConfirmingDelete(true)}>
            {t('deleteServer')}
          </Button>
        )}
        <Button variant="outline" disabled={formBusy} onClick={closeForm}>{t('cancel')}</Button>
        <Button variant="primary" disabled={formBusy || oauthAuthorizing} onClick={() => void submit()}>
          {formBusy
            ? (editing !== null ? t('savingBusy') : t('addingBusy'))
            : (editing !== null ? t('save') : t('addAndConnect'))}
        </Button>
      </div>
    </div>
  )

  const listView = (
    <>
      <h3 className={styles.subTitle}>{t('configured')}</h3>
      {loading && servers.length === 0 ? <p className={styles.hint}>{t('loading')}</p> : servers.length === 0 ? (
        <p className={styles.empty}>{t('empty')}</p>
      ) : (
        <ul className={styles.rows}>
          {servers.map(server => {
            const disabled = server.enabled === false
            const rowBusy = busy === server.serverName
            const isOAuth = server.authType === 'oauth'
            const hasOAuthToken = Boolean(server.oauth?.tokens?.accessToken)
            const dot = statusDot(server.status)
            const endpoint = server.transport === 'streamable-http'
              ? server.url ?? ''
              : [server.command, ...(server.args ?? [])].filter(Boolean).join(' ')
            return (
              <li key={server.serverName} className={styles.rowCard} data-disabled={disabled || undefined}>
                <div className={styles.rowHead}>
                  <span className={styles.rowIdentity}>
                    <span className={styles.rowName}>{server.serverName}</span>
                    <Tag tone="outline">{server.transport}</Tag>
                    {isOAuth && <Tag tone="outline">{hasOAuthToken ? 'OAuth ✓' : 'OAuth'}</Tag>}
                  </span>
                  <span className={styles.rowActions}>
                    {!disabled && (
                      <Button variant="outline" size="sm" disabled={rowBusy} onClick={() => void reconnectServer(server.serverName)}>
                        {rowBusy ? t('reconnecting') : t('reconnect')}
                      </Button>
                    )}
                    <Button variant="outline" size="sm" disabled={rowBusy} onClick={() => startEdit(server)}>
                      {t('edit')}
                    </Button>
                    <Switch
                      checked={!disabled}
                      disabled={rowBusy}
                      label={disabled ? t('disabledLabel') : t('enabledLabel')}
                      title={disabled ? t('disabledLabel') : t('enabledLabel')}
                      onChange={() => toggleEnabled(server)}
                    />
                  </span>
                </div>
                <div className={styles.rowMeta}>
                  <span className={styles.status} data-state={dot}>
                    <StateDot state={dot} size={dot === 'ongoing' ? 12 : 8} />
                    {statusText(server)}
                  </span>
                  {endpoint !== '' && <span className={styles.separator}>·</span>}
                  {endpoint !== '' && <span className={styles.endpoint} title={endpoint}>{endpoint}</span>}
                </div>
                {server.status === 'error' && server.error !== undefined && (
                  <p className={styles.rowError} title={server.error}>{server.error}</p>
                )}
                {server.status === 'offline' && <p className={styles.rowHint}>{t('offlineHint')}</p>}
              </li>
            )
          })}
        </ul>
      )}

      <button type="button" className={styles.addButton} onClick={openAddForm}>
        <IconPlusOutlineRegular size={14} />
        {t('addServer')}
      </button>

      <div className={styles.rowCard}>
        <div className={styles.field}>
          <span className={styles.fieldLabel}>{t('tokenLabel')}</span>
          <input
            type="password"
            className={styles.input}
            aria-label={t('tokenLabel')}
            placeholder="Bearer <token>"
            value={token}
            onChange={e => handleTokenChange(e.target.value)}
          />
          <p className={styles.hint}>{t('tokenHint')}</p>
        </div>
      </div>
    </>
  )

  return (
    <div className={styles.section}>
      <div className={styles.header}>
        <h2 className={styles.title}>{t('title')}</h2>
        {view === 'list' && (
          <button
            type="button"
            className={styles.iconButton}
            aria-label={t('refresh')}
            title={t('refresh')}
            disabled={loading}
            onClick={() => void refresh()}
          >
            <IconRefreshOutlineRegular size={16} />
          </button>
        )}
      </div>
      <p className={styles.intro}>{t('intro')}</p>

      {error !== undefined && <p role="alert" className={styles.error}>{error}</p>}

      {view === 'form' ? editorView : listView}

      <Modal
        open={confirmingDelete && editing !== null}
        onClose={() => { if (!deleting) setConfirmingDelete(false) }}
        title={editing === null ? '' : fmt(t('deleteTitle'), { name: editing.serverName })}
        closeLabel={t('cancel')}
        description={t('deleteHint')}
        className={styles.deleteDialog}
        footer={(
          <>
            <Button variant="outline" data-modal-autofocus disabled={deleting} onClick={() => setConfirmingDelete(false)}>
              {t('cancel')}
            </Button>
            <Button variant="outline" className={styles.deleteConfirm} disabled={deleting} onClick={() => void handleDelete()}>
              {deleting ? t('deleting') : t('confirmDelete')}
            </Button>
          </>
        )}
      />
    </div>
  )
}

/** Services required by this client plugin. */
export const inject = ['slots', 'locale']

/** Register the section into Web settings. */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'mcp-manager: dictionaries')

  const injected = (): McpManagerSectionInjected => ({
    list: async () => {
      const body = await request<{ servers: McpServerView[] }>(`${API}/servers`)
      return body.servers
    },
    add: async (entry: McpServerView) => {
      const body = await request<{ ok: boolean }>(`${API}/servers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(entry),
      })
      if (!body.ok) throw new Error(t('addFailed'))
    },
    update: async (serverName: string, entry: McpServerView) => {
      const body = await request<{ ok: boolean }>(`${API}/servers/${encodeURIComponent(serverName)}/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(entry),
      })
      if (!body.ok) throw new Error(t('updateFailed'))
    },
    setEnabled: async (serverName: string, enabled: boolean) => {
      const body = await request<{ ok: boolean }>(`${API}/servers/${encodeURIComponent(serverName)}/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      })
      if (!body.ok) throw new Error(t('toggleFailed'))
    },
    remove: async (serverName: string) => {
      await request<{ ok: boolean }>(`${API}/servers/${encodeURIComponent(serverName)}`, { method: 'DELETE' })
    },
    reconnect: async (serverName: string) => {
      await request<{ ok: boolean }>(`${API}/servers/${encodeURIComponent(serverName)}/reconnect`, { method: 'POST' })
    },
  })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'mcp-manager',
    order: 16,
    label: () => t('nav'),
    locale: NS,
    inject: injected,
  }, McpManagerSection))
}
