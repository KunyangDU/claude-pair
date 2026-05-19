import express from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

import { parseSystemPrompt, getLastUserMessage, isNamingRequest } from './lib/parse-prompt.js';
import { runClaude } from './lib/claude-runner.js';
import { createAuthMiddleware } from './lib/auth.js';

// ── Config loading ──────────────────────────────────────────────
let config = {};
try {
    const configPath = path.join(import.meta.dirname, 'config.yaml');
    const raw = fs.readFileSync(configPath, 'utf8');
    // Minimal YAML parser for our simple config (avoids extra dependency)
    config = parseSimpleYAML(raw);
    console.log('[config] loaded config.yaml');
} catch (_) {
    console.log('[config] no config.yaml, using defaults');
}

function parseSimpleYAML(raw) {
    const result = {};
    let current = result;
    const lines = raw.split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const indent = line.search(/\S/);
        if (indent === 0) {
            const [key, ...rest] = trimmed.split(':');
            const val = rest.join(':').trim();
            if (val === '') {
                current = {};
                result[key.trim()] = current;
            } else {
                result[key.trim()] = stripQuotes(val);
            }
        } else if (indent >= 2) {
            const [key, ...rest] = trimmed.split(':');
            const val = rest.join(':').trim();
            current[key.trim()] = val ? stripQuotes(val) : '';
        }
    }
    return result;
}

function stripQuotes(s) {
    s = s.trim();
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
        return s.slice(1, -1);
    }
    return s;
}

// ── Server setup ─────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '1mb' }));

// JSON parse error handler
app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') {
        res.status(400).json({ error: 'Invalid JSON in request body' });
        return;
    }
    next(err);
});

// CORS
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

// Auth (applied to sensitive routes below)
const auth = createAuthMiddleware(config);

// ── Lifecycle state ──────────────────────────────────────────────
const activeProcesses = new Set();
let idleTimer = null;
let shuttingDown = false;
const IDLE_TIMEOUT_MS = 3 * 60 * 60 * 1000;

// Store last session meta for naming requests
const sessionMeta = { folder: '', sessionId: '' };

// Approval keywords for ask → auto mode switch
const APPROVAL_KEYWORDS = [
    '允许', '同意', '执行', '继续', '好的', '可以', '批准', '确认', '行',
    'yes', 'ok', 'go', 'approve', 'proceed', 'confirm', 'y',
];

function isApprovalMessage(msg) {
    const trimmed = msg.trim().toLowerCase();
    if (trimmed.length > 10) return false;
    // Check negation first
    const negations = ['不', '别', '取消', '拒绝', '否', 'no', 'n', 'stop', 'cancel', 'deny'];
    if (negations.includes(trimmed)) return false;
    // Exact match only
    return APPROVAL_KEYWORDS.includes(trimmed);
}

function resetIdleTimer() {
    if (shuttingDown) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(tryShutdown, IDLE_TIMEOUT_MS);
}

function tryShutdown() {
    if (shuttingDown) return;
    if (activeProcesses.size === 0) {
        shuttingDown = true;
        console.log('[lifecycle] idle timeout, shutting down');
        server.close(() => {
            if (activeProcesses.size === 0) process.exit(0);
        });
    }
}

// Middleware: reset timer on every HTTP request
app.use((req, res, next) => {
    resetIdleTimer();
    next();
});

// ── Routes ───────────────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

// OpenAI-compatible model list
app.get('/v1/models', (req, res) => {
    res.json({
        object: 'list',
        data: [{ id: 'claude-code', object: 'model' }],
    });
});

// List sessions for a project folder
app.get('/v1/sessions', auth, (req, res) => {
    const folder = req.query.folder;
    if (!folder) {
        res.status(400).json({ error: 'Missing ?folder= query param' });
        return;
    }
    const projectHash = crypto.createHash('md5').update(folder).digest('hex');
    const sessionsDir = path.join(os.homedir(), '.claude', 'projects', projectHash);

    try {
        const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.jsonl'));
        const sessions = files.map(f => ({
            id: f.replace('.jsonl', ''),
            updatedAt: fs.statSync(path.join(sessionsDir, f)).mtime.toISOString(),
        }));
        sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        res.json({ sessions });
    } catch (_) {
        res.json({ sessions: [] });
    }
});

// Chat completions (auth required)
app.post('/v1/chat/completions', auth, (req, res) => {
    const { messages, stream } = req.body;

    // ── Naming request ──
    if (isNamingRequest(messages)) {
        const folderName = path.basename(sessionMeta.folder);
        const shortId = sessionMeta.sessionId?.slice(0, 8);
        const name = shortId
            ? `claude-pair: ${folderName}/${shortId}`
            : `claude-pair: ${folderName}`;

        if (stream) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.flushHeaders();
            res.write(`data: ${JSON.stringify({
                id: 'name-' + Date.now(),
                object: 'chat.completion.chunk',
                choices: [{ index: 0, delta: { content: name } }],
            })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
        } else {
            res.json({
                id: 'name-' + Date.now(),
                object: 'chat.completion',
                model: 'claude-code',
                choices: [{ index: 0, message: { role: 'assistant', content: name }, finish_reason: 'stop' }],
            });
        }
        return;
    }

    // ── Normal chat ──
    const sysMsg = messages?.find(m => m.role === 'system');
    const parsed = parseSystemPrompt(sysMsg?.content || '');

    if (parsed.error) {
        res.status(400).json({ error: parsed.error });
        return;
    }

    // Store for naming requests
    sessionMeta.folder = parsed.folder;
    sessionMeta.sessionId = parsed.sessionId;

    const userMessage = getLastUserMessage(messages);
    if (!userMessage) {
        res.status(400).json({ error: 'No user message found' });
        return;
    }

    if (!stream) {
        res.status(400).json({ error: 'Only streaming (stream: true) is supported' });
        return;
    }

    // ask mode: detect approval message → switch to auto
    let permission = parsed.permission;
    if (permission === 'ask' && isApprovalMessage(userMessage)) {
        console.log(`[approval] detected: "${userMessage}" → switching to auto`);
        permission = 'auto';
    }

    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Spawn Claude
    const child = runClaude({
        folder: parsed.folder,
        message: userMessage,
        sessionId: parsed.sessionId,
        permission: permission,
    }, res);

    if (child) {
        activeProcesses.add(child);
        child.on('exit', () => {
            activeProcesses.delete(child);
            resetIdleTimer();
        });
    }
});

// ── Start ────────────────────────────────────────────────────────
const PORT = config?.server?.port || 8787;
const server = app.listen(PORT, () => {
    console.log(`\n  Local:  http://localhost:${PORT}`);
    const remote = config?.tunnel?.domain
        ? `https://${config.tunnel.domain}/v1`
        : '(tunnel not configured)';
    console.log(`  Remote: ${remote}\n`);
    resetIdleTimer();
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.log(`Port ${PORT} already in use — server likely already running.`);
        process.exit(0);
    }
    throw err;
});

// Graceful shutdown
['SIGINT', 'SIGTERM'].forEach(signal => {
    process.on(signal, () => {
        console.log(`\n[lifecycle] ${signal}, shutting down...`);
        for (const child of activeProcesses) child.kill();
        process.exit(0);
    });
});
