# Cloudflare Tunnel 配置踩坑记录

从头配置 `claude.cronlab.top` 域名 + Cloudflare Tunnel 的全过程，确保全新电脑一遍过。

## 前置条件

- 一个域名（如 `cronlab.top`），DNS 托管在 Cloudflare
- macOS 系统（Apple Silicon）

---

## 1. 安装 cloudflared

```bash
brew install cloudflared
```

验证：

```bash
cloudflared version
# cloudflared version 2026.5.0 (or newer)
```

---

## 2. 登录 Cloudflare 账号

```bash
cloudflared tunnel login
```

这会打开浏览器，要求你选择要授权的域名。选 `cronlab.top` 后确认即可。

> 成功后会在 `~/.cloudflared/cert.pem` 生成证书文件，后续命令依赖此证书。

---

## 3. 创建隧道

```bash
cloudflared tunnel create claude-pair
```

输出示例：

```
Tunnel credentials written to /Users/dukunyang/.cloudflared/<tunnel-id>.json
```

记住这个 `<tunnel-id>`，后面写配置文件要用。

---

## 4. 配置 DNS 路由

将域名绑定到隧道：

```bash
cloudflared tunnel route dns claude-pair claude.cronlab.top
```

> 这会在 Cloudflare DNS 面板自动创建一条 CNAME 记录：`claude.cronlab.top` → `<tunnel-id>.cfargotunnel.com`，且 Proxy（橙色云朵）默认开启。

---

## 5. 创建 config.yml

```bash
mkdir -p ~/.cloudflared
```

文件 `~/.cloudflared/config.yml`：

```yaml
tunnel: 2f2b5f6a-ce82-432f-9587-39b568e0c57b       # 第3步创建时得到的 ID
credentials-file: /Users/dukunyang/.cloudflared/2f2b5f6a-ce82-432f-9587-39b568e0c57b.json

ingress:
  - hostname: claude.cronlab.top
    service: http://localhost:8787                   # 指向本地 Express 服务
  - service: http_status:404                         # 不匹配的域名返回 404
```

> **注意**：tunnel ID 和 credentials-file 的路径必须和你实际的 ID、绝对路径一致。用 `~` 不行，必须写 `/Users/xxx/` 绝对路径。

---

## 6. 踩坑记录

### 坑1：`cloudflared tunnel run` 不加载 config.yml

**现象**：运行 `cloudflared tunnel run claude-pair` 时，请求到达不了本地服务。用 quick 模式 `cloudflared tunnel --url http://localhost:8787` 能通，但命名隧道不行。

**根因**：`cloudflared tunnel run <name>` 不会自动读取 `~/.cloudflared/config.yml` 中的 `ingress` 规则。

**解决**：必须显式指定配置文件路径：

```bash
# 错误 ❌
cloudflared tunnel run claude-pair

# 正确 ✅
cloudflared tunnel --config ~/.cloudflared/config.yml run
```

启动成功时会看到日志：

```
INF Settings: map[config:/Users/dukunyang/.cloudflared/config.yml cred-file:...]
INF Registered tunnel connection ... location=hkg09 protocol=quic
```

---

### 坑2：Go 程序不读取小写 `http_proxy` 环境变量

**现象**：cloudflared 在连接 Cloudflare 边缘节点时报 `TLS handshake timeout`：

```
INF Tunnel connection curve preferences: ...
INF Retrying connection in up to 2s ...
```

一直重试，始终连不上。

**根因**：Mac 上配置了科学上网代理 `http_proxy=http://127.0.0.1:7890`（小写），但 cloudflared 是用 Go 写的，Go 标准库 `net/http` 只读取**大写**的环境变量：
- `HTTP_PROXY`
- `HTTPS_PROXY`

**解决**：同时设置大写环境变量：

```bash
export HTTP_PROXY=http://127.0.0.1:7890
export HTTPS_PROXY=http://127.0.0.1:7890
```

建议写入 `~/.zshrc` 持久化：

```bash
echo 'export HTTP_PROXY=http://127.0.0.1:7890' >> ~/.zshrc
echo 'export HTTPS_PROXY=http://127.0.0.1:7890' >> ~/.zshrc
```

---

### 坑3：`all_proxy` socks5 代理干扰 HTTPS 连接

**现象**：即使设置了大写 `HTTPS_PROXY`，本地 `curl https://claude.cronlab.top` 仍然走 socks5 代理，TLS 握手失败。

**根因**：`curl` 会读取 `all_proxy` 环境变量（有些代理工具如 Clash 会设置）。socks5 代理无法正确处理 TLS 到 Cloudflare 的连接，导致 `SSL_ERROR_SYSCALL`。

**检查方法**：

```bash
env | grep -i proxy
# http_proxy=http://127.0.0.1:7890
# all_proxy=socks5://127.0.0.1:7890     ← 这个会干扰
```

**解决**：本地调试时临时 unset：

```bash
unset all_proxy ALL_PROXY
```

或永久在 `~/.zshrc` 中注释掉 `all_proxy`。

> **注意**：手机端的 Chatbox 不走你的代理，不受影响。这个坑只影响 Mac 本地用 curl 调试。

---

### 坑4：`~/` 和 `$HOME` 在 config.yml 中不生效

**现象**：

```yaml
credentials-file: ~/.cloudflared/xxx.json
```

启动时报错找不到文件。

**解决**：永远用绝对路径：

```yaml
credentials-file: /Users/dukunyang/.cloudflared/xxx.json
```

---

### 坑5：npm 全局安装时 `EACCES` 权限错误

**现象**：

```
npm error EACCES: permission denied
```

**根因**：之前用 `sudo npm` 导致 `~/.npm/` 下部分文件属主变成 root。

**解决**：

```bash
sudo chown -R $(whoami) ~/.npm
```

---

### 坑6：CORS Preflight 导致 Chatbox 请求被拦截

**现象**：debug-server 收到大量 `OPTIONS /v1/chat/completions` 请求，但从未收到 `POST` 请求。Chatbox 端显示 Network Error。

**根因**：Chatbox 是 WebView 应用（`origin: capacitor://localhost`），浏览器环境会先发 OPTIONS CORS 预检请求。Express 默认不响应 CORS 头，浏览器拒绝发送真正的 POST。

**解决**：服务端必须返回 CORS 响应头：

```javascript
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
    }
    next();
});
```

---

## 最终启动命令

```bash
# 1. 启动本地服务
cd /path/to/remote-vibing
node server.js &

# 2. 启动隧道
HTTP_PROXY=http://127.0.0.1:7890 \
HTTPS_PROXY=http://127.0.0.1:7890 \
cloudflared tunnel --config ~/.cloudflared/config.yml run
```

## 验证

```bash
# 不走代理测试
unset all_proxy ALL_PROXY
curl https://claude.cronlab.top/v1/models

# 预期输出：
# {"object":"list","data":[{"id":"claude-code","object":"model"}]}
```

---

## 环境变量汇总

在 `~/.zshrc` 中需要持久化的：

```bash
# cloudflared (Go 程序需要大写)
export HTTP_PROXY=http://127.0.0.1:7890
export HTTPS_PROXY=http://127.0.0.1:7890
```
