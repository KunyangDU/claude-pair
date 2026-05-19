# claude-pair 初始化指南

从零到手机远程遥控 Claude Code 的完整流程。给 AI agent 用也可以直接丢这份文档。

## 0. 前置条件

- macOS / Linux / Windows
- Node.js >= 18
- Claude Code CLI 已安装（`which claude` 能找到）

## 1. 安装

```bash
npm install -g claude-pair
```

安装后可用命令：
- `claude-pair serve` — 启动 HTTP server
- `claude-pair install` — 安装 Claude Code skill（默认全局 `~/.claude/skills/`，加 `--local` 仅当前项目）

## 2. 配置

首次运行 `claude-pair serve` 会自动创建 `~/.claude-pair/config.yaml`。也可以手动创建：

```bash
mkdir -p ~/.claude-pair
```

编辑 `~/.claude-pair/config.yaml`。agent 按以下顺序询问用户，每个都先给建议值再让用户确认：

**1. API Key** — agent 随机生成一个 8-12 位字符串作为建议值，问用户"用这个还是你自己设一个？"
> 留空则免认证。

**2. 默认项目路径** — agent 探测用户桌面路径（macOS: `/Users/<user>/Desktop`，Windows: `C:\Users\<user>\Desktop`）作为建议值，问用户"先指向桌面测试？还是直接指定项目路径？"

**3. 公网 URL** — agent 问："用 Cloudflare Tunnel（免费需域名）、已有公网 URL、还是先留空用 localhost？"
> 选 Cloudflare → 参考下方方案 B，拿到 URL 后回填；选已有 → 用户直接提供；选留空 → 暂不填。

根据用户回答写入：

```yaml
auth:
  api_key: "<确认后的值>"
server:
  port: 8787
  default_folder: "<确认后的值>"
remote:
  url: "<确认后的值>"
```

## 3. 获取公网 URL

Server 只监听 `localhost:8787`，任选一种方式让外网可达：

### 方案 A：ngrok（最快，无需域名）

```bash
ngrok http 8787
# 输出: https://abc123.ngrok.io → http://localhost:8787
# 写入 config: remote.url: "https://abc123.ngrok.io/v1"
```

### 方案 B：Cloudflare Tunnel（免费，需要域名）

Agent 阅读 [docs/SETUP-CLOUDFLARED.md](docs/SETUP-CLOUDFLARED.md) 后指导用户完成域名 + Tunnel 配置。完成后写入 URL：
```yaml
remote:
  url: "https://claude.your-domain.com/v1"
```

### 方案 C：已有公网 URL

如果你已有 VPS 做了反代，或者通过其他方式穿透到了公网，直接在 `remote.url` 填入完整 URL 即可，跳过本节。

## 4. 启动

```bash
claude-pair serve
# 输出:
#   Local:  http://localhost:8787
#   Remote: https://your-url.com/v1
```

用一个终端就够了。ngrok / frp 等工具可以在另一个终端或后台运行。

## 5. Chatbox 手机端配置

打开 Chatbox → 添加助手 → 自定义 Provider：

| 配置项 | 值 |
|--------|-----|
| Provider | OpenAI (兼容) |
| API URL | `https://your-domain.com/v1`（即 config 中的 `remote.url`） |
| API Key | 和 config.yaml 里一样（没配就不填） |
| Model | `claude-code` |
| System Prompt | 见下方 |

### System Prompt 格式

只需一行纯文本，无需 JSON：

```
# 续接已有 session
08c8562f-4a08-4a2a-aaab-869d0e720863

# 指定文件夹开新 session
/Users/you/your-project

# 用默认文件夹（不填）
(留空)
```

三种模式自动识别：

| 输入 | 行为 |
|------|------|
| 空 | 使用 `~/.claude-pair/config.yaml` 中配置的 `default_folder` |
| `/` 开头（绝对路径） | 在该文件夹创建新 session |
| 其他（UUID / "continue" / "new"） | 续接已有 session，folder 自动推导 |

### 权限模式

**ask（默认）**：Claude 能读文件和搜索，但不能写。想编辑时会提示回复 `允许` 来执行。

**auto**：Claude 可以直接改文件、执行命令。

### 多项目/多 Session

在 Chatbox 里为每个项目创建一个 Assistant，配不同的 System Prompt：

```
Assistant "工作项目"
/Users/you/work-project

Assistant "个人笔记"
/Users/you/notes
```

## 6. 验证

```bash
# 1. 检查 server
curl http://localhost:8787/health
# → {"status":"ok"}

# 2. 检查 models（无需认证）
curl http://localhost:8787/v1/models
# → {"object":"list","data":[{"id":"claude-code","object":"model"}]}

# 3. 发送一条测试消息（使用 default_folder）
curl -s --max-time 60 http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-key-here" \
  -d '{
    "model": "claude-code",
    "messages": [
      {"role":"user","content":"说你好"}
    ],
    "stream": true
  }'

# 4. 手机上 Chatbox 发一条消息，看能不能收到回复
```

## 7. 常驻后台（可选）

```bash
# 启动 tmux 会话
tmux new -s claude-pair

# 窗格 1：启动 server
claude-pair serve

# Ctrl+b " 分屏 → 窗格 2：启动穿透工具（ngrok / cloudflared 等）
# Ctrl+b d 断开，进程继续跑
# tmux attach -t claude-pair 恢复
```

> Server 有 3 小时空闲自动退出机制。只要手机持续使用就不会断。

## 常见问题

| 现象 | 解决 |
|------|------|
| Chatbox 报 Network Error | 检查 tunnel 是否运行、域名 DNS 是否配好 |
| `No folder specified` | System Prompt 为空且未配置 `default_folder`，在 config 中设一个 |
| `Folder not found` | 路径拼写错误或不存在 |
| Claude 不执行编辑 | 默认 `ask` 模式是只读的，回复 `允许` 即可临时授权 |
| `Claude CLI not found` | 系统未安装 Claude Code 或 `CLAUDE_PATH` 环境变量未设置 |
