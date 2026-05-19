import { spawn } from 'child_process';
import readline from 'readline';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { findClaude } from './find.js';

/**
 * Run Claude Code CLI and stream the response as SSE.
 * Belongs to output layer — swap this when using a different local agent.
 */
export function runClaude(opts, res) {
    const claudePath = findClaude();
    if (!claudePath) {
        res.write(`data: ${JSON.stringify({ error: 'Claude CLI not found. Set CLAUDE_PATH.' })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
    }

    const { message, sessionId, permission } = opts;
    let { folder } = opts;

    const args = ['--print'];

    if (permission === 'auto') {
        args.push('--permission-mode', 'acceptEdits');
    }

    // Resolve folder from session if missing
    if (!folder && sessionId && sessionId !== 'new') {
        const s = findSession(sessionId);
        if (s.found) {
            folder = s.folder;
            opts._effectiveSessionId = sessionId;
        }
    }

    // Validate folder
    if (!folder) {
        res.write(`data: ${JSON.stringify({ error: 'No folder specified. Set default_folder in config or provide a folder/session.' })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return null;
    }

    opts._effectiveFolder = folder;

    // Session routing
    if (!sessionId || sessionId === 'new') {
        const newId = crypto.randomUUID();
        args.push('--session-id', newId);
        opts._effectiveSessionId = newId;
    } else if (sessionId === 'continue') {
        args.push('--continue');
    } else if (findSession(sessionId).found) {
        args.push('--resume', sessionId);
    } else {
        args.push('--session-id', sessionId);
    }

    args.push('--output-format', 'stream-json', '--verbose');
    const allArgs = args.concat([message]);

    console.log(`[runner] spawn: ${claudePath} ${allArgs.map(a => `"${a}"`).join(' ')}`);
    console.log(`[runner] cwd: ${folder}`);

    const child = spawn(claudePath, allArgs, {
        cwd: folder,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    const MAX_EXECUTION_MS = 10 * 60 * 1000;
    const timeout = setTimeout(() => {
        if (!res.writableEnded) {
            child.kill();
            res.write(`data: ${JSON.stringify({ error: 'Execution timeout (10 min)' })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
        }
    }, MAX_EXECUTION_MS);

    const rl = readline.createInterface({ input: child.stdout });

    rl.on('line', (line) => {
        let json;
        try { json = JSON.parse(line); } catch (_) { return; }

        if (json.type === 'error') {
            res.write(`data: ${JSON.stringify({ error: json.error || json.message || 'Claude internal error' })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
            if (!child.killed) child.kill();
            return;
        }

        if (json.type === 'system' && json.subtype === 'init') {
            if (json.session_id) opts._effectiveSessionId = json.session_id;
        }

        if (json.type === 'assistant') {
            const content = json.message?.content;
            if (Array.isArray(content)) {
                for (const part of content) {
                    if (part.type === 'text') {
                        res.write(`data: ${JSON.stringify({
                            id: json.uuid || '',
                            object: 'chat.completion.chunk',
                            choices: [{ index: 0, delta: { content: part.text } }],
                        })}\n\n`);
                    }
                }
            }
        }

        if (json.type === 'result') {
            if (json.permission_denials && json.permission_denials.length > 0) {
                const names = [...new Set(json.permission_denials.map(d => d.tool_name))].join(', ');
                res.write(`data: ${JSON.stringify({
                    id: json.uuid || '',
                    object: 'chat.completion.chunk',
                    choices: [{ index: 0, delta: { content: `\n\n---\n> \u{1f4a1} 回复「**允许**」执行 ${names} 操作\n` } }],
                })}\n\n`);
            }
            res.write('data: [DONE]\n\n');
            res.end();
        }
    });

    child.stderr.on('data', (d) => {
        console.error(`[runner] stderr: ${d.toString()}`);
    });

    child.on('error', (err) => {
        console.error(`[runner] error: ${err.message}`);
        if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
        }
    });

    child.on('exit', (code, signal) => {
        clearTimeout(timeout);
        console.log(`[runner] exit: code=${code} signal=${signal}`);
        if (code !== 0 && !res.writableEnded) {
            const msg = signal
                ? `Claude process terminated by signal ${signal}`
                : `Claude process exited with code ${code}`;
            res.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
        }
    });

    res.on('close', () => {
        clearTimeout(timeout);
        if (!child.killed) {
            child.kill();
            console.log('[runner] killed due to client disconnect');
        }
    });

    return child;
}

function findSession(sessionId) {
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) return { found: false, folder: null };
    const projectsDir = path.join(os.homedir(), '.claude', 'projects');
    try {
        const dirs = fs.readdirSync(projectsDir);
        for (const dir of dirs) {
            const sessionPath = path.join(projectsDir, dir, `${sessionId}.jsonl`);
            if (fs.existsSync(sessionPath)) {
                let folder = null;
                try {
                    const lines = fs.readFileSync(sessionPath, 'utf8').split('\n').slice(0, 100);
                    for (const line of lines) {
                        const cwdMatch = line.match(/"cwd"\s*:\s*"([^"]+)"/);
                        if (cwdMatch) { folder = cwdMatch[1]; break; }
                    }
                } catch (_) {}
                return { found: true, folder };
            }
        }
    } catch (_) {}
    return { found: false, folder: null };
}
