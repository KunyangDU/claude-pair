# PLAN-REVIEW-1: Remote Vibing 设计审查

## 审查概要

| 维度 | 评级 | 说明 |
|------|------|------|
| 架构清晰度 | 好 | 模块划分合理，职责单一 |
| 安全性 | 需改进 | 多项安全隐患，详见下文 |
| 可维护性 | 好 | 复用 claude-code-remote 模式，降低认知负担 |
| 容错性 | 不足 | 多处缺少异常路径处理 |

---

## 1. 安全问题（高优先级）

### 1.1 `--permission-mode acceptEdits` 是危险的默认值

[PLAN.md:125](PLAN.md#L125) 设定 `acceptEdits` 以避免手机端权限弹窗阻塞。这意味着任何通过认证的人都可以让 Claude 在 Mac 上执行任意文件写入和 Shell 命令，**无需确认**。

**建议**：拆分为两种模式，由 Chatbox 系统提示词中的标记控制：

```
[permission: ask]      → 不传 --permission-mode（默认行为，需确认）
[permission: auto]     → --permission-mode acceptEdits（用户明确授权的场景）
```

或者更安全的方式：`acceptEdits` 仅允许文件编辑，Shell 命令仍需要确认：

```
--permission-mode acceptEdits --permission-mode-tool-hook '{"Bash":"ask"}'
```

**原因**：手机端通常用于进度查询、简单问答等只读场景，不应默认开放全部权限。一旦 Bearer Token 泄露，攻击者可获得完整的远程代码执行能力。

### 1.2 Bearer Token 明文存储在 config.yaml

[PLAN.md:269](PLAN.md#L269) `api_key` 直接写在 YAML 文件中。如果这个文件被意外提交到 Git，密钥就泄露了。

**建议**：
- 支持从环境变量读取：`auth.api_key: "${API_KEY}"` 或直接读 `process.env.REMOTE_VIBING_API_KEY`
- 在代码中加入 `.gitignore` 检查逻辑，启动时若检测到 `config.yaml` 被 Git 跟踪则打印警告

**原因**：YAML 配置文件很容易被误提交。环境变量是更安全的 secrets 管理方式，也是 12-Factor App 的标准实践。

### 1.3 Session ID 泄露风险

[PLAN.md:66](PLAN.md#L66) 用户需要手动从 `~/.claude/projects/<hash>/` 找到 UUID 文件名填入 Chatbox。这个 UUID 一旦填入 Chatbox 的配置中，就永久存储在 Chatbox 的本地数据库里（通常是明文）。

**建议**：
- 考虑支持一个简短的 session 别名映射（`session-alias: "my-session"` → `<uuid>`），存在 server 侧内存中
- 或在文档中提醒用户：session ID 与对话历史直接关联，不应分享给他人；Chatbox 配置导出时注意清除

**原因**：UUID 虽然不是高敏感凭证，但它关联了完整的对话历史。用户可能意识不到这个信息暴露面。

---

## 2. 架构设计问题

### 2.1 空闲退出的竞态条件

[PLAN.md:167-195](PLAN.md#L167-L195) 空闲计时器的实现存在竞态：

```javascript
function tryShutdown() {
    if (activeProcesses.size === 0) {
        cleanupTunnel();
        server.close(() => process.exit(0));
    }
}
```

**问题**：在 `tryShutdown` 检查 `activeProcesses.size === 0` 之后、`server.close()` 之前，新的请求可能到达并 spawn 了新的子进程。`server.close()` 会阻止新连接但已有连接不受影响——然而 `process.exit(0)` 会立即杀死新 spawn 的子进程。

**建议**：
```javascript
let shuttingDown = false;

function tryShutdown() {
    if (shuttingDown) return;
    if (activeProcesses.size === 0) {
        shuttingDown = true;
        server.close(() => {
            // server.close() 后仍可能有活跃子进程，等待它们
            if (activeProcesses.size === 0) {
                cleanupTunnel();
                process.exit(0);
            }
            // 否则注册 exit 事件等待
        });
    }
}
```

**原因**：并发场景下的 TOCTOU（Time-of-check Time-of-use）问题是经典竞态条件，需要引入状态标记来防护。

### 2.2 `res.write()` 后直接 `res.end()` 缺少背压处理

[PLAN.md:135-138](PLAN.md#L135-L138) 代码骨架中 `res.write()` 返回值被忽略。当客户端网络慢时（手机端网络不稳定），内部缓冲区可能爆满。

**建议**：
```javascript
const canContinue = res.write(chunk);
if (!canContinue) {
    child.stdout.pause();
    res.once('drain', () => child.stdout.resume());
}
// 同时处理 child 退出时 res 已关闭的情况
res.on('close', () => {
    if (!child.killed) child.kill();
});
```

**原因**：`Writable.write()` 返回 `false` 时表示内部缓冲区已满，继续写入会导致内存膨胀。在移动网络场景下，这可能导致 server 进程内存泄漏或 OOM。

### 2.3 `JSON.parse(line)` 缺少异常处理

[PLAN.md:133](PLAN.md#L133) 直接 `JSON.parse(line)` 没有 try-catch。Claude CLI 的 stderr 输出、启动信息等可能混入 stdout 导致解析失败，进而整个流中断。

**建议**：
```javascript
rl.on('line', (line) => {
    try {
        const json = JSON.parse(line);
        // ... 处理逻辑
    } catch (e) {
        // 非 JSON 行通常来自 stderr 混入或子进程的启动日志
        debug && console.error('skip non-json line:', line.slice(0, 120));
    }
});
```

**原因**：子进程的 stdout 不保证每行都是合法 JSON。不加保护的 `JSON.parse` 会让一个意外的输出行导致进程崩溃。

### 2.4 system prompt 解析依赖固定格式，容错性差

[PLAN.md:44-48](PLAN.md#L44-L48) `[folder: ...]` 和 `[session: ...]` 的解析要求精确格式。用户多打一个空格、换行不一致都会导致 `folder` 提取失败返回 400。

**建议**：
- 正则使用宽松匹配：`/\[folder:\s*(.+?)\]/` 允许空格
- 对 session 值做 trim
- 如果 `[folder]` 缺失，不立即 400，而是检查是否有默认的 folder 配置

**原因**：手机端输入体验差，用户很容易引入格式错误。宽松解析能显著减少"用不起来"的挫败感。

---

## 3. 功能完整性问题

### 3.1 缺少 stop/interrupt 机制

在手机上发了一条消息后，如果 Claude 陷入死循环或返回过长内容，用户没有途径中断。

**建议**：
- 增加 `POST /v1/chat/completions/stop` 端点
- 或将 `DELETE /v1/chat/completions?session=<id>` 作为中断接口
- Server 侧维护 session → childProcess 的映射，收到中断请求时 `child.kill('SIGTERM')`

**原因**：远程控制场景下，中断能力与发送能力同等重要。缺少它会导致用户被迫等待或手动 SSH 到 Mac 杀进程。

### 3.2 session 列表不可见

用户需要手动导航到 `~/.claude/projects/<hash>/` 找 UUID，这在手机上无法完成。

**建议**：
- 增加 `GET /v1/sessions?folder=<path>` 返回该项目的 session 列表及最后一条消息摘要
- 或在启动时通过 Chatbox 的系统提示词返回可用 session 列表

**原因**：发现 session 是续接对话的前提。让用户手动查找 UUID 违背了"手机远程"的便利性目标。

### 3.3 `child.on('error')` 只捕获 spawn 失败，不捕获进程崩溃

[PLAN.md:147-150](PLAN.md#L147-L150) 只有 `child.on('error')`，但缺少 `child.on('exit')` 处理非零退出码的情况（例如 Claude CLI 自身崩溃、配置错误等）。

**建议**：
```javascript
child.on('exit', (code, signal) => {
    if (code !== 0 && !res.writableEnded) {
        const errMsg = signal
            ? `claude进程被信号 ${signal} 终止`
            : `claude进程异常退出，退出码: ${code}`;
        res.write(`data: ${JSON.stringify({ error: errMsg })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
    }
});
```

**原因**：非零退出码意味着用户消息未正常处理完成，但 Chatbox 侧会一直等待，需要主动通知。

---

## 4. 可维护性建议

### 4.1 `stream-json → SSE` 转换应抽取为独立的 Transform Stream

[PLAN.md:101-109](PLAN.md#L101-L109) 转换逻辑直接在路由 handler 中实现，不利于测试和复用。

**建议**：实现为一个 `Transform` stream：

```javascript
// lib/sse-transform.js
class ClaudeToSSE extends Transform {
    _transform(line, encoding, callback) {
        // 解析 + 转换逻辑
    }
}
```

**原因**：
- 可直接用单元测试验证转换逻辑，无需启动完整 server
- 如果将来需要支持 WebSocket 或其他协议，转换逻辑可复用
- Transform stream 自动处理背压

### 4.2 硬编码的 `res.write()` SSE 格式

SSE 构造逻辑散落在多处。建议封装一个 `SSEWriter` 或直接用一个工具函数：

```javascript
function sendSSE(res, event, data) {
    const lines = [];
    if (event) lines.push(`event: ${event}`);
    lines.push(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
    lines.push('', '');
    return res.write(lines.join('\n'));
}
```

### 4.3 缺少结构化日志

整个设计中没有提到日志方案。在生产环境中排查问题会非常困难。

**建议**：
- 使用 `pino` 或简单的 JSON 格式日志
- 每个请求分配 `requestId`，贯穿所有日志
- 记录：请求到达、session 解析结果、spawn 启动、stream 开始/结束、错误

---

## 5. 性能考量

### 5.1 每个请求 spawn 一个 Claude CLI 进程

[PLAN.md:120](PLAN.md#L120) 这个设计是正确的——Claude CLI 本身不设计为常驻服务，且每个 session 的对话状态由 .jsonl 文件管理。启动开销（约 500ms-1s）在远程对话场景中可接受。

**无需优化**，但建议在用户体验上体现：spawn 成功后立即发送一个 SSE 事件告知"Claude 已启动"，避免用户对着空白等待。

### 5.2 readline 逐行解析 vs 批量

[PLAN.md:130](PLAN.md#L130) `readline` 逐行处理是合适的——stream-json 每行就是一个完整的 JSON 事件，与 readline 的"遇到 `\n` 就触发"天然匹配。不需要引入更复杂的解析器。

---

## 6. 与 claude-code-remote 的差异点补充

PLAN.md 多次提到复用 `claude-code-remote` 的模式。有一处值得注意的差异：

claude-code-remote 使用 PTY → WebSocket，因为浏览器终端需要一个真实的 tty 来渲染 ANSI 转义序列。而 Remote Vibing 用 stdout → SSE，因为 Chatbox 只需要纯文本流。

**这带来一个隐含问题**：`--output-format stream-json` 的输出是否包含了所有用户交互信息？例如：
- 权限确认提示（如果关闭了 acceptEdits）
- 错误消息
- 工具调用结果

建议在开发初期做一个端到端的 `stream-json` 输出样例收集，确认各种场景的输出格式，特别是工具调用（tool_use/tool_result）的 type 值是什么，以补充 [PLAN.md:103-108](PLAN.md#L103-L108) 的转换规则表。

---

## 总结

| 优先级 | 问题数 | 关键项 |
|--------|--------|--------|
| 必须修复 | 4 | 1.1 权限模式、1.2 密钥存储、2.1 竞态条件、2.3 JSON解析异常 |
| 强烈建议 | 3 | 2.2 背压处理、3.1 中断机制、2.4 宽松解析 |
| 建议 | 4 | 4.1 Transform Stream、4.2 SSE 封装、3.2 Session 列表、3.3 exit 处理 |

**总体评价**：设计方向正确，架构简洁务实。主要问题集中在安全性（权限默认值、密钥管理）和异常路径处理上。建议在开始编码前先解决标记为"必须修复"的 4 个问题。
