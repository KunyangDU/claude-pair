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
            res.write(`data: ${JSON.stringify({ error: { message: errMsg, type: 'server_error' } })}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        res.end();
    }

    const args = ['--print'];

    if (permission === 'auto') {
        args.push('--permission-mode', 'bypassPermissions');
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

    args.push('--output-format', 'stream-json', '--verbose', '--include-partial-messages');
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

    function writeChunk(id, delta) {
        if (!delta.content && !delta.reasoning_content) return;
        res.write(`data: ${JSON.stringify({
            id: id || '',
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta }],
        })}\n\n`);
    }

    rl.on('line', (line) => {
        let json;
        try { json = JSON.parse(line); } catch (_) { return; }

        if (json.type === 'stream_event') {
            const event = json.event;
            if (!event) return;

            if (event.type === 'content_block_start') {
                // Track tool_use start for potential future use (name in block.name)
            }

            if (event.type === 'content_block_delta') {
                const delta = event.delta;
                if (delta?.type === 'thinking_delta' && delta.thinking) {
                    writeChunk(json.uuid, { reasoning_content: delta.thinking });
                } else if (delta?.type === 'text_delta' && delta.text) {
                    writeChunk(json.uuid, { content: delta.text });
                }
            }
            return;
        }

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
                        writeChunk(json.uuid, { content: part.text });
                    } else if (part.type === 'thinking') {
                        writeChunk(json.uuid, { reasoning_content: part.text });
                    } else if (part.type === 'tool_use') {
                        writeChunk(json.uuid, { content: formatToolUse(part) });
                    }
                }
            }
        }

        if (json.type === 'user') {
            const content = json.message?.content;
            if (Array.isArray(content)) {
                for (const part of content) {
                    if (part.type === 'tool_result') {
                        writeChunk(json.uuid || '', { content: formatToolResult(part) });
                    }
                }
            }
        }

        if (json.type === 'result') {
            if (json.permission_denials && json.permission_denials.length > 0) {
                const names = [...new Set(json.permission_denials.map(d => d.tool_name))].join(', ');
                writeChunk(json.uuid, { content: `\n\n---\n> \u{1f4a1} 回复「**允许**」执行 ${names} 操作\n` });
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

// ── Tool formatting helpers ────────────────────────────────────────

const TOOL_LABELS = {
    Read: '读取文件', Bash: '执行命令', Write: '写入文件',
    Edit: '编辑文件', Grep: '搜索内容', Glob: '搜索文件',
    WebFetch: '获取网页', WebSearch: '搜索网络',
    TodoWrite: '更新任务', Agent: '启动子代理',
    AskUserQuestion: '询问用户',
};

function formatToolUse(part) {
    const label = TOOL_LABELS[part.name] || part.name;
    const detail = toolDetail(part.name, part.input);
    return `\n\n🔧 ${label} — ${detail}\n`;
}

function toolDetail(name, input) {
    if (!input) return '';
    switch (name) {
        case 'Read': return input.file_path || '';
        case 'Bash': return input.command || input.description || '';
        case 'Write': return input.file_path || '';
        case 'Edit': return input.file_path || '';
        case 'Grep': return input.pattern || '';
        case 'Glob': return input.pattern || '';
        case 'WebFetch': return input.url || '';
        case 'WebSearch': return input.query || '';
        case 'TodoWrite': return input.todos?.map(t => t.content).join(', ') || '';
        case 'Agent': return input.description || '';
        case 'AskUserQuestion': return input.questions?.map(q => q.question).join(' | ') || '';
        default: return '';
    }
}

function formatToolResult(part) {
    const MAX_LEN = 2000;
    let text = part.content;
    if (typeof text === 'string') {
        // already a string
    } else if (Array.isArray(text)) {
        text = text.map(c => (typeof c === 'string' ? c : JSON.stringify(c))).join('\n');
    } else if (text && typeof text === 'object') {
        text = JSON.stringify(text, null, 2);
    } else {
        text = String(text || '');
    }
    if (text.length > MAX_LEN) {
        text = text.slice(0, MAX_LEN) + '\n... (内容过长已截断)';
    }
    return `\n\`\`\`\n${text}\n\`\`\`\n`;
}
