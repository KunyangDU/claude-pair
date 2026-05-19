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

Your chat client sends an OpenAI-format request. The system prompt is a plain string — paste a session ID to resume, a path to start a new session, or leave it empty for the default folder. The server spawns `claude --print --resume` and streams the response back via SSE.

## Quick start

```bash
# 1. Install
git clone https://github.com/KunyangDU/claude-pair.git
cd claude-pair
npm install

# 2. Start (config auto-created at ~/.claude-pair/config.yaml)
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

Just a plain string — no JSON needed:

```
08c8562f-4a08-4a2a-aaab-869d0e720863
```

| Value | Description |
|-------|-------------|
| Session ID (UUID) | Resume an existing session (folder auto-detected) |
| `/absolute/path` | Create a new session in that folder |
| Empty | Uses `default_folder` from config |

> No `{"folder":"..."}` JSON required. Just paste the session ID or path directly.

### Permission modes

**`ask`** (default) — Safe read-only mode. Claude can read files and search, but cannot write. When it wants to edit, it shows what it plans to do and prompts you to reply `允许` to approve. The approval runs with write access.

**`auto`** — Full read-write. Claude can execute commands and edit files without asking.

Switch modes anytime — reply `允许` to approve an edit, or set the permission mode in config. No server restart needed.

### Session workflow

```
1. (empty)                                             → new session in default_folder
2. 08c8562f-4a08-4a2a-aaab-869d0e720863               → resume by UUID
3. /Users/me/another-project                           → new session in that folder
```

## Documentation

See [docs/](docs/) — [setup guide](docs/SETUP.md), [architecture](docs/ARCHITECTURE.md), [tunnel setup](docs/SETUP-CLOUDFLARED.md).

## License

MIT
