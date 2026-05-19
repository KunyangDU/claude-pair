# claude-pair

Pair any OpenAI-compatible chat client with your existing Claude Code session — no subscription, no context loss.

## What it does

- **Free** — no Claude subscription required. Works with your existing Claude Code CLI setup.
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

Your chat client sends an OpenAI-format request. The system prompt carries a JSON config with `folder`, `session`, and `permission`. The server spawns `claude --print --resume` and streams the response back via SSE.

## Quick start

```bash
# 1. Install
git clone https://github.com/KunyangDU/claude-pair.git
cd claude-pair
npm install

# 2. Configure
cp config.example.yaml config.yaml
# Edit config.yaml with your API key (optional)

# 3. Start
node server.js
# → Local:  http://localhost:8787
# → Remote: https://claude.your-domain.com/v1
```

[Complete setup guide](docs/SETUP.md)

## Chat client setup (Chatbox)

| Setting | Value |
|---------|-------|
| Provider | Custom (OpenAI compatible) |
| URL | `https://your-domain.com/v1` |
| API Key | Same as config.yaml (or leave empty if no auth) |
| Model | `claude-code` |
| System Prompt | See below |

### System prompt format

Write a JSON object with the project config:

```json
{"folder": "/Users/dukunyang/本地资料/AI/remote vibing", "session": "08c8562f-...", "permission": "ask"}
```

| Field | Required | Description |
|-------|----------|-------------|
| `folder` | **Yes** | Absolute path to your project |
| `session` | No | UUID of an existing session, `"new"` to force new, or `"continue"` for latest |
| `permission` | No | `"ask"` (default): read-only, replies `允许` to approve edits. `"auto"`: full read-write |

### Permission modes

**`ask`** (default) — Safe read-only mode. Claude can read files and search, but cannot write. When it wants to edit, it shows what it plans to do and prompts you to reply `允许` to approve. The approval runs with write access.

**`auto`** — Full read-write. Claude can execute commands and edit files without asking.

Switch modes anytime by changing the JSON field. No server restart needed.

### Session workflow

```
1. {"folder": "/path/to/project"}                    → fresh session
2. {"folder": "/path/to/project", "session": "<id>"}  → resume by UUID
3. {"folder": "/path/to/project", "session": "continue"} → resume latest
```

## Documentation

See [docs/](docs/) — [setup guide](docs/SETUP.md), [architecture](docs/ARCHITECTURE.md), [tunnel setup](docs/SETUP-CLOUDFLARED.md).

## License

MIT
