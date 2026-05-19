import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { parseSystemPrompt, getLastUserMessage } from '../input/parse.js';
import { isNamingRequest, handleNamingRequest } from '../input/naming.js';
import { runClaude } from '../output/runner.js';
import { isApprovalMessage } from './approval.js';

/**
 * Main chat completions route handler.
 * Belongs to core layer — orchestrates input → output pipeline.
 */
export function createChatRoute(config, lifecycle) {
    const sessionMeta = { folder: '', sessionId: '' };

    return (req, res) => {
        // ── Shutdown check ──
        if (lifecycle.isShuttingDown()) {
            res.status(503).json({ error: 'Server is shutting down' });
            return;
        }

        const { messages, stream } = req.body;

        // ── Validate input ──
        if (!messages || !messages.length) {
            res.status(400).json({ error: 'No messages provided' });
            return;
        }

        // ── Naming request ──
        if (isNamingRequest(messages)) {
            handleNamingRequest(res, sessionMeta, stream);
            return;
        }

        // ── Parse input ──
        const sysMsg = messages?.find(m => m.role === 'system');
        const defaultFolder = config?.server?.default_folder || '';
        const parsed = parseSystemPrompt(sysMsg?.content || '', defaultFolder);

        // ── Extract user message ──
        const userMessage = getLastUserMessage(messages);
        if (!userMessage) {
            res.status(400).json({ error: 'No user message found' });
            return;
        }

        if (!stream) {
            res.status(400).json({ error: 'Only streaming (stream: true) is supported' });
            return;
        }

        // ── Permission switching ──
        let permission = parsed.permission;
        if (permission === 'ask' && isApprovalMessage(userMessage)) {
            console.log(`[approval] detected: "${userMessage}" → switching to auto`);
            permission = 'auto';
        }

        // ── SSE headers ──
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        // ── Spawn Claude ──
        const opts = {
            folder: parsed.folder,
            message: userMessage,
            sessionId: parsed.sessionId,
            permission,
        };
        const child = runClaude(opts, res);

        // ── Track for naming & lifecycle ──
        sessionMeta.folder = opts._effectiveFolder || parsed.folder;
        sessionMeta.sessionId = parsed.sessionId;

        if (child) {
            lifecycle.activeProcesses.add(child);
            child.on('exit', () => {
                lifecycle.activeProcesses.delete(child);
                lifecycle.resetIdleTimer();
            });
        }
    };
}

/**
 * Sessions listing route.
 */
export function createSessionsRoute(auth, config) {
    return (req, res) => {
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
    };
}
