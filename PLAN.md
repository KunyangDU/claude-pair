# Remote Vibing — 手机远程遥控 Claude Code

## 1. 概述

在手机上通过 Chatbox 发送消息 → 自己的域名 → 内网穿透到 Mac → 调起 Claude Code 干活。

```
手机 Chatbox (OpenAI API)
    ↓ HTTPS
claude.your-domain.com (Cloudflare Tunnel)
    ↓
Mac Express Server :8787
    ↓ spawn claude --print --resume <id>
Claude Code CLI
    ↓
DeepSeek API
```

核心技术栈：**Node.js + Express**。整个项目本质是一个消息转发器——HTTP 请求 → subprocess → SSE 流返回。`claude-code-remote` 已证明 Express + spawn 这套组合在这个场景稳定可靠，且 Claude CLI 探测、Cloudflare Tunnel、Token 认证等模块可直接复用。

## 2. 使用流程

### 2.1 Chatbox 配置

在 Chatbox 中为每个工作场景创建一个 Assistant：

| 配置项 | 值 |
|--------|-----|
| Provider | 自定义 (OpenAI 兼容) |
| URL | `https://claude.your-domain.com/v1` |
| API Key | 与 `config.yaml` 中一致 |
| Model | `claude-code` (固定值即可) |
| 系统提示词 | 见下方格式 |

### 2.2 系统提示词格式

```
[folder: /Users/dukunyang/本地资料/AI/agent]
[session: d346e4f2-acd5-494e-ac48-7ab512574835]
[permission: ask]
---
你是一个 AI 编程助手，擅长后端开发。
```

- `[folder: ...]` — 项目文件夹路径，**必填**
- `[session: ...]` — Claude Code session ID，**可选**。不填则自动创建新 session
- `[permission: ask|auto]` — **可选**，默认 `ask`
  - `ask`：不传 `--permission-mode`，Claude 使用默认权限（工具调用需确认）
  - `auto`：传 `--permission-mode acceptEdits`，编辑和命令自动执行（适合信任的简单任务）
- `---` 之后 — 真正的 system prompt，原样传给 Claude Code

**解析规则（宽松匹配）：**

- 正则 `/\[folder:\s*(.+?)\]/`、`/\[session:\s*(.+?)\]/`、`/\[permission:\s*(.+?)\]/`，允许等号两边有空格
- 提取到的值做 trim，空值视为未设置
- `folder` 缺失或目录不存在返回 400，其余标记全部可选
- 未识别的 `[xxx: ...]` 行不报错，视为系统提示词的一部分原样保留

### 2.3 Session 管理

每个 session 对应 Claude Code 的一个 `.jsonl` 对话文件，存在于 `~/.claude/projects/<项目hash>/<uuid>.jsonl`。所有入口（VSCode / terminal / --print）共享同一份对话文件，可互相续接。

```
[session] 字段的值          →  行为
──────────────────────────────────────────
不填 / 空                   →  claude --print --session-id <new_uuid>   (新建)
"new"                       →  同上，强制新建（忽略已有 session）
"continue"                  →  claude --print --continue                (续接最近一次)
<uuid>                      →  claude --print --resume <uuid>           (续接指定 session)
```

**典型工作流：**

1. 电脑 VSCode 里和 Claude 对话，做到一半要出门
2. 从 `~/.claude/projects/<hash>/` 找到 session 文件名（即 UUID）
3. 在 Chatbox 系统提示词填入 `[session: <uuid>]`
4. 手机上继续对话
5. 回到电脑，`claude --resume` 或 VSCode 里继续

## 3. 系统设计

### 3.1 API 端点

提供 OpenAI 兼容的最小接口集：

```
GET  /health               → { "status": "ok" }
GET  /v1/models            → { "data": [{"id":"claude-code","object":"model"}] }
GET  /v1/sessions?folder=  → { "sessions": [{"id":"uuid","updatedAt":"..."}, ...] }
POST /v1/chat/completions  → SSE 流式响应
```

`GET /v1/sessions` 读取 `~/.claude/projects/<hash>/` 下的 `.jsonl` 文件列表，返回 session ID 和最后修改时间。用户在手机上借此发现可用 session，无需手动找 UUID。

`/v1/chat/completions` 的请求体使用标准 OpenAI Chat Completions 格式，Server 只取两样东西：
- `messages` 数组中 `role: "system"` 的内容 → 解析 `[folder]` / `[session]`
- `messages` 数组中最后一条 `role: "user"` 的内容 → 作为 Claude 的 prompt

`model`、`temperature` 等字段忽略（Claude Code CLI 本身由项目配置决定模型）。

### 3.2 流式转发管道

Express 的 `res` 是一个 Writable Stream，每 `res.write()` 一次，数据立刻推送到客户端，无需等待 Claude 执行完成。

```
spawn claude --output-format stream-json --verbose
    ↓ child.stdout (Readable)
readline 逐行解析 JSON
    ↓ 判断 type 字段 → 过滤/转换
res.write(SSE chunk) → Chatbox 逐字渲染
```

**stream-json → SSE 转换规则：**

```
stream-json 行                                      →  SSE 输出
{"type":"system","subtype":"init",...}               →  (跳过)
{"type":"assistant","content":[{"type":"thinking"}]} →  (跳过，不暴露思考过程)
{"type":"assistant","content":[{"type":"text"}]}     →  data: {"choices":[{"delta":{"content":"..."}}]}\n\n
{"type":"result",...}                                →  data: [DONE]\n\n
```

**代码骨架：**

```javascript
// handler for POST /v1/chat/completions
res.setHeader('Content-Type', 'text/event-stream');
res.setHeader('Cache-Control', 'no-cache');
res.setHeader('Connection', 'keep-alive');
res.flushHeaders();

// 发送 ready 事件，告知用户 Claude 已启动
res.write(`data: ${JSON.stringify({
    choices: [{ delta: { content: '已连接...\n' } }]
})}\n\n`);

// 根据 [permission] 标记决定是否加 acceptEdits
const args = [
    '--print',
    sessionId ? '--resume' : '--session-id',
    sessionId || generateUUID(),
    '--output-format', 'stream-json',
    '--verbose',
    '--system-prompt', systemPrompt,
];
if (permission === 'auto') {
    args.splice(1, 0, '--permission-mode', 'acceptEdits');
}

const child = spawn(claudePath, args.concat(userMessage), { cwd: folder });
activeProcesses.add(child);

const rl = readline.createInterface({ input: child.stdout });

rl.on('line', (line) => {
    try {
        const json = JSON.parse(line);
        if (json.type === 'assistant') {
            const text = json.message.content.find(c => c.type === 'text');
            if (text) res.write(`data: ${JSON.stringify({
                choices: [{ delta: { content: text.text } }]
            })}\n\n`);
        }
        if (json.type === 'result') {
            res.write('data: [DONE]\n\n');
            res.end();
        }
    } catch (e) {
        // 非 JSON 行（stderr 混入、启动日志等），忽略，不中断流
    }
});

child.stderr.on('data', (d) => { /* log only */ });
child.on('error', (err) => {
    if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
        res.end();
    }
});
child.on('exit', (code, signal) => {
    activeProcesses.delete(child);
    resetIdleTimer();
    tryShutdown();
    // 非零退出：Claude 崩溃、超预算、配置错误等
    if (code !== 0 && !res.writableEnded) {
        const msg = signal
            ? `Claude 进程被信号 ${signal} 终止`
            : `Claude 进程异常退出 (code ${code})`;
        res.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
    }
});

// 客户端断开时，终止子进程避免僵尸
res.on('close', () => {
    if (!child.killed) child.kill();
});
```

> 补充：`stream-json` 的 `type` 值在工具调用/权限确认/错误等场景下可能不同，开发时需先跑一次端到端测试，收集各种场景的输出样例，补全转换规则表中 `tool_use` / `tool_result` / `error` 等类型。

> 和 `claude-code-remote` 对比：它用 PTY → WebSocket send 推终端文本给 xterm.js；我们用 stdout → res.write 推 SSE 给 Chatbox。管道原理相同，只是协议和目标不同。

### 3.3 轻量化生命周期

目标：**需要时调起，用完自动退出**。作为 skill 使用时完全无感。

#### 重复启动检测

`server.listen()` 的 `error` 事件捕获 `EADDRINUSE`，已有实例则直接 exit 0，调起者知道可复用现有 URL。

#### 空闲自动退出

两级回收：HTTP 空闲 + Claude 子进程全部结束，两者同时满足且持续 5 分钟后自动退出。

```javascript
const activeProcesses = new Set();
let idleTimer = null;
let shuttingDown = false;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

function resetIdleTimer() {
    if (shuttingDown) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(tryShutdown, IDLE_TIMEOUT_MS);
}

function tryShutdown() {
    if (shuttingDown) return;
    if (activeProcesses.size === 0) {
        shuttingDown = true;
        cleanupTunnel();
        server.close(() => {
            // close() 只拒绝新连接，已建立的 SSE 连接可能还在
            if (activeProcesses.size === 0) {
                process.exit(0);
            }
            // 否则等待子进程 exit 事件触发最终清理
        });
    }
}

// 中间件：任何 HTTP 请求重置计时
app.use((req, res, next) => { resetIdleTimer(); next(); });

// Claude 进程退出时也检查
child.on('exit', () => {
    activeProcesses.delete(child);
    resetIdleTimer();
    tryShutdown();
});
```

#### Session 隔离

每个 HTTP 请求独立 spawn 一个 Claude 子进程，各自不共享内存。同一 session 的并发请求由 Claude CLI 内部文件锁保护。Chatbox 同一 Assistant 同一时间只有一次对话，不会冲突。

#### 完整启停时序

```
remote-vibing serve
    ├─ 端口检测 → 已占用 → exit 0
    └─ 未占用
        ├─ startTunnel() → cloudflared 子进程 → 解析 URL
        ├─ server.listen(8787)
        └─ 打印: "Remote: https://claude.your-domain.com/v1"

        运行时状态
        ├─ HTTP 请求 ─→ resetIdleTimer()
        ├─ spawn Claude ─→ activeProcesses.add(child)
        └─ child.on('exit') ─→ activeProcesses.delete(child)
                                └─ resetIdleTimer() + tryShutdown()

        退出条件
        └─ 5分钟无请求 + activeProcesses.size === 0
            └─ cleanupTunnel() → server.close() → process.exit(0)
```

## 4. 项目结构

```
remote-vibing/
├── server.js              # Express 入口 (路由 + 生命周期管理)
├── lib/
│   ├── parse-prompt.js    # 解析系统提示词 [folder] / [session] / [permission]
│   ├── claude-runner.js   # spawn Claude, stream-json → SSE 转换
│   ├── claude-find.js     # 探测 claude 可执行文件路径
│   ├── auth.js            # Bearer Token 认证中间件
│   └── tunnel.js          # Cloudflare Tunnel 启停
├── config.yaml            # 用户配置文件 (gitignore 防止泄露密钥)
├── .gitignore
└── package.json
```

### 各模块职责

**`server.js`** — 组装一切。注册路由、挂载中间件、管理 server/tunnel 生命周期、空闲回收逻辑。

**`lib/parse-prompt.js`**
- 入：系统提示词字符串
- 出：`{ folder, sessionId, permission, systemPrompt }`
- 宽松正则 `/\[folder:\s*(.+?)\]/`、`/\[session:\s*(.+?)\]/`、`/\[permission:\s*(.+?)\]/` 提取标记，值做 trim
- `---` 分割出真实 system prompt
- folder 缺失或目录不存在 → 400；其余标记全部可选

**`lib/claude-runner.js`**
- 入：`{ folder, sessionId, message, systemPrompt }`
- 出：SSE 格式的 Readable Stream（通过回调写入 Express res）
- 根据 `sessionId` 选择 `--resume` / `--session-id` / `--continue`
- 逐行解析 stream-json，类型判断，SSE 转换

**`lib/claude-find.js`** — 复用 `claude-code-remote` 的三重回退：
1. `CLAUDE_PATH` 环境变量
2. `which claude`
3. 回退路径：`~/.local/bin/claude` / `/opt/homebrew/bin/claude` / `/usr/local/bin/claude` / `/usr/bin/claude`

**`lib/auth.js`** — Bearer Token 中间件。读取优先级：`REMOTE_VIBING_API_KEY` 环境变量 → `config.yaml` 的 `auth.api_key`。对比请求 `Authorization: Bearer <token>`，不匹配返回 401。

**`lib/tunnel.js`** — 封装 cloudflared 子进程的启停：
- `start(config)` → spawn cloudflared → 从 stderr 解析 URL → resolve
- `stop()` → kill 子进程
- 支持 `quick` (临时 trycloudflare URL) 和 `named` (自有域名) 两种模式

## 5. 配置与部署

### 5.1 config.yaml

```yaml
# API Key 支持两种方式，优先级：环境变量 > 配置文件
#   1. 环境变量: export REMOTE_VIBING_API_KEY="xxx"
#   2. 配置文件: 下方 auth.api_key（不设置 API Key 的话可省略）
auth:
  # api_key: "your-secret-key"
server:
  port: 8787
tunnel:
  mode: "named"                # "quick" 或 "named"
  # --- 以下 named 模式专用 ---
  name: "remote-vibing"        # cloudflared tunnel create 的名字
  domain: "claude.your-domain.com"
```

> `.gitignore` 中应包含 `config.yaml`，防止误提交泄露 API Key。

### 5.2 Cloudflare Tunnel 初始化（一次性）

```bash
# 1. 安装
brew install cloudflared

# 2. 授权 DNS 管理（浏览器弹窗确认）
cloudflared tunnel login

# 3. 创建隧道并绑定域名
cloudflared tunnel create remote-vibing
cloudflared tunnel route dns remote-vibing claude.your-domain.com

# 4. 配置 config.yaml 的 tunnel 部分
#    然后每次 serve 会自动使用
```

quick 模式无需任何初始化，每次启动得到一个临时 `*.trycloudflare.com` URL。

### 5.3 启动

```bash
# 安装依赖
npm install

# 启动（首次自动初始化 tunnel）
node server.js
# 输出:
#   Local:  http://localhost:8787
#   Remote: https://claude.your-domain.com/v1
```

## 6. 验证

```bash
# 测试新建 session（不指定 [session]）
curl -X POST http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer your-secret-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-code",
    "messages": [
      {"role":"system","content":"[folder: /Users/dukunyang/本地资料/AI/remote vibing]\n---"},
      {"role":"user","content":"列出当前目录文件"}
    ],
    "stream": true
  }'

# 测试续接 session
curl -X POST http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer your-secret-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-code",
    "messages": [
      {"role":"system","content":"[folder: /Users/dukunyang/本地资料/AI/remote vibing]\n[session: <上一步返回的id>]\n---"},
      {"role":"user","content":"上一个消息你说了什么？"}
    ],
    "stream": true
  }'
```
