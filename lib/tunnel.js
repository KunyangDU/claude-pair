import { spawn } from 'child_process';
import path from 'path';
import os from 'os';

/**
 * Start cloudflared tunnel, parse the metrics server port from output.
 * Returns { process, close } — caller can kill the child and await close.
 */
export function startTunnel(configPath) {
    return new Promise((resolve, reject) => {
        const args = [
            'tunnel',
            '--config', configPath,
            'run',
        ];

        console.log(`[tunnel] spawn: cloudflared ${args.join(' ')}`);

        const child = spawn('cloudflared', args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env },
        });

        const timeout = setTimeout(() => {
            reject(new Error('Tunnel start timed out after 30s'));
        }, 30000);

        let stopped = false;

        child.stderr.on('data', (d) => {
            const text = d.toString();
            console.error(`[tunnel] ${text.trim()}`);

            // Resolve when tunnel connection is registered
            if (!stopped && text.includes('Registered tunnel connection')) {
                stopped = true;
                clearTimeout(timeout);
                console.log('[tunnel] connected successfully');
                resolve({
                    process: child,
                    close: () => {
                        if (!child.killed) child.kill();
                    },
                });
            }
        });

        child.stdout.on('data', (d) => {
            console.log(`[tunnel] ${d.toString().trim()}`);
        });

        child.on('error', (err) => {
            clearTimeout(timeout);
            reject(err);
        });

        child.on('exit', (code) => {
            clearTimeout(timeout);
            if (!stopped) {
                stopped = true;
                reject(new Error(`cloudflared exited with code ${code}`));
            }
        });
    });
}
