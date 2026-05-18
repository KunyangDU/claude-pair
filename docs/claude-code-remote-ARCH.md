# claude-code-remote 架构分析

## 整体架构

```
手机浏览器 (xterm.js 终端)
    ↓ HTTPS (Cloudflare Tunnel / Tailscale)
    ↓ WebSocket (文本=终端输出, 二进制=控制消息)
Express Server (localhost:3456)
    ├── HTTP: 静态页面 + API (/api/sessions, /api/dirs, /preview)
    └── WebSocket: 终端实时通信
        ↓
SessionManager → PtySession (node-pty 伪终端)
        ↓  spawn
    Claude CLI (直接运行在终端中)
```

## 核心模块分层

### 第1层 — 入口 & 路由 (`server/index.ts`)

| 职责 | 说明 |
|------|------|
| HTTP 静态服务 | 提供 web/ 目录下的 xterm.js 前端页面 |
| REST API | `/api/sessions` 列出会话、`/api/dirs` 目录自动补全、`/preview` 代理本地 dev server |
| WebSocket 控制协议 | 认证、创建/销毁/附着 session、resize、图片上传、定时任务 |
| 隧道管理 | 启动时自动拉起 cloudflared，生成 QR 码 |
| 定时广播 | 每5秒向所有客户端推送 session 状态列表 |

### 第2层 — Session 管理 (`session-manager.ts`)

```
SessionManager
├── sessions: Map<id(8位uuid), PtySession>
├── createSession(cwd, args)    // 生成8位id，spawn Claude CLI
├── getSession(id) / listSessions() / destroySession(id)
├── discoverExternalSessions()   // 通过 ProcessDetector 发现电脑上其他 Claude 进程
└── adoptExternalSession(pid)    // 接管外部 Claude 进程(kill后 --continue 恢复)
```

关键设计：
- Session ID 只取 UUID 前8位，够用且易读
- `createSession` 失败时不会把 session 加入 Map（异常安全）
- `adoptExternalSession`: kill 外部 Claude 进程 → 等 150ms → spawn 新 PTY 带 `--continue` 恢复对话

### 第3层 — PTY 会话 (`pty-session.ts`)

整个项目的核心，直接 spawn Claude CLI：

```typescript
this.pty = pty.spawn(claudePath, args, {
    name: 'xterm-256color',
    cols: 120, rows: 40,
    cwd: this.cwd,        // 在指定项目目录运行
    env: { ...process.env, TERM: 'xterm-256color', FORCE_COLOR: '1' }
});
```

关键特性：

1. **Claude CLI 探测** (优先级从高到低):
   - `CLAUDE_PATH` 环境变量（显式覆盖）
   - `which claude`（跟随用户 PATH）
   - 常见路径回退: `~/.local/bin/claude`, `/usr/local/bin/claude`, `/opt/homebrew/bin/claude`, `/usr/bin/claude`

2. **输出解析** (`parseOutput`): 监听 PTY 输出，用正则识别事件类型:
   - `ask_user` — 检测到 `?` + 数字选项（如 `1. xxx\n2. yyy`）
   - `tool_start` — 检测到 Read/Edit/Write/Bash/Glob/Grep 关键字
   - `diff` — 检测到 `@@` + `+`/`-` 行
   - `text` — 默认纯文本

3. **输出历史**: 上限 100KB，用于新客户端 attach 时回放

4. **活跃检测**: 30秒内有输出 = busy，否则 = idle

### 第4层 — 认证 (`auth.ts`)

```
Token 来源优先级:
  CLAUDE_REMOTE_TOKEN 环境变量
  → ~/.claude-code-remote/auth.json 持久化文件
  → crypto.randomBytes(4).toString('hex') 自动生成8位hex
```

传递方式:
- HTTP: `Authorization: Bearer <token>` 或 `?token=<token>`
- WebSocket: 首条消息发 `{ type: "auth", token: "..." }`

支持 `--rotate-token` 参数强制重新生成 token。

### 第5层 — 隧道 (`tunnel/`)

策略模式，统一接口：

```typescript
interface TunnelProvider {
  name: string;
  isAvailable(): Promise<boolean>;
  start(port: number): Promise<TunnelResult>;
}
```

三种实现:

| Provider | 方式 | 公网访问 |
|----------|------|---------|
| CloudflareTunnelProvider | `spawn cloudflared tunnel --url http://localhost:PORT` | 是 (trycloudflare.com) |
| TailscaleServeProvider | `tailscale serve` | 否 (仅 Tailnet) |
| TailscaleFunnelProvider | `tailscale funnel` | 是 |

Cloudflare 实现细节：
- spawn `cloudflared tunnel --url http://localhost:3456`
- 监听 stderr，用正则 `/https:\/\/[a-z0-9-]+\.trycloudflare\.com/` 提取 URL
- 10秒超时，超时或失败返回 null
- 支持 `--tunnel=cloudflare|tailscale-serve|tailscale-funnel|auto|none`

### 第6层 — 其他辅助模块

| 模块 | 功能 |
|------|------|
| `port-detector.ts` | 检测本地监听的 dev server 端口 (3000, 5173, 8080等) |
| `port-proxy.ts` | HTTP 代理，`/preview/:port` → `localhost:port`，支持 WebSocket 代理 |
| `process-detector.ts` | 用 `ps` 命令检测系统中所有 Claude 进程 |
| `preferences.ts` | 用户偏好持久化 (如通知开关) |
| `scheduler.ts` | 定时任务，支持 cron 表达式，存 `~/.claude-code-remote/schedules.json` |
| `activity-detector.ts` | 检测 PTY 是否有活动 |

## 通信协议设计（关键）

WebSocket 采用**双通道**设计：

| 通道 | 方向 | 内容 |
|------|------|------|
| 文本帧 | Server → Client | 终端原始输出 (ANSI 颜色码保留) |
| 二进制帧 | Client → Server | JSON 控制消息 |
| 二进制帧 | Server → Client | JSON 事件通知 |

### 控制消息类型一览

**Session 操作:**
- `auth` — 认证
- `session:create` — 在指定 cwd 创建新 session
- `session:list` — 列出所有 session
- `session:discover` — 发现外部 Claude 进程
- `session:adopt` — 接管外部 Claude 进程
- `session:attach` — 附着到已有 session（回放历史）
- `session:destroy` — 销毁 session
- `resize` — 调整终端尺寸

**其他:**
- `image:upload` — 上传图片 (base64 → tmp 文件)
- `schedule:create/update/delete/list/trigger/runs/log` — 定时任务 CRUD
- `preferences:set` — 更新偏好设置

### 消息流示例

```
Client                          Server
  │                               │
  │── binary: {type:"auth",token} ─→│
  │←── binary: {type:"auth:success"}│
  │                               │
  │── binary: {type:"session:create", cwd:"/path"} ──→│
  │                               │  spawn claude in /path
  │←── binary: {type:"session:created", session:{id,cwd}}│
  │←── text: "$ claude\n..."      │  (PTY 输出流)
  │                               │
  │── text: "hello\n" ──────────→│  (用户输入发给 PTY)
  │←── text: "Claude: ..."       │
  │                               │
  │←── binary: {type:"session:input_required"} │ (检测到 ask_user)
```

## 前端 (`web/`)

- 原生 JS + xterm.js (CDN 加载)
- `app.js` — WebSocket 通信、终端渲染、多 tab 管理
- `sw.js` — Service Worker，当 Claude 等待用户输入时发推送通知
- 移动端适配: 桌面用 tabs 布局，手机用下拉菜单

## 对比：我们要做的改造

| 层 | claude-code-remote | 我们的方案 |
|----|-------------------|-----------|
| 客户端 | xterm.js 终端 (浏览器) | Chatbox (OpenAI API) |
| 通信协议 | WebSocket (文本+二进制) | HTTP SSE (OpenAI 格式) |
| 会话载体 | node-pty 伪终端 (常驻) | subprocess `claude --print` (短命令) |
| 会话续接 | PTY 进程一直运行 | `claude --print --resume <id>` |
| 输出处理 | 原样转发 ANSI 文本 | 解析 `stream-json` 转 SSE |
| 认证 | 8位 hex token | Bearer token (可复用设计) |
| 隧道 | spawn cloudflared | **直接复用** |
| Claude CLI 探测 | 三重回退 | **直接复用** |
