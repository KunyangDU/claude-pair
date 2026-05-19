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

Work through these steps. You (the agent) execute the commands, don't ask the user to run them.

### 1. Check server

Run this yourself:
```bash
curl -s --noproxy '*' http://localhost:8787/health
```
If you get `{"status":"ok"}`, server is running → skip to step 3.

If no response, server is not running. Start it:
```bash
claude-pair serve
```
Run it in the background and proceed. If `claude-pair` command not found, run `npm install -g claude-pair` first.

> All curl commands need `--noproxy '*'` (Claude's http_proxy can't reach localhost). Auth header is `Authorization: Bearer <key>`, not `x-api-key`.

### 2. Read config

Read the API key and remote URL:
```bash
cat ~/.claude-pair/config.yaml
```
Extract `auth.api_key` and `remote.url` for later use.

### 3. List sessions for this project

Run this (replace `<api-key>` with the value from step 2):
```bash
curl -s --noproxy '*' "http://localhost:8787/v1/sessions?folder=$(pwd)" -H "Authorization: Bearer <api-key>"
```
Pick the most recent session from the response. If it returns empty, use the session ID from this conversation's init message instead.

### 4. Give user the Chatbox config

Tell them to add an assistant in Chatbox:

| Setting | Value |
|---------|-------|
| Provider | Custom (OpenAI compatible) |
| API URL | `<remote.url from config>/v1` (or `http://<local-ip>:8787/v1` if same network) |
| API Key | `<api_key from config>` |
| Model | `claude-code` |
| System Prompt | `<session-id>` (plain text, just the UUID) |

That's it. User can now continue this session from their phone.
