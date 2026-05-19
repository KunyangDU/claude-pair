/**
 * Parse system prompt to extract folder and session ID.
 * Belongs to input layer — swap this when Chatbox format changes.
 *
 * System prompt is a plain string:
 *   - "/" prefix or "C:\" → absolute path, treated as folder
 *   - UUID / "continue" / "new" → treated as session ID
 *   - empty → uses defaultFolder
 */
export function parseSystemPrompt(raw, defaultFolder) {
    const text = (raw || '').trim();

    // Chatbox prepends metadata lines (model, date, etc.) — extract user's actual input
    const lastLine = text.split('\n').pop().trim();
    const input = lastLine || text;

    let folder = '';
    let sessionId = '';

    if (!input) {
        folder = defaultFolder || '';
    } else if (input.startsWith('/') || /^[A-Za-z]:[\\/]/.test(input)) {
        folder = input;
    } else {
        sessionId = input;
    }

    // Reject excessively long sessionId (malicious or malformed input)
    if (sessionId && sessionId.length > 100) {
        sessionId = '';
    }

    return { folder, sessionId, permission: 'ask' };
}

/**
 * Extract the last user message content from messages array.
 * Handles both string and array-of-content-parts formats.
 */
export function getLastUserMessage(messages) {
    if (!messages || !messages.length) return '';
    const userMsgs = messages.filter(m => m.role === 'user');
    if (!userMsgs.length) return '';
    const last = userMsgs[userMsgs.length - 1];
    if (typeof last.content === 'string') return last.content;
    if (Array.isArray(last.content)) {
        return last.content
            .filter(c => c.type === 'text')
            .map(c => c.text)
            .join('');
    }
    return '';
}
