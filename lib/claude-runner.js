import { spawn, execSync } from 'child_process';
import readline from 'readline';
import { findClaude } from './claude-find.js';

/**
 * Run Claude Code CLI and stream the response as SSE.
 *
 * @param {object} opts
 * @param {string} opts.folder        - project working directory
 * @param {string} opts.message       - user prompt
 * @param {string} [opts.sessionId]   - uuid to resume, "new" to force new, empty to create new
 * @param {string} [opts.systemPrompt] - system prompt (after ---)
 * @param {string} [opts.permission]  - "ask" (default) or "auto"
 * @param {object} res                - Express response object
 * @param {function} onMeta           - called with { sessionId } when init line received
 */
export function runClaude(opts, res) {
    const claudePath = findClaude();
    if (!claudePath) {
        res.write(`data: ${JSON.stringify({ error: 'Claude CLI not found. Set CLAUDE_PATH.' })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
    }

    const { folder, message, sessionId, permission } = opts;

    const args = ['--print'];

    // Permission mode
    if (permission === 'auto') {
        args.push('--permission-mode', 'acceptEdits');
    }

    // Session routing
    if (!sessionId || sessionId === 'new') {
        // Create new session
        const newId = generateUUID();
        args.push('--session-id', newId);
        opts._effectiveSessionId = newId;
    } else if (sessionId === 'continue') {
        args.push('--continue');
    } else if (sessionExists(sessionId)) {
        args.push('--resume', sessionId);
    } else {
        // Session doesn't exist yet — create it with the provided ID
        args.push('--session-id', sessionId);
    }

    args.push('--output-format', 'stream-json', '--verbose');

    // Append user message as final arg
    const allArgs = args.concat([message]);

    console.log(`[claude-runner] spawn: ${claudePath} ${allArgs.map(a => `"${a}"`).join(' ')}`);
    console.log(`[claude-runner] cwd: ${folder}`);

    const child = spawn(claudePath, allArgs, {
        cwd: folder,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    const rl = readline.createInterface({ input: child.stdout });
    const deniedTools = new Set();

    rl.on('line', (line) => {
        let json;
        try {
            json = JSON.parse(line);
        } catch (_) {
            return; // skip non-JSON lines
        }

        // Extract session ID from init message
        if (json.type === 'system' && json.subtype === 'init') {
            if (json.session_id) {
                opts._effectiveSessionId = json.session_id;
            }
        }

        // Track tool_use + emit text
        if (json.type === 'assistant') {
            const content = json.message?.content;
            if (Array.isArray(content)) {
                for (const part of content) {
                    if (part.type === 'tool_use') {
                        deniedTools.add(part.name);
                    }
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

        // Result → done; show single approval prompt if permissions were denied
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
        console.error(`[claude-runner] stderr: ${d.toString()}`);
    });

    child.on('error', (err) => {
        console.error(`[claude-runner] error: ${err.message}`);
        if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
        }
    });

    child.on('exit', (code, signal) => {
        console.log(`[claude-runner] exit: code=${code} signal=${signal}`);
        if (code !== 0 && !res.writableEnded) {
            const msg = signal
                ? `Claude process terminated by signal ${signal}`
                : `Claude process exited with code ${code}`;
            res.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
        }
    });

    // Client disconnected → kill child
    res.on('close', () => {
        if (!child.killed) {
            child.kill();
            console.log('[claude-runner] killed due to client disconnect');
        }
    });

    return child;
}

function sessionExists(sessionId) {
    try {
        const result = execSync(
            `find ~/.claude/projects -name "${sessionId}.jsonl" 2>/dev/null`,
            { encoding: 'utf8', timeout: 2000 }
        );
        return result.trim().length > 0;
    } catch (_) {
        return false;
    }
}

function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}
