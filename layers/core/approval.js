/**
 * Approval keywords for ask → auto permission mode switching.
 * Belongs to core layer — the approval policy is a business rule.
 */

const APPROVAL_KEYWORDS = [
    '允许', '同意', '执行', '继续', '好的', '可以', '批准', '确认', '行',
    'yes', 'ok', 'go', 'approve', 'proceed', 'confirm', 'y',
];

export function isApprovalMessage(msg) {
    const trimmed = msg.trim().toLowerCase();
    if (trimmed.length > 10) return false;

    const negations = ['不', '别', '取消', '拒绝', '否', 'no', 'n', 'stop', 'cancel', 'deny'];
    if (negations.includes(trimmed)) return false;

    return APPROVAL_KEYWORDS.includes(trimmed);
}
