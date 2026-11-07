import type { McpServerView } from './index.tsx'
import type { LocaleKey } from './locales.ts'

type Request = <T>(url: string, init?: RequestInit) => Promise<T>

/** Best-effort metadata only; diagnostics must never delay or break reconnect. */
function report(request: Request, api: string, serverName: string, phase: string, reason?: string): void {
  void request(`${api}/servers/${encodeURIComponent(serverName)}/diagnostics`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phase, reason }), signal: AbortSignal.timeout(2000),
  }).catch(() => {})
}

function failureReason(error: unknown, t: (key: LocaleKey) => string, signal?: AbortSignal): string {
  const message = error instanceof Error ? error.message : String(error)
  if (signal?.aborted) return 'cancelled'
  if (message === t('oauthPopupBlocked')) return 'popup-blocked'
  if (message === t('oauthPopupClosed')) return 'popup-closed'
  if (message === t('oauthStillWaiting') || /timeout|超时/i.test(message)) return 'timeout'
  return 'request-failed'
}

/** Observe the host's callback result even when authorization uses a system browser. */
export async function authorizeOAuth(
  request: Request, api: string, t: (key: LocaleKey) => string,
  body: { serverName: string; url?: string; clientId?: string; scopes?: string[] },
  signal?: AbortSignal,
  popup: Window | null = window.open('about:blank', `mcp_oauth_${body.serverName}`, 'width=650,height=760'),
): Promise<void> {
  const closePopup = () => popup?.close()
  signal?.addEventListener('abort', closePopup, { once: true })
  try {
    signal?.throwIfAborted()
    const result = await request<{ authorizationUrl: string; state: string; browserOpened: boolean }>(`${api}/oauth/start`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
      body: JSON.stringify({ ...body, openBrowser: true }),
    })
    report(request, api, body.serverName, 'oauth-start-received', result.browserOpened ? 'host-browser' : 'popup-browser')
    if (result.browserOpened) {
      popup?.close()
      popup = null
    } else {
      const authorization = new URL(result.authorizationUrl)
      const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(authorization.hostname)
      if (authorization.protocol !== 'https:' && !loopback) throw new Error(t('oauthHttpsRequired'))
      if (popup && !popup.closed) popup.location.replace(authorization.href)
      else {
        // A WebView may hand new windows to the system browser and return null.
        popup = window.open(authorization.href, `mcp_oauth_${body.serverName}`, 'width=650,height=760')
        if (!popup && !loopback) throw new Error(t('oauthPopupBlocked'))
      }
    }
    report(request, api, body.serverName, 'oauth-poll-start')
    const deadline = Date.now() + 120000
    while (Date.now() < deadline) {
      signal?.throwIfAborted()
      const status = await request<{ status: 'pending' | 'authorized' | 'error'; error?: string }>(
        `${api}/oauth/status/${encodeURIComponent(result.state)}`, { signal },
      )
      if (status.status === 'authorized') {
        report(request, api, body.serverName, 'oauth-authorized')
        const connectionDeadline = Date.now() + 35000
        while (Date.now() < connectionDeadline) {
          signal?.throwIfAborted()
          const { server } = await request<{ server: McpServerView }>(
            `${api}/servers/${encodeURIComponent(body.serverName)}`, { signal },
          )
          if (server.status === 'connected') return
          if (server.status === 'error') throw new Error(server.error || t('error'))
          await new Promise(resolve => setTimeout(resolve, 500))
        }
        throw new Error(t('oauthStillWaiting'))
      }
      if (status.status === 'error') throw new Error(status.error || t('error'))
      if (popup?.closed) throw new Error(t('oauthPopupClosed'))
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
    throw new Error(t('oauthStillWaiting'))
  } finally {
    signal?.removeEventListener('abort', closePopup)
    popup?.close()
  }
}

export async function reconnectWithOAuth(
  server: McpServerView, request: Request,
  api: string, reconnect: (name: string) => Promise<void>, t: (key: LocaleKey) => string,
  signal?: AbortSignal,
): Promise<void> {
  report(request, api, server.serverName, 'click')
  let popup: Window | null = null
  const endpoint = `${api}/servers/${encodeURIComponent(server.serverName)}`
  try {
    if (server.authType !== 'oauth') {
      await reconnect(server.serverName)
      report(request, api, server.serverName, 'request-accepted')
      return
    }
    // Reserve synchronously during the user's click, before any network await.
    popup = window.open('about:blank', `mcp_oauth_${server.serverName}`, 'width=650,height=760')
    report(request, api, server.serverName, popup ? 'popup-reserved' : 'popup-unavailable')
    await reconnect(server.serverName)
    report(request, api, server.serverName, 'request-accepted')
    const read = async () => (await request<{ server: McpServerView }>(endpoint, { signal })).server
    let current = await read()
    const connectingDeadline = Date.now() + 35000
    while ((current.status === 'connecting' || current.status === 'disconnected') && Date.now() < connectingDeadline) {
      signal?.throwIfAborted()
      await new Promise(resolve => setTimeout(resolve, 500))
      current = await read()
    }
    if (current.status === 'connected') {
      report(request, api, server.serverName, 'connected')
      return
    }
    if (current.status === 'connecting' || current.status === 'disconnected')
      throw new Error(t('timeoutMsg').replace('{n}', '35'))
    // Network/transport failures must not trigger another authorization round.
    if (!/OAuth|\b401\b|unauthorized|invalid[_ ]token|invalid_grant/i.test(current.error ?? ''))
      throw new Error(current.error || t(current.status === 'disabled' ? 'disabled' : 'error'))
    report(request, api, server.serverName, 'oauth-required')
    await authorizeOAuth(request, api, t, { serverName: server.serverName }, signal, popup)
    report(request, api, server.serverName, 'connected')
  } catch (error) {
    report(request, api, server.serverName, signal?.aborted ? 'cancelled' : 'failed', failureReason(error, t, signal))
    throw error
  } finally {
    popup?.close()
  }
}
