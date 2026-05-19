# claude-pair

将任意 OpenAI 兼容的聊天客户端接入你现有的 Claude Code 会话 — 无需订阅，不丢失上下文。

## 它能做什么

- **免费** — 无需 Claude 订阅，基于你已有的 Claude Code CLI。
- **任意聊天客户端** — 暴露 OpenAI 兼容的 HTTP 端点。Chatbox、OpenCat，或任何支持自定义 API URL 的聊天应用。
- **会话漫游** — 在手机上接手 VSCode 里未完成的会话。同一会话、同一上下文。手机上回复完，回到桌面继续。

## 工作原理

```
手机 (Chatbox / OpenCat)
    ↓ HTTPS
claude.your-domain.com (Cloudflare Tunnel)
    ↓
claude-pair server 运行在你的电脑上
    ↓ spawn claude --print --resume <session-id>
Claude Code CLI
```

聊天客户端发送 OpenAI 格式的请求。System Prompt 填纯文本 — 粘贴 session ID 续接会话、填入路径开新会话、或留空使用默认文件夹。服务端 spawn `claude --print --resume` 并通过 SSE 流式返回。

## 快速开始

```bash
# 1. 安装
npm install -g claude-pair

# 2. 启动（配置自动创建在 ~/.claude-pair/config.yaml）
claude-pair serve
# → Local:  http://localhost:8787
# → Remote: https://your-domain.com/v1
```

或 clone 开发：

```bash
git clone https://github.com/KunyangDU/claude-pair.git
cd claude-pair
node server.js
```

[完整初始化指南](SETUP.md)

## 聊天客户端配置 (Chatbox)

| 配置项 | 值 |
|--------|-----|
| Provider | Custom (OpenAI 兼容) |
| URL | `https://your-domain.com/v1` |
| API Key | 与 config.yaml 一致（未配置则不填） |
| Model | `claude-code` |
| System Prompt | 见下方 |

### System Prompt 格式

只需一行纯文本，无需 JSON：

```
08c8562f-4a08-4a2a-aaab-869d0e720863
```

| 填写的值 | 行为 |
|----------|------|
| Session ID (UUID) | 续接已有会话（文件夹自动推导） |
| `/绝对路径` | 在该目录创建新会话 |
| 留空 | 使用 config 中的 `default_folder` |

> 不需要 `{"folder":"..."}` 这种 JSON 格式。直接粘贴 session ID 或路径。

### 权限模式

**`ask`**（默认）— 安全只读模式。Claude 可以读文件和搜索，但不能写入。当它想编辑时，会展示计划并要求你回复 `允许` 来授权。授权后以写入权限执行。

**`auto`** — 完整读写。Claude 可以直接执行命令和编辑文件，无需逐一确认。

随时切换模式 — 回复 `允许` 即可临时授权编辑，或在 config 中设置。无需重启服务。

### 会话流程

```
1. (留空)                                               → 在 default_folder 创建新会话
2. 08c8562f-4a08-4a2a-aaab-869d0e720863               → 通过 UUID 续接
3. /Users/me/another-project                           → 在该目录创建新会话
```

## 更新

```bash
cd claude-pair
git pull
claude-pair install          # 安装 skill 到全局 (~/.claude/skills/claude-pair/SKILL.md)
# 检查 ~/.claude-pair/config.yaml 是否有新增配置项
```

- `skill.md` 每次 install 自动覆盖最新版本。
- `config.yaml` 永远不会被覆盖 — 你的 API key 和路径安全保留。

## 文档

详见 [docs/](docs/) — [初始化指南](SETUP.md)、[架构文档](docs/ARCHITECTURE.md)、[Tunnel 配置](docs/SETUP-CLOUDFLARED.md)。

## License

MIT
