import { createHash } from 'node:crypto';

export const RECENT_RAW_BUDGETS = Object.freeze([4096, 6144, 8192, 12288, 16384]);

/** Plan a boundary, never delete uncommitted history. Measure each whole slice with the caller's tokenizer. */
export function planRecentRawWindow({ messages, throughTurn = 0, rawBudget, countMessages }) {
    if (!Array.isArray(messages) || !messages.length || typeof countMessages !== 'function'
        || !Number.isSafeInteger(throughTurn) || throughTurn < 0 || !Number.isSafeInteger(rawBudget) || rawBudget < 1)
        throw new Error('Invalid raw window inputs');
    let turn = 1, role = 'user';
    const units = [];
    const ids = new Set();
    messages.forEach(row => {
        if (!row || typeof row.id !== 'string' || !row.id || ids.has(row.id) || row.turn !== turn || row.role !== role
            || typeof row.content !== 'string' || !row.content.trim())
            throw new Error('Raw history must contain ordered native turns with measured counts');
        ids.add(row.id);
        if (role === 'user') units.push({ turn, rows: [], complete: false });
        const unit = units.at(-1);
        unit.rows.push(structuredClone(row));
        if (role === 'assistant') { unit.complete = true; turn++; }
        role = role === 'user' ? 'assistant' : 'user';
    });
    const lastCompleted = units.at(-1).complete ? units.at(-1).turn : units.at(-1).turn - 1;
    if (throughTurn > lastCompleted) throw new Error('Checkpoint crosses an incomplete or missing turn');
    const pending = units.filter(unit => unit.turn > throughTurn);
    const flatten = items => items.flatMap(unit => unit.rows);
    const measure = items => {
        if (!items.length) return 0;
        const count = countMessages(structuredClone(flatten(items)));
        if (!Number.isSafeInteger(count) || count < 0) throw new Error('Tokenizer returned an invalid count');
        return count;
    };
    let start = pending.length, protectedTokens = 0;
    for (let index = pending.length - 1; index >= 0; index--) {
        const candidateTokens = measure(pending.slice(index));
        // Always retain the latest unit, even if it alone exceeds the budget.
        if (start < pending.length && candidateTokens > rawBudget) break;
        start = index;
        protectedTokens = candidateTokens;
    }
    const eligible = pending.slice(0, start);
    const protectedUnits = pending.slice(start);
    const pendingTokens = measure(pending);
    const sourceRevision = createHash('sha256').update(JSON.stringify(messages)).digest('hex');
    return {
        throughTurn, rawBudget, sourceRevision,
        // Caller must accept a scope/revision-validated writer result before moving throughTurn.
        candidateThroughTurn: eligible.at(-1)?.turn ?? throughTurn,
        consolidationMessages: flatten(eligible),
        protectedMessages: flatten(protectedUnits),
        generationMessages: flatten(pending),
        pendingTokens, protectedTokens,
        protectedOverflowTokens: Math.max(0, protectedTokens - rawBudget),
        awaitingConsolidationTokens: measure(eligible),
    };
}

/** A sweep is a comparison of plans, not a license to remove each plan's eligible prefix. */
export function compareRecentRawWindows(input, budgets = RECENT_RAW_BUDGETS) {
    return budgets.map(rawBudget => planRecentRawWindow({ ...input, rawBudget }));
}

/** Bound one writer call; the remainder stays pending until a later accepted checkpoint. */
export async function capConsolidationPrefix(messages, tokenBudget, countMessages) {
    if (!Array.isArray(messages) || messages.length % 2 || !Number.isSafeInteger(tokenBudget)
        || tokenBudget < 1 || typeof countMessages !== 'function') throw new Error('Invalid consolidation cap');
    let selected = [], tokens = 0;
    for (let index = 0; index < messages.length; index += 2) {
        const user = messages[index], assistant = messages[index + 1];
        if (user?.role !== 'user' || assistant?.role !== 'assistant' || user.turn !== assistant.turn
            || !Number.isSafeInteger(user.turn) || user.turn < 1
            || [user, assistant].some(row => typeof row.content !== 'string' || !row.content.trim())
            || (index && user.turn !== messages[index - 2].turn + 1)) throw new Error('Expected contiguous completed turns');
    }
    for (let end = 2; end <= messages.length; end += 2) {
        const candidate = messages.slice(0, end);
        const measured = await countMessages(candidate.map(({ role, content }) => ({ role, content })));
        if (!Number.isSafeInteger(measured) || measured < 0) throw new Error('Invalid consolidation token count');
        if (measured > tokenBudget) break;
        selected = candidate; tokens = measured;
    }
    return { messages: structuredClone(selected), tokens,
        throughTurn: selected.at(-1)?.turn ?? null,
        pendingRows: messages.length - selected.length,
        oversizedTurn: messages.length > 0 && selected.length === 0 };
}
