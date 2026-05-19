import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Find a session by ID and extract its working folder from the JSONL file.
 * Belongs to core layer — session lookup is independent of how Claude is spawned.
 */
export function findSession(sessionId) {
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) return { found: false, folder: null };
    const projectsDir = path.join(os.homedir(), '.claude', 'projects');
    try {
        const dirs = fs.readdirSync(projectsDir);
        for (const dir of dirs) {
            const sessionPath = path.join(projectsDir, dir, `${sessionId}.jsonl`);
            if (fs.existsSync(sessionPath)) {
                let folder = null;
                try {
                    const MAX_SESSION_FILE = 256 * 1024; // 256KB
                    const stat = fs.statSync(sessionPath);
                    if (stat.size > MAX_SESSION_FILE) continue;
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
