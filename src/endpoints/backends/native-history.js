import { createHash } from 'node:crypto';
export const nativeRevision = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Include every field that can change interpretation, including auxiliary rows. */
export const nativeRowHash = row => nativeRevision({ mes: row.mes, is_user: row.is_user, is_system: row.is_system,
    swipe_id: row.swipe_id ?? 0, role: row.extra?.rp_memory?.role, protagonist: row.extra?.rp_memory?.protagonist_id,
    intent: row.extra?.rp_memory?.intent, kind: row.extra?.rp_memory?.kind || 'scene',
    ...(row.extra?.media?.length ? { media: row.extra.media } : {}),
    ...(typeof row.extra?.image_generation_prompt === 'string' ? { image_generation_prompt: row.extra.image_generation_prompt } : {}) });
export const isGeneratedMediaRecord = row => !row.is_user && (row.is_system || (typeof row.extra?.image_generation_prompt === 'string' && row.extra.image_generation_prompt === row.mes)) && row.extra?.media?.some(item => item.source === 'generated' || item.generation_type !== undefined);
const provenance = row => ({ role: row.extra?.rp_memory?.role, protagonist: row.extra?.rp_memory?.protagonist_id,
    intent: row.extra?.rp_memory?.intent, kind: row.extra?.rp_memory?.kind || 'scene' });
/** The archive is untouched. Only logical exchanges are grouped for the pair-based writer. */
export function normalizeNativeHistory(rows) {
    if (!Array.isArray(rows) || !rows[0]?.chat_metadata) throw new Error('Missing native chat identity');
    const segments = [], auxiliary = [];
    for (let index = 1; index < rows.length; index++) {
        const row = rows[index];
        if (typeof row.mes !== 'string') throw new Error('Unsupported native message content');
        if (row.extra?.tool_calls || row.extra?.function_call || row.extra?.tool_invocations) throw new Error('Unsupported native tool record');
        // Generated image captions/prompts are not events in the story. Text on a
        // normal user attachment remains a user input; image pixels are archival.
        if (row.is_system || isGeneratedMediaRecord(row) || !row.mes.trim()) { auxiliary.push({ source_row: index, kind: row.extra?.media?.length ? 'media-artifact' : row.is_system ? 'system-record' : 'empty' }); continue; }
        segments.push({ source_row: index, role: row.is_user ? 'user' : 'assistant', content: row.mes, source_context: provenance(row) });
    }
    const firstUser = segments.findIndex(row => row.role === 'user');
    const opening = (firstUser < 0 ? segments : segments.slice(0, firstUser)).map(row => ({ role: row.role, content: row.content }));
    const dialogue = firstUser < 0 ? [] : segments.slice(firstUser);
    const groups = [];
    for (const segment of dialogue) {
        if (groups.at(-1)?.role === segment.role) groups.at(-1).segments.push(segment);
        else groups.push({ role: segment.role, segments: [segment] });
    }
    const messages = groups.map((group, index) => {
        const turn = Math.floor(index / 2) + 1;
        const single = group.segments.length === 1;
        const content = single ? group.segments[0].content : group.segments.map(segment =>
            `[원문 메시지 r${segment.source_row} · 출처 ${JSON.stringify(segment.source_context)}]\n${segment.content}`).join('\n\n');
        return { id: `t${turn}${group.role === 'user' ? 'u' : 'a'}`, turn, role: group.role, content,
            source_context: single ? group.segments[0].source_context : { kind: 'scene', segments: group.segments },
            source_rows: group.segments.map(segment => segment.source_row) };
    });
    const boundaries = {};
    for (let i = 1; i < messages.length; i += 2) {
        const next = messages[i + 1];
        boundaries[messages[i].turn] = next ? next.source_rows[0] : rows.length;
    }
    return { messages, opening, auxiliary, start: dialogue[0]?.source_row ?? rows.length,
        boundaries, anchors: rows.map(nativeRowHash), completedThrough: messages.findLast(row => row.role === 'assistant')?.turn || 0 };
}
export function nativePrefixBoundary(session, through) {
    const boundary = session.boundaries?.[through];
    if (!Number.isSafeInteger(boundary) || boundary < 1 || boundary > session.anchors.length) throw new Error('Missing native prefix boundary');
    return boundary;
}

/** Allow only ST's documented text blocks, CR removal and same-role joining. */
export function nativeProviderCoverage(rows, messages) {
    if (!Array.isArray(messages)) return null;
    const text = content => typeof content === 'string' ? content : Array.isArray(content) && content.every(block => block.type === 'text' && typeof block.text === 'string') ? content.map(block => block.text).join('\n\n') : null;
    const transcript = [];
    for (const row of messages) {
        if (!['system','user','assistant'].includes(row.role) || row.tool_calls || row.tool_call_id || row.function_call) return null;
        const content = text(row.content); if (content === null) return null;
        if (row.role !== 'system' && content.trim()) transcript.push({ role: row.role, content: content.replaceAll('\r','').trim() });
    }
    if (/^\s*(?:<think>\s*)?<\/think>\s*$/u.test(transcript.at(-1)?.content || '')) transcript.pop();
    const native = rows.slice(1).map((row,index)=>({ role: row.is_user ? 'user' : 'assistant', content: row.mes?.replaceAll('\r','').trim(), source_row:index+1, row }))
        .filter(item=>!item.row.is_system && !isGeneratedMediaRecord(item.row) && item.content);
    if (transcript[0]?.role === 'user' && transcript[0].content === '[Start a new chat]' && native[0]?.role === 'assistant' && transcript[1]?.role === 'assistant' && transcript[1].content === native[0].content) transcript.shift();
    const merge = input => input.reduce((out,row)=>{ if(out.at(-1)?.role === row.role) out.at(-1).content += '\n\n'+row.content; else out.push({role:row.role,content:row.content}); return out; },[]);
    const expected = merge(transcript);
    if (!expected.length || expected.at(-1).role !== 'user') return null;
    // A provider suffix must end at the saved pending input. The full archive is
    // assembled separately, so ST truncation is never mistaken for lost source.
    for (let start=0;start<native.length;start++) {
        if (JSON.stringify(merge(native.slice(start))) === JSON.stringify(expected)) return { firstRow:native[start].source_row,rows:rows.length };
    }
    return null;
}
