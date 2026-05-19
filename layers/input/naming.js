import path from 'path';
import { getLastUserMessage } from './parse.js';

/**
 * Chatbox auto-naming: detects and responds to naming requests.
 * Belongs to input layer — swap this when the chat client auto-naming changes.
 */

export function isNamingRequest(messages) {
    const hasSystem = messages?.some(m => m.role === 'system');
    if (hasSystem) return false;
    const userMsg = getLastUserMessage(messages);
    return userMsg.includes('give this conversation a name')
        || userMsg.includes('Name this conversation');
}

export function handleNamingRequest(res, sessionMeta, stream) {
    const folderName = path.basename(sessionMeta.folder);
    const shortId = sessionMeta.sessionId?.slice(0, 8);
    const name = shortId
        ? `claude-pair: ${folderName}/${shortId}`
        : `claude-pair: ${folderName}`;

    if (stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();
        res.write(`data: ${JSON.stringify({
            id: 'name-' + Date.now(),
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: { content: name } }],
        })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
    } else {
        res.json({
            id: 'name-' + Date.now(),
            object: 'chat.completion',
            model: 'claude-code',
            choices: [{ index: 0, message: { role: 'assistant', content: name }, finish_reason: 'stop' }],
        });
    }
}
