# claude-pair 操作手册

## 上手文档

| 文档 | 用途 |
|------|------|
| [SETUP.md](SETUP.md) | 从零初始化：clone → 配置 → 启动 → 验证 |
| [SETUP-CLOUDFLARED.md](SETUP-CLOUDFLARED.md) | Cloudflare Tunnel 配置 + 踩坑记录 |

## 关键文件

| 文件 | 用途 |
|------|------|
| `../server.js` | Express 主入口，路由 + 生命周期 |
| `../lib/parse-prompt.js` | System Prompt JSON 解析 |
| `../lib/claude-runner.js` | Claude CLI spawn + stream-json → SSE |
| `../lib/claude-find.js` | Claude CLI 路径探测 |
| `../lib/auth.js` | Bearer Token 认证 |
| `../lib/tunnel.js` | Cloudflare Tunnel 启停（独立使用） |
| `../config.example.yaml` | 配置模板 |
| `../config.yaml` | 用户配置（gitignored） |
