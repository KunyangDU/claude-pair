# Claude CLI `--print` 模式用法参考

## 基础用法

```bash
# 一次性对话（非交互）
claude --print "你的消息"

# 在指定目录执行
cd /path/to/project && claude --print "你的消息"
```

## Session 管理

### 创建与续接

```bash
# 创建指定 ID 的 session
claude --print --session-id "00000000-0000-0000-0000-000000000001" "你的消息"

# 续接已有 session（记忆保持）
claude --print --resume "00000000-0000-0000-0000-000000000001" "后续消息"

# 续接最近一次对话
claude --print --continue "后续消息"

# 不持久化 session（用完即弃）
claude --print --no-session-persistence "你的消息"

# Fork session（基于已有 session 创建分支，不影响原 session）
claude --print --resume <id> --fork-session "你的消息"
```

### Session 类型互通（重要）

**所有类型的 session 共享同一份对话存储，可以互相续接：**

| 创建方式 | kind | 能否被 `--resume` 续接 |
|---------|------|----------------------|
| `claude --print` | print | 能 |
| `claude` (terminal 交互) | interactive | 能 |
| VSCode 插件 Claude Code | interactive | 能 |
| `claude --print --no-session-persistence` | - | 不能（不写入磁盘） |

唯一限制：**不能 resume 正在运行中的 session**（文件被锁定），需等待原 session 退出。

### 如何找到 Session ID

```bash
# 方法1: 从项目存储目录找（文件名 = session ID）
ls ~/.claude/projects/-Users-dukunyang------AI-remote-vibing/
# 输出: d346e4f2-acd5-494e-ac48-7ab512574835.jsonl  (session ID = d346e4f2-...)

# 方法2: 从 session 元信息找（含 cwd、kind 等）
for f in ~/.claude/sessions/*.json; do
  echo "=== $f ===" && python3 -m json.tool "$f" 2>/dev/null
done

# 方法3: 在 Claude 对话中让它自己查
# "请执行 cat ~/.claude/sessions/ 下对应你当前进程的 json 文件，找到 sessionId 字段"
```

### 典型工作流：VSCode 创建 → 手机续接

```
1. 在 VSCode 里和 Claude 对话，完成任务的一部分
2. 从 ~/.claude/projects/<项目hash>/ 找到 session ID
3. 在 Chatbox 系统提示词中填入: [session: d346e4f2-acd5-494e-ac48-7ab512574835]
4. 手机上继续和同一个 Claude 对话
5. 回到电脑，VSCode 里 resume 或 --continue 继续
```

## 流式输出

```bash
# 流式 JSON 输出（需要 --verbose）
claude --print --output-format stream-json --verbose "你的消息"

# 流式 JSON 输出 + 指定 session
claude --print --session-id <uuid> --output-format stream-json --verbose "你的消息"
```

### stream-json 输出格式

每行一个 JSON 对象，共三种消息类型：

```json
// 1. 初始化（跳过，不发给用户）
{"type":"system","subtype":"init","cwd":"/path/to/project","session_id":"uuid-xxx","model":"deepseek-v4-pro","tools":[...],"mcp_servers":[...],...}

// 2. Assistant 消息（需要处理）
{"type":"assistant","message":{"id":"msg-id","type":"message","role":"assistant","model":"...","content":[{"type":"thinking","thinking":"..."}]}}
{"type":"assistant","message":{"id":"msg-id","type":"message","role":"assistant","model":"...","content":[{"type":"text","text":"回复内容"}]}}

// 3. 结果（流结束标志）
{"type":"result","subtype":"success","is_error":false,"duration_ms":5416,"num_turns":1,"result":"回复内容","session_id":"uuid-xxx","total_cost_usd":0.115,"usage":{...}}
```

### stream-json → OpenAI SSE 转换规则

| stream-json | SSE 输出 |
|-------------|----------|
| `type: "system"` | 跳过 |
| `content: [{type: "thinking"}]` | 跳过 |
| `content: [{type: "text", text: "..."}]` | `data: {"choices":[{"delta":{"content":"..."}}]}\n\n` |
| `type: "result"` | `data: [DONE]\n\n` |

## 系统提示词

```bash
# 设置系统提示词
claude --print --system-prompt "你是一个Python专家" "你的消息"

# 追加系统提示词
claude --print --append-system-prompt "当前项目使用FastAPI框架" "你的消息"
```

## 模型和预算

```bash
# 指定模型
claude --print --model "deepseek-v4-pro" "你的消息"

# 设置最大花费
claude --print --max-budget-usd 1.0 "你的消息"
```

## JSON 结构化输出

```bash
# 约束输出为 JSON Schema
claude --print --json-schema '{"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}' "提取这段话中的名字"
```

## 输出格式选项

```bash
# 纯文本（默认）
claude --print "消息"

# JSON 单次结果（流结束后返回完整结果）
claude --print --output-format json "消息"

# 流式 JSON
claude --print --output-format stream-json --verbose "消息"
```

## 权限控制

```bash
# 自动接受编辑（适合手机远程操控，避免权限弹窗阻塞）
claude --print --permission-mode acceptEdits "消息"

# 完全跳过权限检查（仅沙箱环境，注意安全）
claude --print --dangerously-skip-permissions "消息"

# 跳过权限 + 流式输出（手机远程操控推荐组合）
claude --print --permission-mode acceptEdits --output-format stream-json --verbose "消息"

# 限制可用工具
claude --print --tools "Read,Write,Edit,Bash" "消息"

# 允许额外目录
claude --print --add-dir /path/to/another/project "消息"
```

权限模式选项: `default` | `acceptEdits` | `auto` | `bypassPermissions` | `dontAsk` | `plan`

建议手机远程操控时使用 `acceptEdits`，既能自动执行文件操作，又保留了一定安全检查。

## Session 存储位置

```
~/.claude/projects/<项目路径hash>/
├── <session-uuid>.jsonl    # 对话记录
└── memory/                  # 自动记忆

~/.claude/sessions/
└── <pid>.json              # session 元信息 (sessionId, cwd, kind, entrypoint)
```

## 实测验证

| # | 测试内容 | 命令 | 结果 |
|---|---------|------|------|
| 1 | 基础 `--print` | `claude --print "消息"` | 正常回复 |
| 2 | 创建指定 session | `--session-id <uuid>` | session 文件生成在 projects/ 下 |
| 3 | Resume 自己的 --print session | `--resume <uuid>` | 记忆保持，正确召回 HELLO_WORLD_2024 |
| 4 | Resume VSCode session (非活跃) | `--resume d346e4f2-...` | 正确召回 BLUE_ELEPHANT_2026、MOON_RIVER_8844、Rust |
| 5 | Resume 正在运行的 session | `--resume ac3a157c-...` | 被阻塞（session 文件被锁） |
| 6 | stream-json 输出 | `--output-format stream-json --verbose` | 输出 system → assistant(thinking+text) → result |
| 7 | `--continue` | `--continue` | 续接最近一次对话 |

## 注意事项

- `--resume` **可以**续接 VSCode/terminal/--print 创建的任何 session，但不能续接**正在运行中**的 session
- `--output-format stream-json` 必须配合 `--verbose`
- `--fork-session` 配合 `--resume` 可从已有 session 创建分支而不影响原始 session
- Session ID 必须是有效 UUID 格式
- 不同 entrypoint (claude-vscode / claude-terminal / claude-print) 的 session 共享同一份 `.jsonl` 对话文件
- `--permission-mode acceptEdits` 是手机远程操控的推荐权限模式，平衡便利性和安全性
