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
                if (activeProcesses.size === 0) {
                    process.exit(0);
                } else {
                    // Wait up to 10s for processes to finish, then force exit
                    const forceExit = setTimeout(() => process.exit(0), 10000);
                    const checkDone = () => {
                        if (activeProcesses.size === 0) {
                            clearTimeout(forceExit);
                            process.exit(0);
                        } else {
                            setTimeout(checkDone, 100);
                        }
                    };
                    checkDone();
                }
            });
        } else {
            // Processes still active — re-arm timer to check again later
            resetIdleTimer();
        }
    }

    const signals = ['SIGINT'];
    if (process.platform !== 'win32') signals.push('SIGTERM');
    signals.forEach(signal => {
        process.on(signal, () => {
            console.log(`\n[lifecycle] ${signal}, shutting down...`);
            shuttingDown = true;
            for (const child of activeProcesses) child.kill();
            // Wait up to 3s for children to exit, then force exit
            const forceExit = setTimeout(() => process.exit(0), 3000);
            if (activeProcesses.size === 0) {
                clearTimeout(forceExit);
                process.exit(0);
            } else {
                const checkDone = () => {
                    if (activeProcesses.size === 0) {
                        clearTimeout(forceExit);
                        process.exit(0);
                    } else {
                        setTimeout(checkDone, 100);
                    }
                };
                checkDone();
            }
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
