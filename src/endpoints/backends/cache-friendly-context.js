const ROLE_METADATA = /\n(최근 사용자 발화 역할\(메시지 번호: 역할\): [^\r\n]+)$/u;

/** Keep instructions in system; put the changing role index with current input data.
 * The native runtime combines all system messages at the front of its template.
 */
export function orderRoleMetadata(messages) {
    const lastUser = messages.findLastIndex(row => row.role === 'user');
    const firstDialogue = messages.findIndex(row => row.role !== 'system');
    if (lastUser < 0 || firstDialogue < 0 || typeof messages[lastUser].content !== 'string') return messages;
    const candidates = messages.flatMap((row, index) => {
        if (index >= firstDialogue || row.role !== 'system' || typeof row.content !== 'string') return [];
        const match = row.content.match(ROLE_METADATA);
        return match ? [{ index, match }] : [];
    });
    // Unknown/ambiguous formats are left intact. Never move text from a user message.
    if (candidates.length !== 1) return messages;
    const { index, match } = candidates[0];
    if (!messages[index].content.slice(0, -match[0].length).trim()) return messages;
    const result = messages.map(row => ({ ...row }));
    result[index].content = result[index].content.slice(0, -match[0].length);
    result[lastUser].content = `${match[1]}\n\n${result[lastUser].content}`;
    return result;
}
