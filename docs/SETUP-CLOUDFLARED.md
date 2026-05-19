# Cloudflare Tunnel 配置指南（Agent 向）

帮助用户使用 Cloudflare Tunnel 实现域名内网穿透，让 Chatbox 通过公网访问本地 `claude-pair` 服务。

## 角色说明

你是 agent，负责指导用户完成以下步骤。用户可能不熟悉命令行，每一步都要给明确的命令和预期输出。遇到坑时主动排查。

## 前置条件

告知用户需要准备：
- 一个域名，DNS 托管在 Cloudflare
- 本地已安装 `claude-pair` 并确认 `curl http://localhost:8787/health` 正常

---

## 步骤 1：安装 cloudflared

**macOS:**
```bash
brew install cloudflared
```

**Windows:** 从 [GitHub Releases](https://github.com/cloudflare/cloudflared/releases) 下载 `cloudflared-windows-amd64.exe`，放入 PATH。

验证：
```bash
cloudflared version
```

---

## 步骤 2：登录 Cloudflare

```bash
cloudflared tunnel login
```

会打开浏览器，让用户选择要授权的域名。确认后在 `~/.cloudflared/cert.pem` 生成证书。

---

## 步骤 3：创建隧道

```bash
cloudflared tunnel create claude-pair
```

输出会显示隧道 ID（UUID 格式），让用户记下来。

---

## 步骤 4：配置 DNS 路由

```bash
cloudflared tunnel route dns claude-pair <子域名>.<用户域名>
```

例如：`claude.cronlab.top`。这会在 Cloudflare DNS 自动创建 CNAME 记录。

---

## 步骤 5：创建 config.yml

```bash
mkdir -p ~/.cloudflared
```

编辑 `~/.cloudflared/config.yml`，填入用户实际的隧道 ID 和域名：

```yaml
tunnel: <隧道ID>
credentials-file: <绝对路径>/.cloudflared/<隧道ID>.json

ingress:
  - hostname: <子域名>.<用户域名>
    service: http://localhost:8787
  - service: http_status:404
```

> **注意**：`credentials-file` 必须用绝对路径（如 `/Users/xxx/.cloudflared/xxx.json`），`~` 不生效。

---

## 步骤 6：启动隧道

```bash
cloudflared tunnel --config ~/.cloudflared/config.yml run
```

> `cloudflared tunnel run <name>` 不会自动加载 config.yml，必须显式指定 `--config`。

启动成功后回填 SETUP.md 中的 `remote.url`。格式：

```yaml
remote:
  url: "https://<子域名>.<用户域名>/v1"
```

---

## 步骤 7：验证

```bash
curl https://<子域名>.<用户域名>/v1/health
# 预期输出: {"status":"ok"}
```

---

## 踩坑排查

| 现象 | 可能原因 | 解决 |
|------|----------|------|
| `TLS handshake timeout`，一直重试 | Go 程序只读大写 `HTTP_PROXY` / `HTTPS_PROXY` | 同时设置大写环境变量：`export HTTP_PROXY=http://127.0.0.1:7890` |
| 本地 curl 测试 SSL 错误 | `all_proxy` socks5 代理干扰 HTTPS | `unset all_proxy ALL_PROXY` |
| `credentials-file` 找不到 | config.yml 中用了 `~` | 改为绝对路径 `/Users/xxx/.cloudflared/xxx.json` |
| Chatbox 显示 Network Error，服务端只收到 OPTIONS 请求 | CORS 预检被拦截（Chatbox 是 WebView） | claude-pair 已内置 CORS 处理，检查 tunnel URL 是否正确 |
| `Permission denied`（安装阶段） | npm 全局目录权限问题 | `sudo chown -R $(whoami) ~/.npm` |
