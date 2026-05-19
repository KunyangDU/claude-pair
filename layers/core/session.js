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
                    const buf = Buffer.alloc(64 * 1024);
                    const fd = fs.openSync(sessionPath, 'r');
                    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
                    fs.closeSync(fd);
                    const head = buf.toString('utf8', 0, bytesRead);
                    const lines = head.split('\n').slice(0, 100);
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
