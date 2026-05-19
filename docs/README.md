# claude-pair 操作手册

## 上手文档

| 文档 | 用途 |
|------|------|
| [SETUP.md](SETUP.md) | 从零初始化：clone → 配置 → 启动 → 验证 |
| [SETUP-CLOUDFLARED.md](SETUP-CLOUDFLARED.md) | Cloudflare Tunnel 配置 + 踩坑记录 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 项目架构：数据流、权限模型、模块设计 |

## 关键文件

| 文件 | 层级 | 用途 |
|------|------|------|
| `../layers/input/parse.js` | input | System Prompt 解析 |
| `../layers/input/auth.js` | input | Bearer Token 认证 |
| `../layers/input/naming.js` | input | 自动命名检测 |
| `../layers/core/route.js` | core | 路由 & 编排 |
| `../layers/core/lifecycle.js` | core | 生命周期管理 |
| `../layers/core/approval.js` | core | 审批策略 |
| `../layers/output/runner.js` | output | Claude CLI spawn |
| `../layers/output/find.js` | output | CLI 路径探测 |
| `../lib/tunnel.js` | — | Cloudflare Tunnel 启停 |
| `../config.example.yaml` | — | 配置模板 |
