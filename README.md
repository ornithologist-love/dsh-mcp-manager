# dsh-mcp-manager

[English](README.md) | [中文](README.zh.md) · [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Source fork of [Nichts0v0/dsh-mcp-manager](https://github.com/Nichts0v0/dsh-mcp-manager), based on `335f797c30b9c3880d997c27343c609c8019f040`, targeting DSH **0.2.2-rc.1**. It adds optional embedding policies, managed connection access and OAuth reconnect improvements. Upstream attribution and the MIT license are retained.

Manage **MCP servers** right from the DeepSeek Harness Web settings page — add, edit, enable/disable, reconnect and delete servers at runtime, with live status, automatic reconnect and config-file hot sync.

## Features

- **Web settings UI** — a dedicated "MCP Server Manager" page: server cards with live status, an add/edit form, and two-step delete protection.
- **OAuth 2.0 / RFC 9728 support** — native MCP OAuth 2.1 authorization with PKCE, automated metadata discovery, browser-based login flow, token auto-refresh and management.
- **Runtime connections** — servers connect/disconnect on the fly; tools are registered globally as `mcp__<serverName>__<tool>` for every session.
- **Live status** — reachability probing so a closed server shows **offline** instead of a stale "connected"; a stuck connection times out after 30 s.
- **Host-visible diagnostics** — `[MCP][INFO|WARN|ERROR]` stderr records trace reconnect clicks, disconnect/connect, OAuth refresh and browser/callback phases in Debug and Release. Normal progress is INFO, authorization requirements/timeouts/retries are WARN, and failed operations are ERROR; stderr identifies the output channel, not severity. Detailed diagnostics run only during an explicit reconnect and stop when that interaction completes or times out. Polling is quiet. Errors expose known network/HTTP/OAuth codes, never arbitrary response bodies, credentials or authorization URLs; embedding hosts can display these records in their existing runtime log panel.
- **Explicit retry** — a failed initial connect remains in error until a user reconnects; opening or refreshing the status page never retries a connection.
- **Enable/disable** — switch a server off to disconnect and unload its tools; switch it on to reconnect.
- **Embedding activation policy** — `McpManagerIntegration.isEnabled` can override activation for one process while preserving the saved enable flags; connection, reconnect and status use the same policy.
- **Config file hot sync** — `$DSH_HOME/mcp-servers.json` is watched; external edits take effect within ~1 s, no restart needed.
- **Themes & i18n** — follows DSH light/dark mode (and `--dsw-alias-*` token overrides from appearance plugins); UI ships in **简体中文 / English**.

## Screenshot

![MCP Manager settings page](docs/s_en.webp)

## Install

### For humans

**Install this source fork:**

1. Clone and build:

   ```sh
   git clone https://github.com/ornithologist-love/dsh-mcp-manager.git
   cd dsh-mcp-manager
   npm install --ignore-scripts
   npm run build
   ```

2. Make the package resolvable from the profile (pick one):
   - Run from the folder that contains the clone (no absolute path needed):

     ```sh
     dsh plugin --profile web add ./dsh-mcp-manager
     ```

     > This installs the package as a plain pnpm dependency (this package has no `dsh.bundle` layer), which only makes it resolvable — you still need step 3 to mount the plugin row.
   - Or symlink the repository directory itself into the profile's `node_modules` (avoid copying, which would drag in dev `node_modules`):
     - Windows: `mklink /J "%DSH_HOME%\profiles\web\node_modules\dsh-mcp-manager" <path-to-clone>` — replace `<path-to-clone>` with your local clone path
     - macOS/Linux: `ln -s <path-to-clone> $DSH_HOME/profiles/web/node_modules/dsh-mcp-manager`

**Then, whichever option — mount the plugin row** in `$DSH_HOME/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: mcp-manager
      name: dsh-mcp-manager
```

**Restart `dsh web`** and hard-refresh the browser page (`Ctrl+Shift+R`) so the new `__DSH_BOOT__` loads, then open **Settings → MCP Server Manager** and add your first server.

> Note: hot reload of `cordis.patch.yml` is disabled on the Web surface (DSH's shared HMR row is off), so configuration changes need a restart.

### For AI agents

Follow every step, in order:

1. **Read this README in full** (especially *Features*, *Known limitations*, and this install section).
2. **Build this fork**: clone this repo, `cd dsh-mcp-manager`, run `npm install --ignore-scripts` and `npm run build`, then link the folder into `$DSH_HOME/profiles/<profile>/node_modules/dsh-mcp-manager` (directory junction on Windows, symlink on POSIX). Use a DSH installation matching the pinned SDK and the declared runtime peers.
3. **Mount the plugin row**: append to `$DSH_HOME/profiles/<profile>/cordis.patch.yml`:

   ```yaml
   - insert:
       - id: mcp-manager
         name: dsh-mcp-manager
   ```

4. **Restart `dsh web`** (Web-surface config hot reload is disabled) and tell the user to **hard-refresh** the browser so the settings page shows the new section.
5. **Verify**: `GET http://127.0.0.1:3080/mcp-manager/api/health` must return `{"ok":true,"name":"mcp-manager","version":"<x.y.z>",...}`.

## Usage

Open **Settings → MCP Server Manager**:

- **Server cards** show the name, transport, status badge, endpoint and `OAuth` tags; disabled cards are dimmed.
- **Enable/disable switch** — disabling disconnects immediately and unloads the server's tools.
- **Reconnect** — waits for the connection result and refreshes automatically (configurable wait, default 15 s).
- **Edit** — change transport / URL / command / headers / OAuth settings (`serverName` is immutable); saving hot-reconfigures the live connection.
- **OAuth authorization** — for `streamable-http` servers requiring authentication, choose `OAuth 2.0`, click **Authorize (OAuth)** to log in via browser popup, and manage token revocation.
- **Delete** — lives at the top of the edit page, behind a two-step confirm (3 s window).
- **Add** — `streamable-http` (URL + optional headers or OAuth 2.0) or `stdio` (command + args), with a configurable connection-wait timeout.

### Statuses

| Status | Meaning |
|---|---|
| Connected (n tools) | tools are registered |
| Connecting | handshake / reconnecting in progress |
| Offline | was connected, but the server process is unreachable (probed) |
| Error | initial connect failed (reason shown) or 30 s connect timeout |
| Disabled | switched off — not connected, no tools |

### Configuration file

`$DSH_HOME/mcp-servers.json` — shared by every profile and session:

```json
{
  "version": 1,
  "servers": [
    {
      "serverName": "my-http-server",
      "transport": "streamable-http",
      "url": "http://127.0.0.1:8080/mcp",
      "enabled": true
    },
    {
      "serverName": "my-oauth-server",
      "transport": "streamable-http",
      "url": "https://api.example.com/mcp",
      "authType": "oauth",
      "enabled": true,
      "oauth": {
        "clientId": "client-id-123",
        "scopes": ["read", "write"],
        "tokens": {
          "accessToken": "secret_access_token",
          "refreshToken": "secret_refresh_token",
          "expiresAt": 1787304425000
        }
      }
    }
  ]
}
```

The file is **watched live**: manual edits (add / remove / change / enable) take effect within ~1 s; `POST /mcp-manager/api/reload` triggers it on demand.

### HTTP API

| Method | Path | Purpose |
|---|---|---|
| GET | `/mcp-manager/api/health` | liveness + version + store path |
| GET | `/mcp-manager/api/servers` | list with live (probed) status |
| GET | `/mcp-manager/api/servers/<name>` | single server |
| POST | `/mcp-manager/api/servers` | add & connect |
| POST | `/mcp-manager/api/servers/<name>/update` | update config & hot-reconnect (`serverName` immutable) |
| POST | `/mcp-manager/api/servers/<name>/toggle` | enable / disable (`{"enabled": true|false}`) |
| POST | `/mcp-manager/api/servers/<name>/reconnect` | disconnect & reconnect |
| DELETE | `/mcp-manager/api/servers/<name>` | disconnect & delete |
| POST | `/mcp-manager/api/reload` | re-read the config file from disk |
| POST | `/mcp-manager/api/oauth/discover` | probe RFC 9728 OAuth metadata for an MCP URL |
| POST | `/mcp-manager/api/oauth/start` | generate PKCE authorization URL for browser login |
| GET | `/mcp-manager/api/oauth/callback` | OAuth redirect callback & token exchange |
| POST | `/mcp-manager/api/oauth/revoke` | clear saved OAuth credentials and disconnect |

## Security

The `/mcp-manager/*` API can start `stdio` servers — i.e. execute arbitrary commands — so it is access-controlled:

- **Optional access token.** Set a top-level `token` in `$DSH_HOME/mcp-servers.json`:

  ```json
  { "version": 1, "token": "use-a-random-long-string", "servers": [] }
  ```

  Generate one with `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`.
  When set, **every** request must carry `Authorization: Bearer <token>` (all endpoints, including `health`):

  ```sh
  curl -H "Authorization: Bearer <token>" http://127.0.0.1:3080/mcp-manager/api/servers
  ```

  The settings page shows an "Access token" field — enter it there once (stored locally in the browser) and it is sent automatically.

- **Network-exposure guard.** When `dsh web` binds to a non-loopback address (`--host 0.0.0.0`) **and no token is configured**, the manager logs a loud error and **rejects all `/mcp-manager/*` requests** (403) until a token is set and dsh is restarted. Loopback-only + no token stays fully open, matching the single-user local posture.
- Token comparison is timing-safe (`crypto.timingSafeEqual`).
- The token is stored in plaintext in `mcp-servers.json` — protect that file (same trust level as the DSH credentials store).

## Development

```sh
npm install --ignore-scripts
npm run build    # lib/index.js (host) + lib/client.js (browser, including CSS)
npm run watch    # watch both bundles
```

The build uses only this repository and public npm dependencies. Runtime peers (`@deepseek-ai/cordis`, `@deepseek-ai/dsh-mcp-client` and `@modelcontextprotocol/sdk`) resolve from the embedding installation. Browser React and DSH modules retain their host identities; CSS Modules are compiled and injected inside the browser factory. `prepack` builds both artifacts before packaging.

## Known limitations

- **Initial failure waits for user action** — `failOnStartupError` is on, so a failed first connect shows `error` without background retries; once connected, mcp-client's own reconnect still handles drops.
- **Reachability probing is HTTP-level** — a GET with a 2.5 s timeout for `streamable-http` servers (any HTTP response counts as reachable); `stdio` servers are not probed.
- **Tools only** — MCP Resources/Prompts are not bridged (same as the official mcp-client).
- **Auth is token-only, loopback-by-default** — `/mcp-manager/*` has no built-in user accounts; use the optional `token` (see *Security*) before exposing `--host 0.0.0.0` (stdio servers execute arbitrary commands).
- **Some MCP servers allow only one active client** (e.g. Godot MCP) — a second connection is rejected until the first is released.

## License

MIT

## Embedding this source fork

An embedding provider may supply `isAvailable(entry)` to hide and refuse host-reserved servers by name or endpoint before connection, management, probing or OAuth. Hidden entries stay intact on disk. New or updated entries must also satisfy this policy; omitting it preserves standalone behavior.

Set `useIntegration: true` to wait for a `mcpManagerIntegration` provider. The provider transforms connection inputs, authorizes non-callback requests, prepares OAuth client registration, and schedules startup connections after readiness. Unloading it releases the manager scope. Without this option the manager uses its original standalone startup and access checks. The OAuth callback retains pending-state validation; authorization, code exchange and refresh carry the discovered resource, and refresh uses server metadata and reports failure instead of reusing an expired token. Reconnect reserves a popup during the click and polls the manager after authorization; completion messages require the same origin.

The embedding provider can also supply `products: { active: "alpha", servers: { alpha: ["alpha-tools"], beta: ["beta-tools"] } }`. The manager lists, connects, retries, probes and manages only servers owned by the active product, plus servers absent from all groups. Omitting `active` hides all product-owned entries. Hidden entries reject direct management and OAuth requests; they remain intact on disk with their enabled flags and credentials when another entry is saved. This also applies to existing global configurations without a data migration. Product selection belongs to the embedding provider, not a user-editable server field.

The same-process `ctx.mcpManager` service offers `servers()`, `tools(serverName)` and `callTool(serverName, execution)` for enhancement plugins, without exposing credentials or transport handles. `ensureConnected(serverName, {interactive, signal, onPhase})` allows enabling, connecting and authorization only for explicit user interaction (`interactive: true`), using the embedding provider's `openAuthorizationUrl(URL)` system-browser opener. It reuses the manager's PKCE flow, callback and token store; concurrent requests for the same server share authorization. Restoring a session never opens a browser, and cancelling one waiter does not close another session's shared connection. Calls require an already connected, product-visible server and dispatch through the native ToolRuntime with the caller scope, policy pipeline and cancellation. Nested callers propagate their parent token and root call ID. Raw MCP registrations remain manager-owned.
