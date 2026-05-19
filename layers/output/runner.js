import { spawn } from 'child_process';
import readline from 'readline';
import crypto from 'crypto';
import { findClaude } from './find.js';
import { findSession } from '../core/session.js';

/**
 * Run Claude Code CLI and stream the response as SSE.
 * Belongs to output layer — swap this when using a different local agent.
 */
export function runClaude(opts, res) {
    const claudePath = findClaude();
    if (!claudePath) {
        endStream('Claude CLI not found. Set CLAUDE_PATH.');
        return;
    }

    const { message, sessionId, permission } = opts;
    let { folder } = opts;

    let streamEnded = false;
    function endStream(errMsg) {
        if (streamEnded) return;
        streamEnded = true;
        if (res.writableEnded) return;
        if (errMsg) {
            res.write(`data: ${JSON.stringify({ error: errMsg })}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        res.end();
    }

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
        endStream('No folder specified. Set default_folder in config or provide a folder/session.');
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

    const spawnOpts = {
        cwd: folder,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
    };
    // .cmd / .bat files on Windows require shell: true
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(claudePath)) {
        spawnOpts.shell = true;
    }
    const child = spawn(claudePath, allArgs, spawnOpts);

    const MAX_EXECUTION_MS = 10 * 60 * 1000;
    const timeout = setTimeout(() => {
        child.kill();
        endStream('Execution timeout (10 min)');
    }, MAX_EXECUTION_MS);

    const rl = readline.createInterface({ input: child.stdout });

    rl.on('line', (line) => {
        let json;
        try { json = JSON.parse(line); } catch (_) { return; }

        if (json.type === 'error') {
            if (!child.killed) child.kill();
            endStream(json.error || json.message || 'Claude internal error');
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
            endStream();
        }
    });

    child.stderr.on('data', (d) => {
        console.error(`[runner] stderr: ${d.toString()}`);
    });

    child.on('error', (err) => {
        console.error(`[runner] error: ${err.message}`);
        endStream(err.message);
    });

    child.on('exit', (code, signal) => {
        clearTimeout(timeout);
        console.log(`[runner] exit: code=${code} signal=${signal}`);
        if (code !== 0) {
            const msg = signal
                ? `Claude process terminated by signal ${signal}`
                : `Claude process exited with code ${code}`;
            endStream(msg);
        }
        // Normal exit (code 0): result handler already called endStream()
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
