/**
 * Qwen templates require a user query other than a tool_response wrapper.
 * Preserve existing roles/content and insert the standard ST placeholder only
 * when a continuation or auxiliary request has no qualifying query.
 * @param {object[]} messages
 * @param {string} [placeholder]
 * @returns {object[]}
 */
export function ensureQwenUserQuery(messages, placeholder = "Let's get started.") {
    if (!Array.isArray(messages)) return messages;
    const hasQuery = messages.some(message => {
        if (message.role !== 'user') return false;
        const content = typeof message.content === 'string' ? message.content
            : Array.isArray(message.content) ? message.content.map(part => part.text || '').join('') : '';
        const text = content.trim();
        return !(text.startsWith('<tool_response>') && text.endsWith('</tool_response>'));
    });
    if (hasQuery) return messages;
    const index = messages.findIndex(message => message.role !== 'system');
    const result = [...messages];
    result.splice(index < 0 ? result.length : index, 0, {
        role: 'user', content: placeholder,
    });
    return result;
}
