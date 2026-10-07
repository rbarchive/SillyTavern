import test from 'node:test';
import assert from 'node:assert/strict';
import { capConsolidationPrefix } from '../src/endpoints/backends/recent-raw-window.js';
import { emptyCategorizedMemory, buildCategorizedDialogueMessages } from '../src/endpoints/backends/categorized-session-memory.js';
import { runContextMemoryTurn } from '../src/endpoints/backends/context-memory-runner.js';
import { nativeSession, assembleContextMessages } from '../src/endpoints/backends/context-memory.js';
const scope = { world: 'test-world', story: 'test-story', branch: 'main' };
const pairs = Array.from({ length: 4 }, (_, i) => ({ id: `m${i}`, turn: Math.floor(i / 2) + 1, role: i % 2 ? 'assistant' : 'user', content: '가'.repeat(350) }));
const measure = async rows => rows.reduce((n, row) => n + row.content.length, 0);
test('hard cap preserves whole turns and does not skip oversized first turn', async () => {
 const before = structuredClone(pairs), result = await capConsolidationPrefix(pairs, 1024, measure);
 assert.equal(result.throughTurn, 1); assert.equal(result.tokens, 700); assert.equal(result.pendingRows, 2); assert.deepEqual(pairs, before);
 const large = await capConsolidationPrefix(pairs, 699, measure); assert.equal(large.messages.length, 0); assert.equal(large.oversizedTurn, true);
 await assert.rejects(capConsolidationPrefix(pairs.slice(0, 3), 1024, measure));
 await assert.rejects(capConsolidationPrefix([pairs[0], { ...pairs[1], turn: 2 }], 1024, measure));
 await assert.rejects(capConsolidationPrefix(pairs, 1024, async () => -1));
});
test('source display preserves record text and gaps without inventing actual event times', () => {
 const memory = { ...emptyCategorizedMemory(scope), through_turn: 8, events: [
 { id: 'late', text: '5턴에서 과거를 뒤늦게 회상했다.', sources: ['s5'] },
 { id: 'earlier', text: '3턴의 계획을 8턴에서 정정했다.', sources: ['s3', 's8'] }] };
 const sources = Object.fromEntries([3, 5, 8].map(turn => [`s${turn}`, { turn, role: 'assistant', text: '원문' }]));
 const input = { fixedContext: '설정', memory, sources, messages: [{ id: 't9u', turn: 9, role: 'user', content: '다음 장면' }] }, before = structuredClone(memory);
 assert.deepEqual(buildCategorizedDialogueMessages(input), buildCategorizedDialogueMessages({ ...input, sourceChronology: false }));
 const output = buildCategorizedDialogueMessages({ ...input, sourceChronology: true })[1].content;
 assert.ok(output.indexOf(memory.events[1].text) < output.indexOf(memory.events[0].text));
 assert.ok(output.includes('근거 기록 턴: 3, 8 — 사건 발생 시각이 아님')); assert.ok(output.includes('근거 기록 턴: 5 — 사건 발생 시각이 아님')); assert.deepEqual(memory, before);
});
async function run({ fail = false, budget = 1024, editIndex } = {}) {
 const stored = [{ chat_metadata: {} }, { mes: '시작', is_user: false }, ...pairs.map(row => ({ mes: row.content, is_user: row.role === 'user' })), { mes: '다'.repeat(350), is_user: true }];
 let calls = 0; const updates = [];
 const result = await runContextMemoryTurn({ request: { messages: [{ role: 'system', content: '설정' }] }, session: nativeSession(stored), scope, fixedContext: '설정', rawBudget: 700, consolidationTokenBudget: budget,
 countMessages: measure, readSession: () => nativeSession(stored), saveDialogue: async reply => stored.push({ mes: reply.text, is_user: false }), update: x => updates.push(x),
 generate: async (...args) => { calls++; if (calls === 1) return { text: '답'.repeat(350) }; if (fail) throw new Error('writer failed'); if (editIndex !== undefined) stored[editIndex].mes = '편집된 원문';
 const payload = JSON.parse(args[3].messages[2].content); assert.equal(payload.through_turn, 1); assert.equal(payload.new_completed_prefix.length, 2);
 return { text: JSON.stringify({ version: 1, through_turn: 1, overview: '기억', current_state: { upsert: [], remove: [] }, events: { upsert: [], remove: [] }, knowledge: { upsert: [], remove: [] } }) }; } });
 return { stored, calls, updates, result };
}
test('eligible backlog triggers one writer even when capped prefix is under eligibility threshold', async () => {
 const { stored, calls, updates, result } = await run(); assert.equal(calls, 2); assert.equal(result.sessionSummary.summary.through_turn, 1); assert.equal(result.sessionSummary.targetAnchor.length, 4);
 assert.ok(updates.some(x => x.memoryMetrics?.consolidationTokens === 700 && x.memoryMetrics.backlogRows === 2));
 assert.equal(stored.length, 8); stored.push({ mes: '다음 입력', is_user: true });
 const next = assembleContextMessages([{ role: 'system', content: '설정' }], nativeSession(stored), result.sessionSummary, scope, '설정'); assert.equal(next.retrieval.pendingRows, 5); assert.equal(stored.length, 9);
});
test('failure or oversized first turn preserves all source and never adds a foreground call', async () => {
 const failed = await run({ fail: true }); assert.equal(failed.calls, 2); assert.equal(failed.result.sessionSummary.keepRaw, true); assert.equal(failed.stored.length, 8);
 const deferred = await run({ budget: 699 }); assert.equal(deferred.calls, 1); assert.equal(deferred.result.sessionSummary.keepRaw, true); assert.equal(deferred.stored.length, 8);
});

test('capped source edits reject checkpoint while edits after cap remain raw', async () => {
 const inside = await run({ editIndex: 2 }); assert.equal(inside.result.sessionSummary.status, 'failed'); assert.equal(inside.result.sessionSummary.keepRaw, true); assert.match(inside.result.sessionSummary.error, /prefix was edited/);
 const outside = await run({ editIndex: 4 }); assert.equal(outside.result.sessionSummary.status, 'complete'); assert.equal(outside.result.sessionSummary.summary.through_turn, 1); assert.equal(outside.stored[4].mes, '편집된 원문');
 outside.stored.push({ mes: '다음 입력', is_user: true }); const next = assembleContextMessages([{ role: 'system', content: '설정' }], nativeSession(outside.stored), outside.result.sessionSummary, scope, '설정'); assert.ok(next.messages.some(x => x.content.includes('편집된 원문')));
});
