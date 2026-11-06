# dsh-mcp-manager

[English](README.md) | [中文](README.zh.md) · [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

本仓库是 [Nichts0v0/dsh-mcp-manager](https://github.com/Nichts0v0/dsh-mcp-manager) 的源码 fork，基于 `335f797c30b9c3880d997c27343c609c8019f040`，面向 DSH **0.2.2-rc.1**，补充可选嵌入策略、受管连接访问和 OAuth 重连改进，保留上游署名与 MIT 许可证。

在 DeepSeek Harness 的 **Web 设置页**里直接管理 **MCP 服务器**——运行时添加、编辑、启用/停用、重连、删除，带实时状态、自动重连和配置文件热同步。

## 功能简介

- **Web 设置页 UI** — 独立的"MCP 服务器管理"页面：服务器卡片（实时状态）、添加/编辑表单、两步确认的删除保护。
- **OAuth 2.0 / RFC 9728 认证支持** — 原生支持 MCP OAuth 2.1 规范与 PKCE，自动发现认证元数据、浏览器授权登录、令牌自动刷新与凭证管理。
- **运行时连接** — 服务器即时连接/断开；工具以 `mcp__<serverName>__<tool>` 全局注册，所有会话的 agent 都能调用。
- **实时状态** — 可达性探测让关闭的服务器显示 **离线** 而不是陈旧的"已连接"；卡住的连接 30 秒后判为超时。
- **宿主可见诊断** — Debug 与发布版都通过 stderr 输出 `[MCP][INFO|WARN|ERROR]` 日志，串起重连点击、断开/建立连接、OAuth 刷新、授权浏览器与回调。正常进度为 INFO，需要授权、超时或重试为 WARN，操作失败为 ERROR；stderr 仅表示输出通道，不代表错误级别。详细诊断仅在显式点击重连后开启，本次操作完成或超时即停止；轮询不刷日志；错误只提取已知网络、HTTP、OAuth 代码，不输出任意响应正文、凭据或授权链接，宿主可直接在现有运行日志面板展示。
- **手动重试** — 初始连接失败后等待用户重连；打开页面或刷新状态不会触发重连。
- **启用/停用** — 一键停用立即断开并卸载工具；重新启用即自动重连。
- **配置热同步** — `$DSH_HOME/mcp-servers.json` 被实时监听，外部修改约 1 秒内生效，无需重启。
- **主题与多语言** — 自动跟随 DSH 浅色/深色主题（含外观插件对 `--dsw-alias-*` token 的覆盖）；UI 内置**简体中文 / English**。

## 截图

![MCP 服务器管理设置页](docs/s_zh.webp)

## 安装

### 如果你是人类

**安装此源码 fork：**

1. 克隆并构建：

   ```sh
   git clone https://github.com/ornithologist-love/dsh-mcp-manager.git
   cd dsh-mcp-manager
   npm install --ignore-scripts
   npm run build
   ```

2. 让 loader 能从 profile 解析该包（二选一）：
   - **在包含克隆目录的父目录执行**（无需写绝对路径）：

     ```sh
     dsh plugin --profile web add ./dsh-mcp-manager
     ```

     > 注意：本包没有 `dsh.bundle` 层，`dsh plugin add` 只会把它作为普通 pnpm 依赖安装（保证可解析），**仍需第 3 步手动挂载插件行**。
   - **或用软链接**把仓库目录本身链接到 profile 的 node_modules（不要直接复制整个仓库，会把开发用的 node_modules 也带进去）：
     - Windows：`mklink /J "%DSH_HOME%\profiles\web\node_modules\dsh-mcp-manager" <克隆路径>` —— 把 `<克隆路径>` 换成你本地克隆的位置
     - macOS/Linux：`ln -s <克隆路径> $DSH_HOME/profiles/web/node_modules/dsh-mcp-manager`

**无论哪种方式，最后在 `$DSH_HOME/profiles/web/cordis.patch.yml` 挂载插件行：**

```yaml
- insert:
    - id: mcp-manager
      name: dsh-mcp-manager
```

**重启 `dsh web`**，并强制刷新浏览器页面（`Ctrl+Shift+R`）以加载新的 `__DSH_BOOT__`，然后打开 **设置 → MCP 服务器** 添加你的第一个服务器。

> 注：Web 面的 `cordis.patch.yml` 热重载未启用（DSH 共享 HMR 行是关的），改配置后需重启。

### 如果你是一个 AI agent

请按顺序执行，不要跳步：

1. **通读本 README**（尤其是"功能简介"、"已知限制"和本节）。
2. **构建此 fork**：克隆本仓库 → `cd dsh-mcp-manager` → `npm install --ignore-scripts` → `npm run build` → 把目录链接到 `$DSH_HOME/profiles/<profile>/node_modules/dsh-mcp-manager`（Windows 用目录 junction，POSIX 用符号链接）。DSH 安装需匹配固定 SDK 版本，并提供声明的运行时 peer 依赖。
3. **挂载插件行**：在 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 追加：

   ```yaml
   - insert:
       - id: mcp-manager
         name: dsh-mcp-manager
   ```

4. **重启 `dsh web`**（Web 面配置热重载未启用），并提示用户**强制刷新浏览器**以看到设置页新入口。
5. **验证**：`GET http://127.0.0.1:3080/mcp-manager/api/health` 应返回 `{"ok":true,"name":"mcp-manager","version":"<x.y.z>",...}`。

## 使用简介

打开 **设置 → MCP 服务器**：

- **服务器卡片**：显示名称、传输方式、状态徽章、端点与 `OAuth` 标记；停用的卡片变灰。
- **启用/停用开关**：停用立即断开并卸载该服务器的工具。
- **重连**：自动等待连接结果并刷新（等待时间可配置，默认 15 秒）。
- **编辑**：可改传输方式 / URL / 命令 / Headers / OAuth 设置（`serverName` 不可修改）；保存后原地热更新连接。
- **OAuth 授权**：对于需要认证的 `streamable-http` 服务，选择 `OAuth 2.0`，点击 **授权登录 (OAuth)** 弹窗完成登录，并支持随时撤销/清除授权。
- **删除**：位于编辑页顶部，两步确认（3 秒窗口）。
- **添加**：`streamable-http`（URL + 可选 Headers 或 OAuth 2.0）或 `stdio`（命令 + 参数），可设连接等待超时。

### 状态说明

| 状态 | 含义 |
|---|---|
| 已连接 (n 工具) | 工具已注册 |
| 连接中 | 正在握手 / 重连 |
| 服务器离线 | 曾连接成功，但服务器进程当前不可达（探测结果） |
| 连接错误 | 初始连接失败（显示原因）或 30 秒连接超时 |
| 已停用 | 已关闭——不连接、无工具 |

### 配置文件

`$DSH_HOME/mcp-servers.json` —— 所有 profile/会话共享：

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

文件被**实时监听**：手工修改（增/删/改/启停）约 1 秒内生效；`POST /mcp-manager/api/reload` 可随时手动触发。

### HTTP API

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/mcp-manager/api/health` | 存活 + 版本 + 存储路径 |
| GET | `/mcp-manager/api/servers` | 服务器列表（含探测后的实时状态） |
| GET | `/mcp-manager/api/servers/<name>` | 单个服务器 |
| POST | `/mcp-manager/api/servers` | 添加并连接 |
| POST | `/mcp-manager/api/servers/<name>/update` | 更新配置并热重连（`serverName` 不可改） |
| POST | `/mcp-manager/api/servers/<name>/toggle` | 启用/停用（`{"enabled": true|false}`） |
| POST | `/mcp-manager/api/servers/<name>/reconnect` | 断开后重连 |
| DELETE | `/mcp-manager/api/servers/<name>` | 断开并删除 |
| POST | `/mcp-manager/api/reload` | 从磁盘重新读取配置文件 |
| POST | `/mcp-manager/api/oauth/discover` | 探测 MCP 服务的 RFC 9728 OAuth 元数据 |
| POST | `/mcp-manager/api/oauth/start` | 生成用于浏览器登录的 PKCE 授权链接 |
| GET | `/mcp-manager/api/oauth/callback` | OAuth 重定向回调与令牌交换 |
| POST | `/mcp-manager/api/oauth/revoke` | 清除已保存的凭据并断开连接 |

## 安全

`/mcp-manager/*` API 可以启动 `stdio` 服务器——即执行任意命令——因此做了访问控制：

- **可选访问令牌**。在 `$DSH_HOME/mcp-servers.json` 顶层设置 `token`：

  ```json
  { "version": 1, "token": "使用一长串随机字符", "servers": [] }
  ```

  生成：`node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`。
  配置后**所有**请求（含 `health`）都必须携带 `Authorization: Bearer <token>`：

  ```sh
  curl -H "Authorization: Bearer <token>" http://127.0.0.1:3080/mcp-manager/api/servers
  ```

  设置页顶部有"访问令牌"输入框——填入一次（保存在浏览器本地），之后自动附带。

- **网络暴露防护**。当 `dsh web` 绑到非 loopback 地址（`--host 0.0.0.0`）**且未配置令牌**时，管理器会输出红色错误日志并**拒绝所有** `/mcp-manager/*` 请求（403），直到设置令牌并重启。仅 loopback + 无令牌保持全开，符合单用户本机定位。
- 令牌比对使用常数时间比较（`crypto.timingSafeEqual`）。
- 令牌明文存在 `mcp-servers.json`——请保护好该文件（信任级别同 DSH 凭据存储）。

## 开发

```sh
npm install --ignore-scripts
npm run build    # lib/index.js（host）+ lib/client.js（浏览器，内含 CSS）
npm run watch    # 同时监听两个 bundle
```

构建只依赖本仓库和公开 npm 包。运行时 peer（`@deepseek-ai/cordis`、`@deepseek-ai/dsh-mcp-client`、`@modelcontextprotocol/sdk`）由嵌入环境提供；浏览器复用宿主 React 和 DSH 模块身份，CSS Modules 在浏览器工厂内编译注入。`prepack` 在打包前构建两个产物。

## 已知限制

- **初始失败等待用户操作** — `failOnStartupError` 开启，首次连接失败显示 `error`，不再后台重试；已成功连接后的断线恢复仍由 mcp-client 处理。
- **可达性探测是 HTTP 层** — 对 `streamable-http` 服务器发 GET（2.5 秒超时，任何 HTTP 响应都算可达）；`stdio` 服务器不探测。
- **仅桥接 tools** — MCP Resources/Prompts 未桥接（与官方 mcp-client 一致）。
- **鉴权只有令牌、默认仅 loopback** — `/mcp-manager/*` 没有用户体系；对外暴露 `--host 0.0.0.0` 前请先配置 `token`（见"安全"一节；stdio 服务器可执行任意命令）。
- **部分 MCP 服务器只允许一个活动客户端**（如 Godot MCP）——第一连接未释放时，第二连接会被拒绝并报错。

## 许可证

MIT

## 嵌入此源码分支

嵌入方可通过 `isAvailable(entry)` 按名称或地址屏蔽宿主保留的服务，在连接、管理、探测和 OAuth 之前拒绝接入。隐藏项仍完整保留在磁盘；新建和修改后的配置同样受此策略约束。不提供该回调时保持原独立行为。

配置 `useIntegration: true` 后，管理器等待 `mcpManagerIntegration` 服务：提供连接输入转换、非回调请求鉴权、OAuth 客户端注册准备以及就绪后的连接启动。提供方卸载时释放管理器作用域。不启用时保持原独立运行的启动和鉴权规则。OAuth 回调继续校验待办 state；授权、交换令牌和刷新使用发现到的同一 resource，刷新使用服务器元数据，失败时报错而不沿用过期令牌。重连在点击时预留弹窗，并通过管理器查询授权后的连接状态；完成消息要求同源。

嵌入方还可提供 `products: { active: "alpha", servers: { alpha: ["alpha-tools"], beta: ["beta-tools"] } }`。Manager 仅显示、连接、重试、探测和管理当前产品的服务，以及没有归入任何产品的自定义服务。省略 `active` 时隐藏所有产品预置项。隐藏项的直接管理与 OAuth 请求会被拒绝；保存其他服务时仍完整保留它们的配置、启停状态和凭据。已有全局配置无需迁移即可按当前产品生效。当前产品由嵌入方提供，不是用户可修改的服务器字段。

同进程 `ctx.mcpManager` 服务为增强插件提供 `servers()`、`tools(serverName)` 和 `callTool(serverName, execution)`，不暴露凭据或传输句柄。`ensureConnected(serverName, {interactive, signal, onPhase})` 仅在显式用户点击（`interactive: true`）时允许启用和连接服务，并通过嵌入方的 `openAuthorizationUrl(URL)` 打开系统浏览器；复用 Manager 的 PKCE、回调与凭据存储，同一服务的并发请求共享授权。恢复会话不弹浏览器，取消某个等待者不关闭其他会话共用的连接。调用必须使用当前产品可见且已连接的服务，并经原生 ToolRuntime 保留调用者作用域、策略链和取消。嵌套调用传递父 token 与根调用 ID；原始 MCP 工具仍由 Manager 持有。
