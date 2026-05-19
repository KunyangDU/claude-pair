import fs from 'fs';

/**
 * Parse system prompt for JSON config with folder/session/permission.
 * Expected format: {"folder":"/path","session":"uuid","permission":"auto"}
 * Only "folder" is required.
 */
export function parseSystemPrompt(raw) {
    const content = raw || '';

    // Try to find a JSON object in the text (Chatbox may prepend text)
    const jsonMatch = content.match(/\{[^}]*"folder"[^}]*\}/);
    let cfg = {};
    if (jsonMatch) {
        try {
            cfg = JSON.parse(jsonMatch[0]);
        } catch (_) {
            return { error: 'Invalid JSON in system prompt' };
        }
    }

    const folder = cfg.folder || '';
    const sessionId = cfg.session || '';
    const permission = cfg.permission || 'ask';

    if (!folder) {
        return { error: 'Missing "folder" in system prompt JSON. Example: {"folder":"/path/to/project"}' };
    }
    if (!fs.existsSync(folder)) {
        return { error: `Folder not found: ${folder}` };
    }

    return { folder, sessionId, permission };
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

/**
 * Detect if this is a Chatbox auto-naming request.
 */
export function isNamingRequest(messages) {
    const hasSystem = messages?.some(m => m.role === 'system');
    if (hasSystem) return false;
    const userMsg = getLastUserMessage(messages);
    return userMsg.includes('give this conversation a name')
        || userMsg.includes('Name this conversation');
}
