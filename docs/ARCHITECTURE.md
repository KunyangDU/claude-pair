# claude-pair 架构

HTTP 消息转发器：OpenAI 兼容请求 → spawn Claude CLI → SSE 流返回。

## 架构图

```
手机 Chatbox (OpenAI API 格式)
    ↓ HTTPS
your-domain.com (任意 HTTPS Tunnel)
    ↓ 内网转发 :8787
Express Server (server.js)
    ├─ 解析 System Prompt 纯文本 → {folder, sessionId, permission}
    ├─ spawn claude --print --resume <id>
    └─ stream-json → SSE 转换
Claude Code CLI
    ↓
API (DeepSeek / Anthropic)
```

## 数据流

```
POST /v1/chat/completions
  messages[].role="system" → 纯文本: sessionId 或 /path 或 空
  messages[].role="user"   → "用户消息"
      ↓
parse.js                   → 纯文本检测: 空=defaultFolder, /开头=路径, 其他=sessionId
      ↓
route.js                   → 编排: 校验 → 审批检测 → 生命周期跟踪
      ↓
runner.js                  → spawn claude --print --resume <id> --output-format stream-json --verbose
      ↓                         ↓ spawn claude --permission-mode acceptEdits (仅在 auto 或审批时)
readline 逐行解析 stdout    → JSON 行 → 类型判断 → SSE chunk
      ↓
res.write(data: {...}\n\n)  → Chatbox 流式渲染
```

## API 端点

| 方法 | 路径 | 认证 | 说明 |
|------|------|------|------|
| GET | `/health` | 无 | 健康检查 |
| GET | `/v1/models` | 无 | 返回 `[{"id":"claude-code"}]` |
| GET | `/v1/sessions?folder=/path` | Bearer | 列出项目下所有 session |
| POST | `/v1/chat/completions` | Bearer | 主对话端点，仅支持 SSE streaming |

## System Prompt 格式

Chatbox 的 System Prompt 直接填纯文本，无需 JSON：

```
08c8562f-4a08-4a2a-aaab-869d0e720863
```

| 输入 | 识别 | 行为 |
|------|------|------|
| 空字符串 | — | 使用 config 中 `default_folder` |
| `/` 或 `C:\` 开头 | 绝对路径 | 在该目录创建新 session |
| 其他字符串 | sessionId | 续接已有 session（文件夹自动从 JSONL 推导） |

权限模式固定为 `"ask"`（只读），审批通过或 `auto` 模式由 `--permission-mode` 参数控制。

与旧版 JSON 格式的区别：不再需要 `{"folder":"...","session":"..."}` ，直接粘贴 session ID 或路径即可。`parse.js` 做纯文本检测，sessionId 上限 100 字符防止恶意输入。

## 权限模型

### ask 模式（默认）

不带 `--permission-mode`，Claude 可读不可写。Edit/Write 被系统拒绝后，server 检测 `permission_denials` 事件，流式输出审批提示。

```
Claude 尝试 Edit → 系统拒绝 → SSE 输出 "回复「允许」执行 Edit"
用户回复 "允许" → isApprovalMessage() 检测 → 本次改为 permission=auto
→ 同一 session 重跑 → Claude 看到上下文继续 → 编辑成功
```

审批关键词精确匹配：`允许 同意 执行 继续 好的 可以 批准 确认 行 yes ok go approve proceed confirm y`

否定词拒绝：`不 别 取消 拒绝 否 no n stop cancel deny`

### auto 模式

带 `--permission-mode acceptEdits`，Claude 可以直接执行命令和编辑文件。

## Session 管理

Session 是 `~/.claude/projects/<hash>/<uuid>.jsonl` 文件。所有入口（VSCode / terminal / `--print`）共享。

### sessionId → CLI 参数路由

```
sessionId 值              → CLI 参数              → 文件夹来源
──────────────────────────────────────────────────────────────
空 / "new"               → --session-id <new UUID>  → system prompt 或 default_folder
"continue"               → --continue               → system prompt 或 default_folder
<id> (JSONL 已存在)       → --resume <id>            → JSONL 中 "cwd" 字段自动推导
<id> (JSONL 不存在)       → --session-id <id>        → system prompt 或 default_folder
```

### findSession() — 从 sessionId 反查 folder

遍历 `~/.claude/projects/` 下所有项目目录，查找 `<sessionId>.jsonl`：
1. sessionId 白名单：`/^[a-zA-Z0-9_-]+$/`，拒绝特殊字符
2. 文件大小限制：跳过超过 256KB 的会话文件（防止异常大文件撑爆内存）
3. 扫描前 100 行 JSONL，正则匹配 `"cwd":"<path>"` 提取工作目录
4. 返回 `{found, folder}`，folder 可能为 null（session 存在但解析失败）

### Session 并发安全

`route.js` 中 `sessionMeta` 采用原子整体赋值，避免 folder 和 sessionId 在不同并发请求间错配：

```js
sessionMeta = {
    folder: opts._effectiveFolder || parsed.folder,
    sessionId: opts._effectiveSessionId || parsed.sessionId,
};
```

## 流式管道

### stream-json → SSE 转换

```
stream-json 行                         → SSE 输出
───────────────────────────────────────────────────
error                                  → data: {"error":"..."} + [DONE] + end，同时 kill 子进程
system/init                            → (跳过，记录 session_id)
assistant → content[].type=text        → data: {"choices":[{"delta":{"content":"..."}}]}
assistant → content[].type=thinking    → (跳过)
user → tool_result (is_error:true)     → (跳过，不暴露中间错误)
result (无 permission_denials)          → data: [DONE]
result (含 permission_denials)          → 审批提示 + data: [DONE]
```

### endStream() — 流结束保护

所有退出路径（正常 result、error 事件、进程崩溃、超时、断连）统一走 `endStream()`：

- `streamEnded` 标志位：防止多次调用（timeout 和 exit 事件竞态）
- `res.writableEnded` 检查：防止向已关闭的连接写入
- 错误消息通过 SSE `error` 字段传递，然后写 `[DONE]` + `res.end()`

### 进程保护

- **超时**：单个 Claude 进程最长执行 10 分钟，超时 kill + endStream
- **断连**：客户端 `res.on('close')` 时立即 kill 子进程
- **错误**：子进程 `error` 事件、非零 exit code、signal 终止 → endStream 错误消息
- **Claude 内部错误**：stream-json 的 `type: "error"` 事件 → kill + endStream

## Server 生命周期

```
启动
  ├─ 配置加载：~/.claude-pair/config.yaml（不存在则自动创建）
  │   └─ 错误分级：ENOENT → 静默默认 / EACCES → 警告 / 其他 → 告警
  ├─ CLI 分发：claude-pair serve → startServer()
  ├─ 端口校验：parseInt + 范围检查 (1024-65535)，非法值回退 8787
  ├─ 端口检测 → EADDRINUSE → exit 0（避免重复启动）
  └─ listen(port) → 启动 3h 空闲计时器

运行时
  ├─ HTTP 请求 → resetIdleTimer()
  ├─ 子进程退出 → resetIdleTimer()
  ├─ express.json({ limit: '1mb' }) — 拒绝超大请求体
  ├─ entity.parse.failed → 400 JSON
  ├─ entity.too.large → 413 JSON
  └─ 未处理异常 → 500 JSON (最终错误处理器)

退出
  ├─ 空闲退出：3h 无请求 + activeProcesses.size === 0
  ├─ SIGINT/SIGTERM：
  │   ├─ kill 所有活跃子进程
  │   ├─ 轮询 activeProcesses.size（每 100ms），最多等 3s
  │   └─ 超时或全部退出 → process.exit(0)
  └─ 收到请求时 shuttingDown=true → 返回 503
```

`activeProcesses` 是一个 `Set`，跟踪所有活跃的 Claude 子进程。`isShuttingDown()` 在收到信号时立即返回 true，新请求被拒绝。`createLifecycle()` 注入 `httpServer` 引用，空闲超时时调用 `server.close()`。

## 模块

| 模块 | 层级 | 职责 |
|------|------|------|
| `layers/input/parse.js` | input | System Prompt 纯文本解析（路径/sessionId/空）、sessionId 长度上限 100、用户消息提取 |
| `layers/input/auth.js` | input | Bearer Token 认证，未配置 API key 时自动降级免认证 |
| `layers/input/naming.js` | input | Chatbox 自动命名检测 & 响应 |
| `layers/core/route.js` | core | 路由编排：shutdown 503、空 messages 400、审批检测、sessionMeta 原子赋值防并发错配、child=null 处理 |
| `layers/core/lifecycle.js` | core | 空闲超时 (3h)、SIGINT/SIGTERM 优雅退出（kill 子进程 + 最多等 3s）、`isShuttingDown()` 状态暴露 |
| `layers/core/approval.js` | core | ask→auto 审批关键词精确匹配 & 否定词拒绝 |
| `layers/core/session.js` | core | 从 sessionId 反查 folder（JSONL 扫描、cwd 提取、文件大小限制 256KB） |
| `layers/output/runner.js` | output | spawn Claude CLI、stream-json→SSE 转换、endStream 防竞态、Claude error 事件处理、超时/断连保护 |
| `layers/output/find.js` | output | Claude CLI 路径探测（跨平台：which/where + fs.accessSync） |
| `server.js` | — | 薄入口：YAML 配置加载（ENOENT/EACCES 分级）、express.json(1mb)、entity.too.large (413)、端口校验 (1024-65535)、最终错误处理器 (500 JSON)、CLI 分发 |

## 项目结构

```
claude-pair/
├── server.js                  # 薄入口：配置、Express、CLI
├── layers/
│   ├── input/                 # 公网输入接口（Chatbox → 数据）
│   │   ├── parse.js           #   System Prompt 解析
│   │   ├── auth.js            #   Bearer Token 认证
│   │   └── naming.js          #   自动命名检测
│   ├── core/                  # 中转编排（数据处理、路由）
│   │   ├── route.js           #   路由 & 管道编排
│   │   ├── lifecycle.js       #   空闲超时 & 优雅退出
│   │   ├── approval.js        #   审批策略
│   │   └── session.js         #   Session 查找 & cwd 推导
│   └── output/                # 本地 agent 接口（→ Claude CLI）
│       ├── runner.js          #   spawn & stream 转换
│       └── find.js            #   CLI 路径探测
├── lib/tunnel.js               # Cloudflare Tunnel 启停（独立工具）
├── config.example.yaml
├── skill.md
├── docs/
├── package.json
└── README.md
```
用户配置存放在 `~/.claude-pair/config.yaml`（首次运行自动创建）。
