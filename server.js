#!/usr/bin/env node
import express from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { createAuthMiddleware } from './layers/input/auth.js';
import { createChatRoute, createSessionsRoute } from './layers/core/route.js';
import { createLifecycle } from './layers/core/lifecycle.js';

// ── Config loading ──────────────────────────────────────────────
const CONFIG_DIR = path.join(os.homedir(), '.claude-pair');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.yaml');
const CONFIG_EXAMPLE_PATH = path.join(import.meta.dirname, 'config.example.yaml');

function ensureConfigDir() {
    if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
}

function initConfig() {
    ensureConfigDir();
    if (!fs.existsSync(CONFIG_PATH)) {
        try {
            const template = fs.readFileSync(CONFIG_EXAMPLE_PATH, 'utf8');
            fs.writeFileSync(CONFIG_PATH, template);
            console.log(`[config] Created default config at ${CONFIG_PATH}`);
            console.log('[config] Edit it to set your API key and domain');
        } catch (_) {
            fs.writeFileSync(CONFIG_PATH, '# claude-pair config\nauth:\n  # api_key: ""\nserver:\n  port: 8787\n');
        }
    }
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

let config = {};
try {
    initConfig();
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    config = parseSimpleYAML(raw);
    console.log(`[config] loaded ${CONFIG_PATH}`);
} catch (_) {
    console.log('[config] failed to load config, using defaults');
}

// ── Server setup ─────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '1mb' }));

app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') {
        res.status(400).json({ error: 'Invalid JSON in request body' });
        return;
    }
    next(err);
});

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

const auth = createAuthMiddleware(config);

// ── Lifecycle stub — populated after server starts ────────────────
const lifecycle = { activeProcesses: new Set(), resetIdleTimer() {} };

// ── Routes ───────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.get('/v1/models', (req, res) => {
    res.json({ object: 'list', data: [{ id: 'claude-code', object: 'model' }] });
});

app.get('/v1/sessions', auth, createSessionsRoute(auth, config));

app.post('/v1/chat/completions', auth, createChatRoute(config, lifecycle));

app.use((req, res, next) => {
    lifecycle.resetIdleTimer();
    next();
});

// ── Start ────────────────────────────────────────────────────────
function startServer() {
    const PORT = config?.server?.port || 8787;
    const server = app.listen(PORT, () => {
        console.log(`\n  Local:  http://localhost:${PORT}`);
        const remote = config?.remote?.url || '(remote URL not configured)';
        console.log(`  Remote: ${remote}\n`);
        lifecycle.resetIdleTimer();
    });

    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.log(`Port ${PORT} already in use — server likely already running.`);
            process.exit(0);
        }
        throw err;
    });

    return server;
}

const httpServer = startServer();

// Wire real lifecycle with server reference
const realLifecycle = createLifecycle(httpServer);
Object.assign(lifecycle, realLifecycle);

// ── Install skill ─────────────────────────────────────────────────
function installSkill() {
    const skillSource = path.join(import.meta.dirname, 'skill.md');
    const globalFlag = process.argv.includes('--global') || process.argv.includes('-g');
    const skillsDir = globalFlag
        ? path.join(os.homedir(), '.claude', 'skills')
        : path.join(process.cwd(), '.claude', 'skills');
    const skillDest = path.join(skillsDir, 'claude-pair.md');

    if (!fs.existsSync(skillSource)) {
        console.log('Error: skill.md not found in package. Reinstall claude-pair?');
        process.exit(1);
    }
    if (!fs.existsSync(skillsDir)) {
        fs.mkdirSync(skillsDir, { recursive: true });
    }
    fs.copyFileSync(skillSource, skillDest);
    console.log(`Skill installed → ${skillDest}${globalFlag ? ' (global)' : ''}`);

    const apiKey = (process.env.REMOTE_VIBING_API_KEY || config?.auth?.api_key || '').trim();
    if (!apiKey) {
        console.log('\n⚠️  No API key configured. Set one in ~/.claude-pair/config.yaml:');
        console.log('  auth:');
        console.log('    api_key: "your-key-here"\n');
    }
}

function showHelp() {
    console.log(`
claude-pair — Pair any chat client with your Claude Code session

Usage:
  claude-pair serve            Start the HTTP server (default)
  claude-pair install          Install Claude Code skill to current project
  claude-pair install --global Install Claude Code skill globally (~/.claude/skills/)

Config: ~/.claude-pair/config.yaml
`);
}

// ── CLI dispatch ──────────────────────────────────────────────────
const command = process.argv[2];
if (command === 'install') {
    installSkill();
} else if (command === '--help' || command === '-h') {
    showHelp();
}
