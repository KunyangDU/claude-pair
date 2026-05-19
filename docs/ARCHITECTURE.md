# claude-pair 架构

HTTP 消息转发器：OpenAI 兼容请求 → spawn Claude CLI → SSE 流返回。

## 架构图

```
手机 Chatbox (OpenAI API 格式)
    ↓ HTTPS
your-domain.com (Cloudflare Tunnel)
    ↓ 内网转发 :8787
Express Server (server.js)
    ├─ 解析 System Prompt JSON → {folder, session, permission}
    ├─ spawn claude --print --resume <id>
    └─ stream-json → SSE 转换
Claude Code CLI
    ↓
API (DeepSeek / Anthropic)
```

## 数据流

```
POST /v1/chat/completions
  messages[].role="system" → {"folder":"/path","session":"<uuid>","permission":"ask"}
  messages[].role="user"   → "用户消息"
      ↓
parse-prompt.js            → 提取 folder / sessionId / permission
      ↓
claude-runner.js           → spawn claude --print --resume <id> --output-format stream-json --verbose
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

Chatbox 的 System Prompt 填写 JSON：

```json
{"folder": "/path/to/project", "session": "<uuid>", "permission": "ask"}
```

| 字段 | 必填 | 默认 | 说明 |
|------|------|------|------|
| `folder` | 是 | — | 项目绝对路径 |
| `session` | 否 | 自动新建 | UUID 续接 / `"new"` 强建 / `"continue"` 最近 |
| `permission` | 否 | `"ask"` | `"ask"` 只读+审批 / `"auto"` 读写 |

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

```
[session] 值              → CLI 参数
────────────────────────────────────
空 / 未设置               → --session-id <new UUID>
"new"                     → --session-id <new UUID>
"continue"                → --continue
<uuid> (已存在)            → --resume <uuid>
<uuid> (未存在)            → --session-id <uuid>   (先创建)
```

Session 存在性判断：遍历 `~/.claude/projects/` 下所有项目目录查找 `<uuid>.jsonl` 文件，输入经白名单校验 `[a-zA-Z0-9_-]+`。

## 流式管道

### stream-json → SSE 转换

```
stream-json 行                         → SSE 输出
───────────────────────────────────────────────────
system/init                            → (跳过，记录 session_id)
assistant → content[].type=text        → data: {"choices":[{"delta":{"content":"..."}}]}
assistant → content[].type=thinking    → (跳过)
user → tool_result (is_error:true)     → (跳过，不暴露中间错误)
result (无 permission_denials)          → data: [DONE]
result (含 permission_denials)          → 审批提示 + data: [DONE]
```

### 生命周期保护

- **超时**：单个 Claude 进程最长执行 10 分钟，超时自动 kill
- **断连**：客户端断开连接时立即 kill 子进程
- **错误**：子进程异常退出或崩溃时返回错误消息

## Server 生命周期

```
启动
  ├─ 端口检测 → EADDRINUSE → exit 0（避免重复启动）
  └─ listen(8787) → 启动 3h 空闲计时器

运行时
  ├─ HTTP 请求 → resetIdleTimer()
  └─ 子进程退出 → resetIdleTimer()

退出: 3h 无请求 + activeProcesses.size === 0
```

`activeProcesses` 是一个 `Set`，跟踪所有活跃的 Claude 子进程。关机前检查所有进程已结束。

## 模块

| 模块 | 职责 |
|------|------|
| `server.js` | Express 入口，路由注册，生命周期管理，审批检测 |
| `lib/parse-prompt.js` | System Prompt JSON 解析 + 用户消息提取 + 命名请求检测 |
| `lib/claude-runner.js` | spawn Claude CLI，stream-json → SSE 转换，超时保护 |
| `lib/claude-find.js` | Claude CLI 路径探测（env → PATH → 硬编码回退） |
| `lib/auth.js` | Bearer Token 认证，无密钥时自动降级免认证 |
| `lib/tunnel.js` | Cloudflare Tunnel 启停封装（可独立使用） |

## 项目结构

```
claude-pair/
├── server.js
├── lib/
│   ├── parse-prompt.js
│   ├── claude-runner.js
│   ├── claude-find.js
│   ├── auth.js
│   └── tunnel.js
├── config.example.yaml
├── config.yaml          (gitignored)
├── docs/
│   ├── SETUP.md
│   ├── SETUP-CLOUDFLARED.md
│   └── ARCHITECTURE.md
├── package.json
└── README.md
```
