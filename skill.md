---
name: claude-pair
description: Mobile remote access to Claude Code sessions via Chatbox
---

# claude-pair

Let the user continue this Claude Code session from their phone (Chatbox / OpenCat).

## When to activate

User says anything like:
- "手机上继续" / "远程" / "手机连过来"
- "Chatbox" / "claude-pair"
- "在外面怎么用这个 session"

## What to do

### 1. Ensure server is running

Check: `curl -s http://localhost:8787/health` — if no response, tell user to run:
```
claude-pair serve
```

If `claude-pair` command not found, guide through: `npm install -g claude-pair`

### 2. Find the session ID

This conversation's session ID is in the init message, or check:
```
GET http://localhost:8787/v1/sessions?folder=<cwd>
```
Pick the most recent or let user choose.

### 3. Give user the Chatbox system prompt

Just paste this in the System Prompt field (a plain string, not JSON):

```
<session-id>
```

Also tell them:
- URL: the remote URL from `~/.claude-pair/config.yaml` (`remote.url`), or `http://localhost:8787/v1` for local
- API Key: set in `~/.claude-pair/config.yaml` — if not configured yet, run `claude-pair serve` once and edit the file
- Model: `claude-code`
