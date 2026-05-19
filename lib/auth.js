/**
 * Simple Bearer token auth middleware.
 * Reads token from REMOTE_VIBING_API_KEY env var or config.auth.api_key.
 * Skips auth if no key is configured.
 */
export function createAuthMiddleware(config) {
    const apiKey = (process.env.REMOTE_VIBING_API_KEY
        || config?.auth?.api_key
        || '').trim();

    if (!apiKey) {
        return (req, res, next) => next();
    }

    return (req, res, next) => {
        const auth = req.headers.authorization;
        if (!auth || !auth.startsWith('Bearer ')) {
            res.status(401).json({ error: 'Missing Authorization header' });
            return;
        }
        const token = auth.slice(7);
        if (token !== apiKey) {
            res.status(401).json({ error: 'Invalid API key' });
            return;
        }
        next();
    };
}
