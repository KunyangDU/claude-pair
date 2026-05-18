# claude-pair

Pair any OpenAI-compatible chat client with your existing Claude Code session — no subscription, no context loss.

## What it does

- **Free** — no Claude subscription required. Works with your existing Claude Code CLI setup (any API provider).
- **Any chat client** — exposes an OpenAI-compatible HTTP endpoint. Chatbox, OpenCat, or any chat app that supports custom API URLs.
- **Session hopping** — pick up exactly where you left off in VSCode. Same session, same context. Resume from your phone, then continue on desktop.

## How it works

```
Phone (Chatbox / OpenCat)
    ↓ HTTPS
claude.your-domain.com (Cloudflare Tunnel)
    ↓
claude-pair server on your Mac
    ↓ spawn claude --print --resume <session-id>
Claude Code CLI
```

Your chat client sends an OpenAI-format request. The system prompt carries `[folder]` and `[session]` tags. The server spawns `claude --print --resume` and streams the response back via SSE.

## Quick start

*(Coming soon — server implementation in progress. See [PLAN.md](PLAN.md).)*

```bash
# 1. Install
git clone https://github.com/KunyangDU/claude-pair.git
cd claude-pair
npm install

# 2. Configure
cp config.example.yaml config.yaml
# Edit config.yaml with your API key and domain

# 3. Start
node server.js
```

## Chat client setup (Chatbox example)

| Setting | Value |
|---------|-------|
| Provider | Custom (OpenAI compatible) |
| URL | `https://your-domain.com/v1` |
| API Key | Same as config.yaml |
| Model | `claude-code` |
| System Prompt | `[folder: /path/to/project]\n[session: <uuid>]\n---\nYour actual system prompt` |

## Documentation

- [PLAN.md](PLAN.md) — full design and architecture
- [docs/CLAUDE_CLI_REF.md](docs/CLAUDE_CLI_REF.md) — Claude CLI `--print` usage reference
- [docs/claude-code-remote-ARCH.md](docs/claude-code-remote-ARCH.md) — analysis of the claude-code-remote project
- [docs/PLAN-REVIEW-1.md](docs/PLAN-REVIEW-1.md) — design review

## License

MIT
