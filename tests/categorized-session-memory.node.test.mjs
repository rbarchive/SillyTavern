import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyCategorizedMemory, buildCategorizedMemoryRequest, acceptCategorizedMemory, buildCategorizedDialogueMessages } from '../src/endpoints/backends/categorized-session-memory.js';

const scope = { world: 'test-world', story: 'test-story', branch: 'main' };
const base = { model: 'test', response_format: { type: 'json_schema' }, max_tokens: 100, stop: ['stop'], temperature: 0, seed: 17 };
const rows = [{ turn: 1, role: 'user', content: '지수가 기록실에서 붉은 수첩을 맡겼다.' }, { turn: 1, role: 'assistant', content: '민호가 수첩을 받아 책상에 놓았다.' }];
const prepare = (previous = emptyCategorizedMemory(scope), sources = {}, messages = rows) => buildCategorizedMemoryRequest(base, { fixedContext: '기본 설정', previous, sources, messages });
const result = () => ({ ...emptyCategorizedMemory(scope), through_turn: 1, current_state: [{ id: 's1', text: '수첩은 기록실 책상에 있다.', sources: ['t1u', 't1a'] }], events: [{ id: 'e1', text: '지수가 맡긴 수첩을 민호가 받아 책상에 놓았다.', sources: ['t1u', 't1a'] }] });

test('separate request does not mutate native sources or sampling, and removes forced schema', () => {
    const original = structuredClone({ base, rows });
    const prepared = prepare();
    assert.deepEqual({ base, rows }, original);
    assert.equal(prepared.request.response_format, undefined);
    assert.equal(prepared.request.stop, undefined);
    assert.equal(prepared.request.max_tokens, 8192);
    assert.equal(prepared.request.seed, base.seed);
    assert.equal(prepared.request.temperature, base.temperature);
    const payload = JSON.parse(prepared.request.messages[2].content);
    assert.deepEqual(payload.subsequent_stored_dialogue.map(row => row.text), rows.map(row => row.content));
});

test('accept and feed actual memory; processed native text does not reappear in recent window', () => {
    const prepared = prepare(), memory = acceptCategorizedMemory(JSON.stringify(result()), prepared, emptyCategorizedMemory(scope), prepared.sources);
    const tail = [{ turn: 2, role: 'user', content: '창문을 열어볼까?' }];
    const messages = buildCategorizedDialogueMessages({ fixedContext: '기본 설정', memory, sources: prepared.sources, messages: tail });
    assert.deepEqual(messages.filter(row => row.role !== 'system'), [{ role: 'user', content: tail[0].content }]);
    assert.equal(messages.some(row => row.content === rows[0].content), false);
    assert.match(messages[1].content, /과거 사건/);
});

test('later checkpoint can retain original event references while replacing current state', () => {
    const first = prepare(), memory = acceptCategorizedMemory(JSON.stringify(result()), first, emptyCategorizedMemory(scope), first.sources);
    const second = prepare(memory, first.sources, [{ turn: 2, role: 'user', content: '지수가 수첩을 회수했다.' }, { turn: 2, role: 'assistant', content: '민호는 빈 책상을 정리했다.' }]);
    const updated = { ...memory, through_turn: 2, current_state: [{ id: 's1', text: '수첩은 지수에게 있다.', sources: ['t2u'] }] };
    assert.deepEqual(acceptCategorizedMemory(JSON.stringify(updated), second, memory, second.sources).events, memory.events);
});

for (const [label, edit] of [
    ['unknown source', memory => memory.events[0].sources = ['missing']],
    ['future source', memory => memory.events[0].sources = ['t2u']],
    ['wrong scope', memory => memory.scope.branch = 'other'],
    ['wrong coverage', memory => memory.through_turn = 2],
    ['duplicate IDs', memory => memory.events.push(structuredClone(memory.events[0]))],
    ['invalid belief status', memory => memory.knowledge.push({ id: 'k1', holder: '지수', basis: 'definitely_true', text: '추측', sources: ['t1u'] })],
]) test(`${label}: rejection does not advance checkpoint`, () => {
    const previous = emptyCategorizedMemory(scope), before = structuredClone(previous), prepared = prepare(previous), value = result();
    edit(value);
    assert.throws(() => acceptCategorizedMemory(JSON.stringify(value), prepared, previous, prepared.sources));
    assert.deepEqual(previous, before);
    assert.deepEqual(rows, [{ turn: 1, role: 'user', content: '지수가 기록실에서 붉은 수첩을 맡겼다.' }, { turn: 1, role: 'assistant', content: '민호가 수첩을 받아 책상에 놓았다.' }]);
});

test('stale worker output cannot replace a newer checkpoint', () => {
    const prepared = prepare();
    assert.throws(() => acceptCategorizedMemory(JSON.stringify(result()), prepared, { ...emptyCategorizedMemory(scope), overview: '수정됨' }), /Stale/);
});

test('edited native dialogue invalidates an in-flight memory result', () => {
    const prepared = prepare(), changed = structuredClone(prepared.sources);
    changed.t1u.text = '지수는 수첩을 맡기지 않았다.';
    assert.throws(() => acceptCategorizedMemory(JSON.stringify(result()), prepared, emptyCategorizedMemory(scope), changed), /sources changed/);
    assert.throws(() => acceptCategorizedMemory(JSON.stringify(result()), prepared, emptyCategorizedMemory(scope)), /sources changed/);
});

test('overlap, gaps and incomplete turn boundaries are rejected', () => {
    assert.throws(() => prepare(emptyCategorizedMemory(scope), {}, rows.slice(0, 1)));
    assert.throws(() => prepare(emptyCategorizedMemory(scope), {}, rows.map(row => ({ ...row, turn: 2 }))));
    const first = prepare(), memory = acceptCategorizedMemory(JSON.stringify(result()), first, emptyCategorizedMemory(scope), first.sources);
    assert.throws(() => prepare(memory, first.sources, rows));
    assert.throws(() => buildCategorizedDialogueMessages({ fixedContext: '고정', memory, sources: first.sources, messages: rows }));
});

test('legacy snapshots are not automatically reinterpreted as categorized memory', () => {
    assert.throws(() => prepare({ version: 1, scene: '옛 장면', facts: [], open_threads: [], knowledge: [] }));
});

test('unused archived sources cannot be revived without being supplied in the new suffix', () => {
    const first = prepare(), value = result();
    value.current_state[0].sources = ['t1a']; value.events[0].sources = ['t1a'];
    const memory = acceptCategorizedMemory(JSON.stringify(value), first, emptyCategorizedMemory(scope), first.sources);
    const second = prepare(memory, first.sources, [{ turn: 2, role: 'user', content: '다음 일을 하자.' }, { turn: 2, role: 'assistant', content: '민호는 고개를 끄덕였다.' }]);
    const invalid = { ...memory, through_turn: 2, events: [{ id: 'e1', text: '다시 불러온 옛 발언', sources: ['t1u'] }] };
    assert.throws(() => acceptCategorizedMemory(JSON.stringify(invalid), second, memory, second.sources), /not inherited/);
});

test('scope key order and one complete JSON fence do not change meaning', () => {
    const value = result(); value.scope = { branch: 'main', story: 'test-story', world: 'test-world' };
    assert.equal(acceptCategorizedMemory('```json\n' + JSON.stringify(value) + '\n```', prepare(), emptyCategorizedMemory(scope), prepare().sources).through_turn, 1);
    assert.throws(() => acceptCategorizedMemory('{"version":4,"version":4}', prepare(), emptyCategorizedMemory(scope), prepare().sources), /Duplicate/);
});
