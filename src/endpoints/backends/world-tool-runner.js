import { extractGenerationReply } from './generation-stream.js';
import { randomUUID } from 'node:crypto';

export const WORLD_TOOL_ADAPTER = Symbol.for('sillytavern.rpMemoryBackgroundTools');
const pending = new Map();
const keyFor = (user, id) => `${user.directories.root}\0${id}`;
export function worldToolAdapter() { return globalThis[WORLD_TOOL_ADAPTER]; }

/** Decisions target the exact pending call, not whichever World is on screen now. */
export function decideWorldTool(user, id, { token, approved, claim, result }) {
    const item = pending.get(keyFor(user, id));
    if (!item || token !== item.token) throw new Error('This tool request is no longer pending.');
    item.validate();
    if (item.claimed && claim) throw new Error('Tool action has already been claimed.');
    if (item.mode === 'client' && claim) {
        item.claimed = true;
        item.update({ toolPending: { ...item.view, claimed: true }, phase: 'tools' });
        return { claimed: true };
    }
    if (item.mode === 'client' && !item.claimed) throw new Error('Claim the browser action before executing it.');
    if (item.mode === 'client' && (typeof result !== 'string' || result.length > 64000)) throw new Error('Invalid tool result.');
    if (item.mode !== 'client' && typeof approved !== 'boolean') throw new Error('An explicit approval decision is required.');
    pending.delete(keyFor(user, id));
    item.resolve(item.mode === 'client' ? { result } : { approved });
    return { accepted: true };
}
function waitForDecision({ user, id, call, mode, signal, update, scope, validate }) {
    const token = randomUUID();
    const view = { token, mode, name: call.function.name, arguments: call.function.arguments, scope, claimed: false };
    return new Promise((resolve, reject) => {
        const key = keyFor(user, id);
        const abort = () => { pending.delete(key); reject(signal.reason || new DOMException('Stopped', 'AbortError')); };
        signal.addEventListener('abort', abort, { once: true });
        pending.set(key, { token, mode, view, update, validate, resolve: value => { signal.removeEventListener('abort', abort); resolve(value); } });
        update({ phase: mode === 'client' ? 'awaiting-tool' : 'awaiting-confirmation', toolPending: view, preview: '' });
        if (signal.aborted) abort();
    });
}

/** Only the registered RP adapter can execute tools; scope is frozen by the server. */
export async function runWorldToolTurn({ input, adapter, scope, user, id, signal, update, generate }) {
    const request = structuredClone(input);
    const allowed = new Set(request.tools.map(tool => tool.function.name));
    const receipts = [];
    const seenIds = new Map();
    for (let round = 0; round < 8; round++) {
        signal.throwIfAborted();
        adapter.validate(scope);
        await update({ phase: 'dialogue', toolPending: null, preview: '' });
        const data = await generate(request, signal, update);
        const message = data.choices?.[0]?.message;
        const calls = message?.tool_calls;
        if (!calls?.length) {
            const reply = extractGenerationReply(data, request.model);
            return { ...reply, toolReceipts: receipts };
        }
        if (calls.length > 8 || receipts.length + calls.length > 24) throw new Error('World tool call limit exceeded.');
        request.messages.push({ role: 'assistant', content: message.content || null, tool_calls: calls });
        for (const call of calls) {
            signal.throwIfAborted();
            if (!call.id || call.type !== 'function' || !allowed.has(call.function?.name)) throw new Error('Unapproved World tool.');
            const payload = JSON.stringify(call.function);
            if (seenIds.has(call.id)) throw new Error('Provider reused a tool call ID; no action was replayed.');
            seenIds.set(call.id, payload);
            if (typeof call.function.arguments !== 'string' || call.function.arguments.length > 32000) throw new Error('Invalid World tool arguments.');
            const args = JSON.parse(call.function.arguments);
            if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('World tool arguments must be an object.');
            adapter.validate(scope);
            const mode = adapter.mode(scope, call.function.name, args);
            let result, writeApplied = false;
            if (mode === 'client') {
                result = (await waitForDecision({ user, id, call, mode, signal, update, scope, validate: () => adapter.validate(scope) })).result;
            } else {
                const decision = mode === 'approval' ? await waitForDecision({ user, id, call, mode, signal, update, scope, validate: () => adapter.validate(scope) }) : { approved: true };
                signal.throwIfAborted();
                adapter.validate(scope);
                if (!decision.approved) result = '사용자가 저장을 취소했습니다. 저장하지 않았습니다.';
                else {
                    await update({ phase: 'tools', toolPending: null });
                    result = await adapter.invoke(scope, call.function.name, args, { signal });
                    writeApplied = mode === 'approval';
                }
            }
            const warning = typeof result?.warning === 'string' ? result.warning : undefined;
            result = typeof result === 'string' ? result : JSON.stringify(result);
            if (result.length > 64000) throw new Error('World tool result is too large.');
            receipts.push({ round, id: call.id, name: call.function.name, arguments: call.function.arguments, result, writeApplied, ...(warning ? { warning } : {}) });
            // Receipts survive conflict/cancellation; restarting never replays this runner.
            await update({ phase: 'tools', toolPending: null, toolReceipts: receipts });
            signal.throwIfAborted();
            request.messages.push({ role: 'tool', tool_call_id: call.id, content: result });
        }
    }
    throw new Error('World tool round limit exceeded.');
}
