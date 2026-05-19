import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const UNIX_TRIAGE = [
    path.join(os.homedir(), '.local/bin/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    '/usr/bin/claude',
];

const WIN_TRIAGE = [
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'claude.cmd'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'claude'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Claude', 'claude.cmd'),
];

function which(cmd) {
    try {
        const isWin = process.platform === 'win32';
        const result = execSync(isWin ? `where ${cmd}` : `which ${cmd}`, { encoding: 'utf8' }).trim();
        return result.split('\n')[0] || null;
    } catch (_) { return null; }
}

function isExecutable(p) {
    try {
        // Windows has no POSIX execute bits — check existence instead
        const mode = process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK;
        fs.accessSync(p, mode);
        return true;
    } catch (_) { return false; }
}

/**
 * Find the claude CLI executable path.
 * Belongs to output layer — swap this when using a different agent binary.
 */
export function findClaude() {
    if (process.env.CLAUDE_PATH) return process.env.CLAUDE_PATH;
    const found = which('claude');
    if (found) return found;
    const triage = process.platform === 'win32' ? WIN_TRIAGE : UNIX_TRIAGE;
    for (const p of triage) {
        if (isExecutable(p)) return p;
    }
    return null;
}
