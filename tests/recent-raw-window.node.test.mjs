import test from 'node:test';
import assert from 'node:assert/strict';
import { planRecentRawWindow, compareRecentRawWindows } from '../src/endpoints/backends/recent-raw-window.js';
import { emptyCategorizedMemory, buildCategorizedMemoryRequest, acceptCategorizedMemory, buildCategorizedDialogueMessages } from '../src/endpoints/backends/categorized-session-memory.js';

const history = [1, 2, 3].flatMap(turn => ['user', 'assistant'].map(role => ({ id: `${turn}-${role}`, turn, role, content: `${role} ${turn}` })));
const countMessages = rows => rows.reduce((sum, row) => sum + (row.turn === 4 ? 8 : row.role === 'user' ? 2 : 3), 0);
const input = { messages: history, countMessages, rawBudget: 6 };

test('protects complete latest turn and only proposes older completed prefix', () => {
    const before = structuredClone(input.messages);
    const plan = planRecentRawWindow(input);
    assert.equal(plan.candidateThroughTurn, 2);
    assert.deepEqual(plan.consolidationMessages, history.slice(0, 4));
    assert.deepEqual(plan.protectedMessages, history.slice(4));
    assert.deepEqual(plan.generationMessages, history);
    assert.equal(plan.awaitingConsolidationTokens, 10);
    assert.deepEqual(input.messages, before);
});

test('failed or pending consolidation cannot remove proposed prefix', () => {
    const a = planRecentRawWindow(input);
    const failed = planRecentRawWindow(input);
    assert.deepEqual(failed.generationMessages, a.generationMessages);
    const accepted = planRecentRawWindow({ ...input, throughTurn: 2 });
    assert.deepEqual(accepted.generationMessages, history.slice(4));
    assert.equal(accepted.candidateThroughTurn, 2);
    assert.equal(accepted.awaitingConsolidationTokens, 0);
});

test('latest user is never dropped and is never sent to writer without response', () => {
    const user = { id: '4-user', turn: 4, role: 'user', content: 'new question' };
    const plan = planRecentRawWindow({ ...input, messages: [...history, user] });
    assert.deepEqual(plan.protectedMessages, [user]);
    assert.equal(plan.protectedOverflowTokens, 2);
    assert.equal(plan.candidateThroughTurn, 3);
    assert.deepEqual(plan.generationMessages.at(-1), user);
});

test('oversize completed turn is preserved without clipping either speaker', () => {
    const plan = planRecentRawWindow({ ...input, rawBudget: 1 });
    assert.deepEqual(plan.protectedMessages, history.slice(4));
    assert.equal(plan.protectedOverflowTokens, 4);
});

test('large budget does not fabricate history or schedule unnecessary compression', () => {
    const plans = compareRecentRawWindows({ messages: history, countMessages });
    assert.equal(plans.length, 5);
    for (const plan of plans) {
        assert.equal(plan.candidateThroughTurn, 0);
        assert.equal(plan.protectedTokens, 15);
        assert.deepEqual(plan.protectedMessages, history);
    }
});

test('rejects missing source, incomplete checkpoint, invalid counts and non-native ordering', () => {
    assert.throws(() => planRecentRawWindow({ ...input, throughTurn: 4 }));
    assert.throws(() => planRecentRawWindow({ ...input, countMessages: null }));
    assert.throws(() => planRecentRawWindow({ ...input, countMessages: () => NaN }));
    assert.throws(() => planRecentRawWindow({ ...input, messages: history.map((row, i) => i === 1 ? { ...row, role: 'user' } : row) }));
    assert.throws(() => planRecentRawWindow({ ...input, messages: history.map((row, i) => i === 1 ? { ...row, id: history[0].id } : row) }));
});

test('source revisions change on edits and selection is contiguous at exact budget', () => {
    const exact = planRecentRawWindow({ ...input, rawBudget: 10 });
    assert.equal(exact.candidateThroughTurn, 1);
    assert.deepEqual(exact.protectedMessages, history.slice(2));
    const edited = planRecentRawWindow({ ...input, messages: history.map((row, i) => i === 0 ? { ...row, content: 'edited' } : row) });
    assert.notEqual(edited.sourceRevision, exact.sourceRevision);
});

test('measures whole slices instead of assuming individual message counts are additive', () => {
    const plan = planRecentRawWindow({ ...input, rawBudget: 7, countMessages: rows => rows.length * 2 + 1 });
    assert.equal(plan.protectedTokens, 5);
    assert.equal(plan.pendingTokens, 13);
    assert.equal(plan.awaitingConsolidationTokens, 9);
    assert.equal(plan.candidateThroughTurn, 2);
});

test('tokenizer cannot mutate protected native history through its input', () => {
    const plan = planRecentRawWindow({ ...input, countMessages: rows => { const count = countMessages(rows); rows[0].content = 'mutated'; return count; } });
    assert.deepEqual(plan.generationMessages, history);
    assert.deepEqual(plan.protectedMessages, history.slice(4));
});

test('validated consolidation consumes only planned prefix and leaves later native turns disjoint', () => {
    const previous = emptyCategorizedMemory({ world: 'test', story: 'test', branch: 'main' });
    const plan = planRecentRawWindow(input);
    const prepared = buildCategorizedMemoryRequest({ model: 'test' }, { fixedContext: 'fixed', previous, messages: plan.consolidationMessages });
    assert.equal(prepared.throughTurn, 2);
    assert.equal(prepared.sources.t3u, undefined);
    const candidate = { ...previous, through_turn: 2, overview: 'prefix only' };
    const accepted = acceptCategorizedMemory(JSON.stringify(candidate), prepared, previous, prepared.sources);
    const user = { id: '4-user', turn: 4, role: 'user', content: 'new question' };
    const next = planRecentRawWindow({ ...input, messages: [...history, user], throughTurn: accepted.through_turn });
    const prompt = buildCategorizedDialogueMessages({ fixedContext: 'fixed', memory: accepted, sources: prepared.sources, messages: next.generationMessages });
    assert.deepEqual(prompt.filter(row => row.role !== 'system'), [...history.slice(4), user].map(({ role, content }) => ({ role, content })));
    assert.match(prompt[1].content, /기억 경계 시점/);
    assert.equal(next.generationMessages.some(row => row.turn <= accepted.through_turn), false);
});
