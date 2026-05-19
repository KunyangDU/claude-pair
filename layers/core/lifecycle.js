/**
 * Server lifecycle management: idle timeout, graceful shutdown, process tracking.
 * Belongs to core layer — swap this when the server hosting model changes.
 */

const IDLE_TIMEOUT_MS = 3 * 60 * 60 * 1000;

export function createLifecycle(server) {
    const activeProcesses = new Set();
    let idleTimer = null;
    let shuttingDown = false;

    function resetIdleTimer() {
        if (shuttingDown) return;
        clearTimeout(idleTimer);
        idleTimer = setTimeout(tryShutdown, IDLE_TIMEOUT_MS);
    }

    function tryShutdown() {
        if (shuttingDown) return;
        if (activeProcesses.size === 0) {
            shuttingDown = true;
            console.log('[lifecycle] idle timeout, shutting down');
            server.close(() => {
                if (activeProcesses.size === 0) process.exit(0);
            });
        }
    }

    ['SIGINT', 'SIGTERM'].forEach(signal => {
        process.on(signal, () => {
            console.log(`\n[lifecycle] ${signal}, shutting down...`);
            for (const child of activeProcesses) child.kill();
            process.exit(0);
        });
    });

    function isShuttingDown() {
        return shuttingDown;
    }

    return {
        activeProcesses,
        resetIdleTimer,
        tryShutdown,
        isShuttingDown,
        IDLE_TIMEOUT_MS,
    };
}
