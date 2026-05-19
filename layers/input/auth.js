/**
 * Bearer Token authentication middleware.
 * Belongs to input layer — swap this when auth method changes.
 *
 * Skips auth when no API key is configured (auto-degrade).
 */
export function createAuthMiddleware(config) {
    const apiKey = (process.env.REMOTE_VIBING_API_KEY || config?.auth?.api_key || '').trim();

    if (!apiKey) {
        return (req, res, next) => next();
    }

    return (req, res, next) => {
        const authHeader = req.headers.authorization || '';
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

        if (token !== apiKey) {
            res.status(401).json({ error: 'Unauthorized' });
            return;
        }
        next();
    };
}
