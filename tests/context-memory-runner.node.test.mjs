import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runContextMemoryTurn } from '../src/endpoints/backends/context-memory-runner.js';
import { nativeSession, sourcesFor, assembleContextMessages, buildDeltaRequest, mergeMemoryDelta, renderContextRow, compactConsolidationCore } from '../src/endpoints/backends/context-memory.js';
import { emptyCategorizedMemory } from '../src/endpoints/backends/categorized-session-memory.js';
const scope = { world: 'world', story: 'story', branch: 'branch' };
const fixedContext = '고정 세계';
test('writer core retains canonical facts and priority while removing only an exact global lore duplicate', () => {
    const world = '첫 문단\n장부 원본은 사무실. 사본만 현장 반출.';
    const footer = 'Story-specific lore and character profiles in the later session context override matching World entries.';
    const core = `## Canon\n- 세계: ${world}\n\n## Relevant World Lore\n- [rules/global] 세계: ${world}\n\n${footer}`;
    const compact = compactConsolidationCore(core);
    assert.equal(compact.split(world).length - 1, 1);
    assert.ok(compact.includes(footer));
    assert.ok(compact.includes('## Canon'));
    for (const distinct of [core.replace('rules/global', 'rules/story'), core.replace('현장 반출.\n\nStory', '현장 반출 금지.\n\nStory')]) assert.equal(compactConsolidationCore(distinct), distinct);
    const paragraphs = core.replaceAll('첫 문단\n', '첫 문단\n\n');
    assert.equal(compactConsolidationCore(paragraphs).split('장부 원본').length - 1, 1);
    const unknownFooter = core.replace(footer, '출처가 다른 설명');
    assert.equal(compactConsolidationCore(unknownFooter), unknownFooter);
    const repeatedSection = core + '\n\n## Canon\n- 세계: ' + world;
    assert.equal(compactConsolidationCore(repeatedSection), repeatedSection);
});
const rows = () => [{ chat_metadata: { integrity: 'test' } }, { mes: '시작 장면', is_user: false }, ...Array.from({ length: 15 }, (_, i) => ({ mes: `${i} ` + '가'.repeat(800), is_user: i % 2 === 0 }))];
const delta = through => ({ version: 1, through_turn: through, overview: '진행된 이야기', current_state: { upsert: [], remove: [] }, events: { upsert: [{ id: 'e1', text: '동행하기로 약속했다', sources: ['t1u', 't1a'] }], remove: [] }, knowledge: { upsert: [], remove: [] } });
test('writer opening brace is restored only for its prepared contract; malformed tails stay failures', () => {
    const previous = emptyCategorizedMemory(scope), messages = nativeSession(rows()).messages.slice(0, 2);
    const base = { messages: [{ role: 'system', content: '배우 입력' }, { role: 'user', content: '배우 질문' }] }, before = structuredClone(base);
    const prepared = buildDeltaRequest(base, { fixedContext, memory: previous, messages });
    assert.equal(prepared.request.messages.at(-1).content, '</think>\n\n{');
    assert.equal(prepared.request.response_format, undefined);
    assert.deepEqual(base, before);
    const text = JSON.stringify(delta(1)), sources = sourcesFor(messages, 1);
    assert.deepEqual(mergeMemoryDelta(text.slice(1), prepared, previous, sources), mergeMemoryDelta(text, prepared, previous, sources));
    for (const invalid of ['Analysis: 먼저 분석한다', text.slice(1, -1), text.slice(1).replace('"version":1,', '"version":1,"version":1,')]) assert.throws(() => mergeMemoryDelta(invalid, prepared, previous, sources));
    assert.throws(() => mergeMemoryDelta(text.slice(1), { ...prepared, responsePrefix: undefined }, previous, sources));
});
async function run({ failWriter = false, edit = false, append = false, truncate = false } = {}) {
    const stored = rows(); let calls = 0; let committed = false; const events = [];
    const request = { model: 'qwen', messages: [{ role: 'system', content: '원래 prefix' }, { role: 'user', content: stored.at(-1).mes }] };
    const result = await runContextMemoryTurn({ request, session: nativeSession(stored), scope, fixedContext, rawBudget: 4096,
        countMessages: async messages => messages.reduce((sum, row) => sum + row.content.length, 0),
        readSession: () => nativeSession(stored), signal: new AbortController().signal, update: value => events.push(value),
        saveDialogue: async value => { stored.push({ mes: value.text, is_user: false }); committed = true; },
        generate: async (input, signal, update, prepared) => {
            calls++;
            if (!prepared) { assert.equal(committed, false); return { text: '완료 대사 ' + '가'.repeat(800), model: 'qwen' }; }
            assert.equal(committed, true); assert.equal(Object.hasOwn(prepared, 'response_format'), false);
            assert.equal(Object.hasOwn(prepared, 'custom_include_body'), false); assert.equal(prepared.max_tokens, 8192);
            if (failWriter) throw new Error('writer failed');
            if (edit) stored[2].mes = 'edited';
            if (append) stored.push({ mes: '다음 질문', is_user: true });
            const target = JSON.parse(prepared.messages.find(row => row.role === 'user').content).through_turn;
            update({ preview: '{internal JSON}', streamMetrics: { requestedAt: 10, firstContentAt: 20 }, modelStats: { inputTokens: 100, finishReason: truncate ? 'length' : 'stop' } });
            return { text: JSON.stringify(delta(target)) };
        },
    });
    return { result, stored, events, calls };
}
test('one actor then one writer after durable dialogue; internal JSON and writer metrics stay separate', async () => {
    const { result, stored, events, calls } = await run();
    assert.equal(calls, 2); assert.equal(result.sessionSummary.status, 'complete');
    assert.ok(events.every(row => row.preview === undefined && row.streamMetrics === undefined && row.modelStats === undefined));
    const memory = result.sessionSummary.summary;
    const assembled = assembleContextMessages([{ role: 'system', content: 'exact stable prefix' }], nativeSession([...stored, { mes: '후속 질문', is_user: true }]), { summary: memory }, scope, fixedContext);
    assert.equal(assembled.messages[0].content, 'exact stable prefix');
    const opening = assembled.messages.filter(row => row.role !== 'system').slice(0, 2);
    assert.equal(opening[1].content, '시작 장면');
    const dialogue = assembled.messages.filter(row => row.role !== 'system').slice(2);
    assert.equal(dialogue[0].content.split('[원문]\n')[1], stored[2 + memory.through_turn * 2].mes);
    assert.equal(dialogue.at(-1).content.split('[원문]\n')[1], '후속 질문');
    assert.equal(dialogue.length, (8 - memory.through_turn) * 2 + 1);
});
test('memory stays in system prefix and per-message provenance survives covered-turn removal', () => {
    const raw = [{ chat_metadata: {} }, { mes: '시작', is_user: false },
        { mes: '인물의 주장', is_user: true, extra: { rp_memory: { role: 'protagonist', protagonist_id: 'a' } } },
        { mes: '반응', is_user: false },
        { mes: '장면 전제', is_user: true, extra: { rp_memory: { role: 'director', intent: 'scene' } } }];
    const original = structuredClone(raw); const session = nativeSession(raw);
    const assembled = assembleContextMessages([{ role: 'system', content: fixedContext }], session, null, scope, fixedContext);
    assert.match(assembled.messages[1].content, /대화 기억/);
    assert.equal(assembled.messages[1].role, 'system');
    assert.match(assembled.messages.at(-1).content, /"mode":"director"/);
    assert.match(assembled.messages.find(row => row.content.includes('인물의 주장')).content, /"protagonist":"a"/);
    assert.deepEqual(raw, original); assert.equal(sourcesFor(session.messages, 1).t1u.text, '인물의 주장');
    assert.equal(assembled.messages.find(row => row.role === 'assistant' && row.content === '반응').content, '반응');
    assert.equal(renderContextRow(session.messages.at(-1)).content.endsWith('장면 전제'), true);
});
for (const [name, options] of [['writer failure', { failWriter: true }], ['prefix edit', { edit: true }], ['truncated output', { truncate: true }]]) {
    test(`${name} retains all pending native source and committed dialogue`, async () => {
        const { result, stored } = await run(options);
        assert.equal(result.sessionSummary.status, 'failed'); assert.equal(result.sessionSummary.keepRaw, true);
        assert.equal(stored.length, 18); assert.match(stored.at(-1).mes, /완료 대사/);
        assert.equal(nativeSession(stored).messages.length, 16);
    });
}
test('unrelated tail append does not invalidate consolidated prefix', async () => {
    assert.equal((await run({ append: true })).result.sessionSummary.status, 'complete');
});
test('small raw buffer uses only actor and no unnecessary writer', async () => {
    let calls = 0; const stored = [{ chat_metadata: {} }, { mes: '안녕', is_user: true }];
    const result = await runContextMemoryTurn({ request: { messages: [{ role: 'user', content: '안녕' }] }, session: nativeSession(stored), scope, fixedContext, rawBudget: 4096,
        countMessages: async rows => rows.length * 10, generate: async () => { calls++; return { text: '반가워' }; },
        saveDialogue: async reply => stored.push({ mes: reply.text, is_user: false }), readSession: () => nativeSession(stored), update: () => {} });
    assert.equal(calls, 1); assert.equal(result.sessionSummary.status, 'skipped');
});
test('delta merge retains untouched episodes and rejects forged provenance or ambiguous keys', () => {
    const memory = emptyCategorizedMemory(scope), session = nativeSession([...rows(), { mes: '대답', is_user: false }]);
    const prepared = buildDeltaRequest({}, { fixedContext, memory, messages: session.messages.slice(0, 2) });
    const sources = sourcesFor(session.messages, 1);
    const first = mergeMemoryDelta(JSON.stringify(delta(1)), prepared, memory, sources);
    const nextPrepared = buildDeltaRequest({}, { fixedContext, memory: first, messages: session.messages.slice(2, 4) });
    const next = delta(2); next.events.upsert = [];
    const merged = mergeMemoryDelta(JSON.stringify(next), nextPrepared, first, sourcesFor(session.messages, 2));
    assert.deepEqual(merged.events, first.events);
    next.events.upsert = [{ id: 'e2', text: '없던 사건', sources: ['t8a'] }];
    assert.throws(() => mergeMemoryDelta(JSON.stringify(next), nextPrepared, first, sourcesFor(session.messages, 2)), /source/);
    assert.throws(() => mergeMemoryDelta('{"version":1,"version":1}', prepared, memory, sources), /Duplicate/);
});

test('elapsed 30 seconds does not cancel background writer; explicit cancellation still preserves raw', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const stored = rows(), cancellation = new AbortController();
    let writerSignal, release;
    let readyResolve; const ready = new Promise(resolve => { readyResolve = resolve; });
    const pending = runContextMemoryTurn({
        request: { model: 'qwen', messages: [{ role: 'system', content: fixedContext }, { role: 'user', content: stored.at(-1).mes }] },
        session: nativeSession(stored), scope, fixedContext, rawBudget: 4096,
        countMessages: async messages => messages.reduce((sum, row) => sum + row.content.length, 0),
        readSession: () => nativeSession(stored), signal: cancellation.signal, update: () => {},
        saveDialogue: async reply => { stored.push({ mes: reply.text, is_user: false }); },
        generate: async (input, signal, update, prepared) => {
            if (!prepared) return { text: '완료 대사 ' + '가'.repeat(800) };
            writerSignal = signal; readyResolve();
            await new Promise(resolve => { release = resolve; });
            signal.throwIfAborted();
            return { text: JSON.stringify(delta(1)) };
        },
    });
    await ready;
    t.mock.timers.tick(31000);
    assert.equal(writerSignal.aborted, false);
    cancellation.abort();
    assert.equal(writerSignal.aborted, true);
    release();
    const result = await pending;
    assert.equal(result.sessionSummary.status, 'failed');
    assert.equal(result.sessionSummary.keepRaw, true);
});
