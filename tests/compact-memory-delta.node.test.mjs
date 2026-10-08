import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDeltaRequest, mergeMemoryDelta, assembleContextMessages } from '../src/endpoints/backends/context-memory.js';
import { emptyCategorizedMemory } from '../src/endpoints/backends/categorized-session-memory.js';
import { nativeSession } from '../src/endpoints/backends/context-memory.js';
import { runContextMemoryTurn } from '../src/endpoints/backends/context-memory-runner.js';
const scope = { world: 'w', story: 's', branch: 'b' };
const messages = [{ id: 't1u', turn: 1, role: 'user', content: '도착하면 함께 점검하자.' }, { id: 't1a', turn: 1, role: 'assistant', content: '아직 도착하지 않았고, 도착 후 함께 점검하기로 약속했다.' }];
const sources = Object.fromEntries(messages.map(x => [x.id, { turn: x.turn, role: x.role, text: x.content }]));
const prepare = memory => buildDeltaRequest({ model: 'qwen', temperature: 0 }, { fixedContext: '세계', messages, memory, wireFormat: 'compact-v2' });
test('compact tuples restore exact source IDs without changing canonical storage or native suffix', () => {
    const memory = emptyCategorizedMemory(scope), prepared = prepare(memory);
    assert.deepEqual(prepared.sourceTable, ['t1u', 't1a']);
    const input = JSON.parse(prepared.request.messages.find(x => x.role === 'user').content);
    assert.deepEqual(input.new_completed_prefix.map(({ source, ...row }) => ({ id: prepared.sourceTable[source], ...row })), messages);
    assert.equal(prepared.request.response_format, undefined);
    assert.equal(prepared.request.max_tokens, 8192);
    const delta = { v: 2, t: 1, s: [['arrival', '미도착; 도착 후 동행 점검 약속은 유효하다.', [0, 1]]], e: [['promise', '도착 후 함께 점검하기로 약속했다. 아직 이행되지 않았다.', [0, 1]]] };
    const next = mergeMemoryDelta(JSON.stringify(delta).slice(1), prepared, memory, sources);
    assert.equal(next.version, 4); assert.equal(next.overview, ''); assert.equal(next.through_turn, 1);
    assert.deepEqual(next.events[0].sources, ['t1u', 't1a']); assert.deepEqual(next.scope, scope);
    const later = [...messages, { id: 't2u', turn: 2, role: 'user', content: '도착했다. 지금 점검하자.' }];
    const assembled = assembleContextMessages([{ role: 'system', content: '세계' }], { messages: later, opening: [] }, { summary: next }, scope, '세계');
    assert.equal(assembled.messages.filter(x => x.role === 'user').length, 1);
    assert.match(assembled.messages.at(-1).content, /도착했다/);
    assert.ok(!assembled.messages.some(x => x.role !== 'system' && messages.some(m => x.content === m.content)));
});
test('compact updates preserve untouched episodes, resolve open state explicitly and clear stale overview', () => {
    const memory = emptyCategorizedMemory(scope);
    memory.through_turn = 1; memory.overview = '도착을 기다리는 중.';
    memory.current_state = [{ id: 'waiting', text: '도착 전.', sources: ['t1u'] }];
    memory.events = [{ id: 'promise', text: '도착 후 함께 점검하기로 약속했다.', sources: ['t1u'] }];
    const nextRows = [{ id: 't2u', turn: 2, role: 'user', content: '도착하여 함께 점검을 마쳤다.' }, { id: 't2a', turn: 2, role: 'assistant', content: '완료를 확인했다.' }];
    const prepared = buildDeltaRequest({}, { fixedContext: '세계', memory, messages: nextRows, wireFormat: 'compact-v2' });
    const input = JSON.parse(prepared.request.messages.find(x => x.role === 'user').content);
    assert.equal(input.previous_memory.e[0][1], memory.events[0].text);
    assert.deepEqual(input.previous_memory.e[0][2].map(i => prepared.sourceTable[i]), memory.events[0].sources);
    const catalog = { ...sources, ...Object.fromEntries(nextRows.map(x => [x.id, { turn: x.turn, role: x.role, text: x.content }])) };
    const delta = { v: 2, t: 2, s: [['done', '도착 후 함께 점검 완료.', [0, 1]]], x: [['s', 'waiting']], o: '' };
    const next = mergeMemoryDelta(JSON.stringify(delta), prepared, memory, catalog);
    assert.deepEqual(next.events, memory.events); assert.equal(next.overview, '');
    assert.deepEqual(next.current_state.map(x => x.id), ['done']); assert.deepEqual(memory.current_state.map(x => x.id), ['waiting']);
    assert.throws(() => mergeMemoryDelta(JSON.stringify({ v: 2, t: 2, x: [[['s'], 'waiting']], o: '' }), prepared, memory, catalog), /removal/);
    // Actual writer failure: flat removal IDs must never be repaired or partially applied.
    assert.throws(() => mergeMemoryDelta(JSON.stringify({ v: 2, t: 2, s: [['waiting', '새 상태', [0]]], x: ['waiting'], o: '' }), prepared, memory, catalog), /removal/);
    assert.deepEqual(memory.current_state.map(x => x.id), ['waiting']);
    assert.throws(() => mergeMemoryDelta(JSON.stringify({ ...delta, s: [['waiting', '새 상태', [0]]] }), prepared, memory, catalog), /duplicate/);
    delete delta.o;
    assert.throws(() => mergeMemoryDelta(JSON.stringify(delta), prepared, memory, catalog), /overview/);
});
test('compact decoder rejects ambiguity without partial acceptance or legacy fallback', () => {
    const memory = emptyCategorizedMemory(scope), before = structuredClone(memory), prepared = prepare(memory);
    const failures = [
        { v: 2, t: 1, e: [['e', '내용', [2]]] }, { v: 2, t: 1, e: [['e', '내용', [0.5]]] },
        { v: 2, t: 1, e: [['e', '내용', ['t1u']]] },
        { v: 2, t: 1, e: [['e', '내용', [0, 0]]] }, { v: 2, t: 1, e: [['e', '내용', [-1]]] },
        { v: 2, t: 1, e: [['e', '내용', [0], 'extra']] }, { v: 2, t: 1, e: null },
        { v: 2, t: 1, e: [['e', '내용', [0]], ['e', '다른 내용', [1]]] },
        { v: 2, t: 1, x: [['e', 'missing']] }, { v: 2, t: 1, x: [['unknown', 'e']] },
        { v: 2, t: 2 }, { v: 2, t: 1, unknown: [] }, { v: 1, t: 1 },
        { v: 2, t: 1, k: [['k', '추정', [0], '인물', 'fact']] },
        { version: 1, through_turn: 1, overview: '', current_state: { upsert: [], remove: [] }, events: { upsert: [], remove: [] }, knowledge: { upsert: [], remove: [] } },
    ];
    for (const delta of failures) assert.throws(() => mergeMemoryDelta(JSON.stringify(delta), prepared, memory, sources));
    assert.throws(() => mergeMemoryDelta('{"v":2,"v":2,"t":1}', prepared, memory, sources), /Duplicate/);
    assert.deepEqual(memory, before);
    const changed = structuredClone(memory); changed.overview = '동시 변경';
    assert.throws(() => mergeMemoryDelta('{"v":2,"t":1}', prepared, changed, sources), /Stale/);
});
test('writer uses only logical source numbers while retaining mixed-segment text and provenance', () => {
    const rows = [{ chat_metadata: {} }, { is_user: true, mes: '먼저 기록관에 둬.', extra: { rp_memory: { role: 'director', intent: 'scene' } } },
        { is_user: false, mes: '' }, { is_user: true, mes: '나는 사본만 챙긴다.', extra: { rp_memory: { role: 'protagonist', protagonist_id: 'p1' } } },
        { is_user: false, mes: '원본은 기록관에 남았다.' }];
    const session = nativeSession(rows), before = structuredClone(session), memory = emptyCategorizedMemory(scope);
    const prepared = buildDeltaRequest({}, { fixedContext: '', memory, messages: session.messages, wireFormat: 'compact-v2' });
    const input = JSON.parse(prepared.request.messages[2].content), user = input.new_completed_prefix[0];
    assert.equal(user.source, 0); assert.match(user.content, /먼저 기록관에 둬/); assert.match(user.content, /나는 사본만 챙긴다/);
    assert.deepEqual(user.source_context.segments.map(s => s.source_context.role), ['director', 'protagonist']);
    assert.equal(user.source_context.segments[1].source_context.protagonist, 'p1');
    assert.doesNotMatch(JSON.stringify(input), /source_row|source_rows|원문 메시지 r/);
    assert.equal(user.source_context.segments[0].source_context.intent, 'scene');
    assert.deepEqual(session, before);
});
test('compact diagnostics identify the failed source contract without exposing memory text', () => {
    const memory = emptyCategorizedMemory(scope), prepared = prepare(memory);
    for (const [refs, reason] of [[[0, 0], 'sources-duplicate'], [['t1u'], 'source-not-integer'], [[2], 'source-out-of-range'], [[], 'sources-empty']]) {
        assert.throws(() => mergeMemoryDelta(JSON.stringify({ v: 2, t: 1, e: [['e', 'private-memory-text', refs]] }), prepared, memory, sources), error => {
            assert.match(error.message, new RegExp(reason));
            assert.match(error.message, /e\[0\]/);
            assert.doesNotMatch(error.message, /private-memory-text/);
            return true;
        });
    }
});
for (const valid of [true, false]) test(`compact runner ${valid ? 'valid checkpoint keeps disjoint suffix' : 'invalid source preserves raw and checkpoint'}`, async () => {
    const rows = [{ chat_metadata: {} }, ...Array.from({ length: 7 }, (_, i) => ({ is_user: i % 2 === 0, mes: String(i) + '가'.repeat(800) }))];
    let calls = 0;
    const result = await runContextMemoryTurn({ request: { model: 'qwen', messages: [{ role: 'user', content: rows.at(-1).mes }] }, session: nativeSession(rows), scope, fixedContext: '세계', rawBudget: 4096, consolidationTokenBudget: 2000, memoryWireFormat: 'compact-v2',
        countMessages: async rows => rows.reduce((n, r) => n + r.content.length, 0), readSession: () => nativeSession(rows), update: () => {},
        saveDialogue: async reply => rows.push({ mes: reply.text, is_user: false }),
        generate: async (_, _signal, _update, prepared) => {
            calls++;
            if (!prepared) return { text: '반응' + '가'.repeat(800) };
            const input = JSON.parse(prepared.messages.find(x => x.role === 'user').content);
            assert.equal(input.new_completed_prefix[0].source, 0);
            return { text: JSON.stringify({ v: 2, t: input.through_turn, e: [['e1', '사건', valid ? [0, 1] : ['t1u']]] }) };
        },
    });
    assert.equal(calls, 2); assert.equal(rows.length, 9);
    if (valid) {
        assert.equal(result.sessionSummary.status, 'complete');
        const memory = result.sessionSummary.summary;
        const session = nativeSession([...rows, { mes: '다음 질문', is_user: true }]);
        const assembled = assembleContextMessages([], session, { summary: memory }, scope, '세계');
        assert.equal(assembled.messages.at(-1).content.endsWith('다음 질문'), true);
        assert.equal(assembled.messages.filter(x => x.role !== 'system').length, session.messages.filter(x => x.turn > memory.through_turn).length);
    } else {
        assert.equal(result.sessionSummary.status, 'failed'); assert.equal(result.sessionSummary.errorCode, 'COMPACT_SOURCE_NOT_INTEGER'); assert.equal(result.sessionSummary.keepRaw, true); assert.equal(result.sessionSummary.summary, undefined);
    }
});
