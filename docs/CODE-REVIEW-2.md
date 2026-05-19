# CODE-REVIEW-2: 异常处理审查

> 审查日期: 2026-05-19
> 审查范围: 全项目异常处理、错误路径、资源管理

## 项目结构

三层架构，数据流：Chatbox → layers/input → layers/core → layers/output → Claude CLI

```
layers/
├── input/       # 公网输入接口
│   ├── parse.js    System Prompt 字符串 → {folder, sessionId, permission}
│   ├── auth.js     Bearer Token 认证
│   └── naming.js   Chatbox 自动命名检测 & 响应
├── core/        # 中转编排
│   ├── route.js    路由处理、管道编排
│   ├── lifecycle.js 空闲超时、优雅退出
│   └── approval.js  ask→auto 审批关键词
└── output/      # 本地 Claude 接口
    ├── runner.js   spawn Claude、stream-json→SSE、超时保护
    └── find.js     Claude CLI 跨平台路径探测
server.js         # 薄入口：配置加载、Express 组装、CLI 分发
```

---

## 1. server.js — 入口与配置加载

### 🔴 严重问题

| # | 问题 | 位置 |
|---|------|------|
| 1 | **静默吞噬配置错误** — `catch (_)` 把全部配置加载错误吞掉，包括文件损坏、权限错误。结果是用空配置 `{}` 启动，auth 被禁用。用户无法知道自己的 API key 没有被加载。 | L71-72, L76-78 |
| 2 | **JSON body 超大时不友好** — 只处理了 `entity.parse.failed`，没有处理 `entity.too.large`。1MB 以上的请求会返回 Express 默认 HTML 错误页，而非 JSON。 | L84-90 |
| 3 | **没有 final error handler** — JSON 解析失败之外的错误调用 `next(err)`，但 Express 没有注册最终错误处理器，会返回 HTML 给 API 客户端。 | L84-90 |
| 4 | **YAML 解析器无校验** — `parseSimpleYAML` 只支持两级缩进，对非法行静默跳过。拼写错误的配置键不会被检测。 | L36-60 |

### 🟡 中等问题

| # | 问题 | 位置 |
|---|------|------|
| 5 | **port 值无类型校验** — `config?.server?.port` 可能是 `"abc"` 或负数，`app.listen()` 会抛异常导致进程 crash。 | L126 |
| 6 | **CORS 过于宽松** — `Allow-Origin: *` + `Allow-Headers: *` 意味着任何网站都可发送带 `Authorization` 的请求。 | L93-95 |
| 7 | **`process.exit(0)` 掩盖异常退出** — EADDRINUSE 和 SIGTERM 都以 code 0 退出，监控系统无法区分正常退出和异常退出。 | L139, lifecycle.js L33 |

### 🟢 做得好的

- JSON body 大小限制 (`1mb`)
- JSON 解析错误有专门的错误中间件

---

## 2. layers/input/parse.js — System Prompt 解析

### 🟡 中等问题

| # | 问题 | 位置 |
|---|------|------|
| 8 | **无类型校验** — 如果 `raw` 是数字 `123` 或对象，`(123).trim()` 会抛 TypeError。虽然后端代码不会传这种类型，但这是公网输入入口。 | L10-11 |
| 9 | **sessionId 无字符校验** — 只校验长度，不校验字符。`"../../../etc/passwd"` 只有 23 字符，通过长度检查。好在 `findSession` 里有正则二次校验。 | L25-27 |

### 🟢 做得好的

- 空输入处理正确
- sessionId 长度限制（100字符）
- content 支持 string 和 array 两种格式

---

## 3. layers/input/auth.js — 认证

### 🟡 中等问题

| # | 问题 | 位置 |
|---|------|------|
| 10 | **无 timing-safe 比较** — Bearer token 使用 `!==` 直接比较，存在 timing leak。公网暴露时攻击者可逐字符猜测 API key。 | L18 |

### 🟢 做得好的

- 无 API key 时自动降级为无认证（本地开发友好）

---

## 4. layers/input/naming.js — 命名检测

### 🟡 中等问题

| # | 问题 | 位置 |
|---|------|------|
| 11 | **`res.write()` 无错误处理** — 两次 `res.write()` 都可能抛 `EPIPE` 异常（连接已断开），没有 try/catch。 | L29-34 |

### 🟢 做得好的

- 同时支持 stream 和 non-stream 两种响应格式

---

## 5. layers/core/route.js — 核心路由（问题最多）

### 🔴 严重问题

| # | 问题 | 位置 |
|---|------|------|
| 12 | **`sessionMeta` 在请求间共享** — `sessionMeta` 是 `createChatRoute` 的闭包变量，所有并发请求共享同一个引用。两个并发请求会互相覆盖对方的值，命名请求可能返回错误的 session 名。 | L15, L78-79 |
| 13 | **`_effectiveFolder` 读取时机脆弱的隐式依赖** — L78 读取 `opts._effectiveFolder`，但这个值是在 `runClaude()` 内部赋值的。依赖于 `runClaude` 同步执行完所有副作用这一隐含假设，重构时容易出错。 | L78 |
| 14 | **`sysMsg?.content` 的类型** — `'' || ''` 结果是 `''`（正确），但 `null || ''` 结果是 `''`（正确，因为 falsy）。如果 content 是 `0` 或 `false`，会被转为空字符串。实际上 `content` 不太可能是这些类型，但 `String(null)` 返回 `"null"` 的陷阱要注意。 | L41 |

### 🟡 中等问题

| # | 问题 | 位置 |
|---|------|------|
| 15 | **`child` 为 null 时连接挂起** — 如果 `runClaude` 返回 `null`（folder 为空），不进入 tracking 分支。但此时 SSE header 已发送（L63-66），没有任何 cleanup，客户端得到挂起的连接。 | L75, L63-66 |
| 16 | **`res.flushHeaders()` 后无错误处理** — SSE headers 已发送，如果后续 `res.write()` 失败，`EPIPE` 错误不会处理。 | L66, L92 |

### 🟢 做得好的

- shutdown 检查清晰
- 输入校验分层（messages 存在、user message 存在、stream 检查）
- 非 stream 请求直接拒绝

---

## 6. layers/core/lifecycle.js — 生命周期

### 🔴 严重问题

| # | 问题 | 位置 |
|---|------|------|
| 17 | **SIGTERM 不等待子进程清理** — `process.exit(0)` 在 `child.kill()` 后立即调用，子进程可能还未被操作系统清理。Claude CLI 可能留下僵尸进程或锁文件。 | L33 |

### 🟡 中等问题

| # | 问题 | 位置 |
|---|------|------|
| 18 | **`resetIdleTimer` 被从两处调用** — `server.js:120` 的中间件调用一次，`child.on('exit')` 又调用一次（route.js:85）。依赖两层调用保证正确性，耦合脆弱。 | L119-122, route.js:85 |
| 19 | **`tryShutdown` 的竞态窗口** — `server.close()` 是异步的，在其回调中再次检查 `activeProcesses.size === 0`。但如果 server.close() 期间有新进程创建（极端时序），这些进程不会被追踪。 | L24-27 |

### 🟢 做得好的

- idle timeout 机制合理
- shutdown 时拒绝新请求

---

## 7. layers/core/approval.js — 审批关键词

### 🟢 无明显问题

逻辑简单、有白名单和黑名单两重检查、长度限制防止误匹配。设计清晰。

---

## 8. layers/output/runner.js — Claude 进程管理

### 🔴 严重问题

| # | 问题 | 位置 |
|---|------|------|
| 20 | **stderr 内容不传给客户端** — Claude 的 `--verbose` 模式下，重要诊断信息输出到 stderr。当前只 `console.error` 记录，用户看不到。调试时很困难。 | L132-134 |
| 21 | **timeout 和 exit 竞态写 `[DONE]`** — `exit` 事件回调（L145）和 `timeout` 回调（L76）都尝试写 error + `[DONE]` + `res.end()`。虽然都有 `writableEnded` 检查，但 `res.write()` 在 `writableEnded` 检查后、实际写入前，另一个回调可能已经 `res.end()` 了。极端情况下可能有 `ERR_STREAM_WRITE_AFTER_END`。 | L76-83, L148-155 |

### 🟡 中等问题

| # | 问题 | 位置 |
|---|------|------|
| 22 | **`readline` 未在异常时 close** — spawn 失败时没问题（error 事件在 readline 创建之前），但如果 spawn 成功且 readline 出错（极少），`rl` 没有 close。 | L85-130 |
| 23 | **`child.stderr` 监听器未清理** — stderr 监听器在子进程退出后仍保持注册。子进程退出后 emitter 不再有新事件，不会造成内存泄漏，但不符合最佳实践。 | L132-134 |
| 24 | **session 文件无限读取** — `readFileSync(sessionPath)` 读取整个文件到内存。恶意或损坏的 session 文件可能非常大。应限制读取大小。 | L179 |
| 25 | **cwd 正则提取脆弱** — `"cwd"\s*:\s*"([^"]+)` 可能匹配到 message content 中的 `"cwd"` 字符串，导致解析出错误的文件夹路径。 | L181 |
| 26 | **`findSession` 遍历所有 project 目录** — 如果用户有大量项目，`readdirSync` 遍历所有目录可能较慢。 | L173 |

### 🟢 做得好的

- 超时保护（10分钟）
- 客户端断开时 kill 子进程
- `writableEnded` 检查防止写已关闭连接
- findSession 中 sessionId 有正则校验防路径遍历
- spawn 用数组参数防 shell 注入

---

## 9. layers/output/find.js — CLI 路径探测

### 🟡 中等问题

| # | 问题 | 位置 |
|---|------|------|
| 27 | **`execSync` 无 timeout** — `which/where` 在极端情况下可能挂起（网络文件系统、PATH 中有挂载点），阻塞整个请求。 | L22 |
| 28 | **每次请求都调用 `findClaude()`** — 路径不会变，每次请求都查一遍。应该缓存结果。 | 每次请求 via runner.js |

### 🟢 做得好的

- 多平台 fallback 路径（macOS Homebrew, Linux, Windows）
- 环境变量 `CLAUDE_PATH` 覆盖

---

## 场景专项检查

| 场景 | 处理情况 | 评价 |
|------|----------|------|
| **空 body** | JSON 解析失败 → 400 | 有 handler，但仅限 parse 错误 |
| **缺失字段** | messages 空 → 400；no user msg → 400 | 正确 |
| **并发请求到同一 session** | Claude CLI 本身可能冲突，server 无排队机制 | 无防护 |
| **Claude CLI 未安装** | findClaude 返回 null → SSE error | 正确 |
| **session 文件损坏** | readFileSync 异常被 catch 吞掉 → 找不到 session | 不报错给用户 |
| **客户端中途断开** | res.on('close') → kill child | 正确 |
| **审批中重复消息** | 正常路由，每条都是独立请求 | 正确 |
| **server 关闭期间收到请求** | isShuttingDown → 503 | 正确 |
| **Cloudflare Tunnel 断开** | 无特殊处理，行为同客户端断开 | 正确 |
| **sessionId 投毒** | findSession 正则校验 + route 长度限制 | 正确 |
| **res.write 抛 EPIPE** | 无 try/catch | 缺陷 |

---

## 按严重性汇总

### 🔴 必须修复（5个）

1. **#12 — sessionMeta 并发竞态**（数据正确性）
2. **#15 — stream headers 已发送但 child=null 时挂起连接**（资源泄漏）
3. **#1 — 配置错误静默吞噬**（安全）
4. **#21 — timeout/exit 竞态写**（潜在 crash）
5. **#17 — SIGTERM 不等待子进程**（僵尸进程）

### 🟡 建议修复（8个）

- #2 #3 #5 #10 #13 #14 #24 #27

### 🟢 低优先级（4个）

- #6 #22 #23 #26
