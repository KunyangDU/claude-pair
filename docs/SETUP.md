# claude-pair 初始化指南

从零到手机远程遥控 Claude Code 的完整流程。给 AI agent 用也可以直接丢这份文档。

## 0. 前置条件

- macOS（Linux 同理，路径调整即可）
- Node.js >= 18
- Claude Code CLI 已安装（`which claude` 能找到）
- 一个域名，DNS 托管在 Cloudflare

## 1. 安装

```bash
npm install -g claude-pair
```

安装后可用命令：
- `claude-pair serve` — 启动 HTTP server
- `claude-pair install` — 安装 Claude Code skill 到当前项目

## 2. 配置

首次运行 `claude-pair serve` 会自动创建 `~/.claude-pair/config.yaml`。也可以手动创建：

```bash
mkdir -p ~/.claude-pair
```

编辑 `~/.claude-pair/config.yaml`：

```yaml
auth:
  api_key: "your-key-here"    # Chatbox 里填的密码；不想认证就注释掉或留空
server:
  port: 8787                   # 本地服务端口，一般不用改
tunnel:
  mode: "named"
  # name: "claude-pair"        # named 模式填 tunnel 名字（见第 3 步）
  # domain: "claude.your-domain.com"  # 你的域名
```

**不想配 API Key**：把 `api_key` 注释掉或删掉，服务端不验证。

## 3. Cloudflare Tunnel（一次性）

详细踩坑记录见 [docs/SETUP-CLOUDFLARED.md](docs/SETUP-CLOUDFLARED.md)，这里是最小步骤：

**macOS:**
```bash
brew install cloudflared
```

**Windows:**
```powershell
# 下载 cloudflared 并放入 PATH
# https://github.com/cloudflare/cloudflared/releases
```

```bash
# 登录（浏览器弹窗确认）
cloudflared tunnel login

# 创建隧道
cloudflared tunnel create claude-pair
# 输出: Tunnel credentials written to ~/.cloudflared/<tunnel-id>.json
# 记下这个 <tunnel-id>

# 绑定域名
cloudflared tunnel route dns claude-pair claude.your-domain.com

# 创建 ~/.cloudflared/config.yml（注意 tunnel id 和路径换成你的）
cat > ~/.cloudflared/config.yml << 'EOF'
tunnel: <your-tunnel-id>
credentials-file: /Users/<you>/.cloudflared/<your-tunnel-id>.json

ingress:
  - hostname: claude.your-domain.com
    service: http://localhost:8787
  - service: http_status:404
EOF
```

**注意**：路径必须用绝对路径，`~` 不生效。

## 4. 启动

```bash
# 终端 1：启动 server
claude-pair serve
# 输出:
#   Local:  http://localhost:8787
#   Remote: https://claude.your-domain.com/v1

# 终端 2：启动 tunnel（可能需设置代理，见踩坑文档）
cloudflared tunnel --config ~/.cloudflared/config.yml run
# 看到 "Registered tunnel connection" 就说明连上了
```

> 如果你的网络需要代理才能连 Cloudflare，先 `export HTTP_PROXY=http://127.0.0.1:7890 HTTPS_PROXY=http://127.0.0.1:7890`

## 5. Chatbox 手机端配置

打开 Chatbox → 添加助手 → 自定义 Provider：

| 配置项 | 值 |
|--------|-----|
| Provider | OpenAI (兼容) |
| API URL | `https://claude.your-domain.com/v1` |
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

# 3. 发送一条测试消息
curl -s --max-time 60 http://localhost:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-key-here" \
  -d '{
    "model": "claude-code",
    "messages": [
      {"role":"system","content":"{\"folder\":\"/path/to/your/project\"}"},
      {"role":"user","content":"说你好"}
    ],
    "stream": true
  }'

# 4. 手机上 Chatbox 发一条消息，看能不能收到回复
```

## 7. 常驻后台（可选）

用 `tmux` 或 `screen` 让 server + tunnel 在后台持续运行：

```bash
# 启动 tmux 会话
tmux new -s claude-pair

# 窗格 1：启动 server
claude-pair serve

# Ctrl+b " 分屏 → 窗格 2：启动 tunnel
cloudflared tunnel --config ~/.cloudflared/config.yml run

# Ctrl+b d 断开，进程继续跑
# tmux attach -t claude-pair 恢复
```

> Server 有 3 小时空闲自动退出机制。只要手机持续使用就不会断。

## 常见问题

| 现象 | 解决 |
|------|------|
| Chatbox 报 Network Error | 检查 tunnel 是否运行、域名 DNS 是否配好 |
| `Missing "folder" in system prompt` | System Prompt 里没写 JSON，或格式不对 |
| `Folder not found` | 路径拼写错误或不存在 |
| Claude 不执行编辑 | 默认 `ask` 模式是只读的，改 `"permission":"auto"` 或回复 `允许` |
| `Invalid JSON in system prompt` | JSON 写错了，检查引号和逗号 |
