import { execSync } from 'child_process';
import os from 'os';
import path from 'path';

const TRIAGE_PATHS = [
    path.join(os.homedir(), '.local/bin/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    '/usr/bin/claude',
];

/**
 * Find the claude CLI executable path.
 * Priority: CLAUDE_PATH env → which claude → triage paths.
 */
export function findClaude() {
    // 1. Env override
    if (process.env.CLAUDE_PATH) return process.env.CLAUDE_PATH;

    // 2. which claude
    try {
        const found = execSync('which claude', { encoding: 'utf8' }).trim();
        if (found) return found;
    } catch (_) { /* not in PATH */ }

    // 3. Triage paths
    for (const p of TRIAGE_PATHS) {
        try {
            execSync(`test -x "${p}"`);
            return p;
        } catch (_) { /* not found */ }
    }

    return null;
}
