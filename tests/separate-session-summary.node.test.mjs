import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFreeDialogueRequest, buildSeparateSummaryRequest, parseSeparateSummary } from '../src/endpoints/backends/separate-session-summary.js';

const memory = { version: 1, scene: '기록실', facts: ['허가는 조건부다'], open_threads: ['접수 확인'], knowledge: ['담당자는 신청서를 읽었다'] };
const options = { fixedContext: '고정 설정', previousSummary: memory, coveredTurns: 2,
    messages: [{ turn: 3, role: 'user', content: '접수된 건가요?' }, { turn: 3, role: 'assistant', content: '아직 확인하지 못했다.' }] };

test('provider-only dialogue guard preserves source history and settings and is opt-in and idempotent', () => {
    const base = { model: 'local', temperature: 0, seed: 17, max_tokens: 8192, messages: [
        { role: 'system', content: '고정 설정' },
        { role: 'user', content: '예전 질문' },
        { role: 'assistant', content: '예전 응답' },
        { role: 'user', content: '계획을 세웠지만 아직 실행하지 않았다.' },
        { role: 'assistant', content: '</think>\n\n' },
    ] };
    const original = structuredClone(base);
    assert.deepEqual(buildFreeDialogueRequest(base), original);
    const request = buildFreeDialogueRequest(base, { enabled: true });
    assert.deepEqual(base, original);
    assert.deepEqual(request.messages.slice(0, 3), original.messages.slice(0, 3));
    assert.ok(request.messages[3].content.startsWith(original.messages[3].content + '\n\n'));
    assert.deepEqual(request.messages[4], original.messages[4]);
    const restored = structuredClone(request);
    restored.messages[3].content = original.messages[3].content;
    assert.deepEqual(restored, original);
    assert.deepEqual(buildFreeDialogueRequest(request, { enabled: true }), request);
    assert.throws(() => buildFreeDialogueRequest({ messages: [] }, { enabled: true }), /current user/);
});

test('context system policy is authoritative, idempotent, and not appended to source dialogue', () => {
    const base = { messages: [{ role: 'system', content: '세계관' }, { role: 'user', content: '현재 입력' }] };
    const request = buildFreeDialogueRequest(base, { enabled: true, systemPolicy: true });
    assert.equal(request.messages.at(-1).content, '현재 입력');
    assert.equal(request.messages[1].role, 'system');
    assert.match(request.messages[1].content, /고정 규칙은 명시적인 설정 변경/);
    assert.deepEqual(buildFreeDialogueRequest(request, { enabled: true, systemPolicy: true }), request);
    assert.equal(base.messages.length, 2);
});

test('replaces RP instructions without altering source messages, settings, or checkpoint', () => {
    const base = { model: 'local', temperature: 0, seed: 17, messages: [{ role: 'system', content: 'RP 창작 지시' }], response_format: { type: 'json_schema' }, max_tokens: 20 };
    const original = structuredClone({ base, options });
    const request = buildSeparateSummaryRequest(base, options);
    assert.deepEqual({ base, options }, original);
    assert.equal(request.response_format, undefined);
    assert.equal(request.seed, 17);
    assert.equal(request.temperature, 0);
    assert.equal(request.max_tokens, 8192);
    assert.equal(request.messages.some(row => row.content.includes('RP 창작 지시')), false);
    const data = JSON.parse(request.messages[2].content);
    assert.deepEqual(data.previous_checkpoint.memory, memory);
    assert.deepEqual(data.subsequent_stored_dialogue, options.messages.map(row => ({ turn: row.turn, source: row.role, text: row.content })));
    assert.equal(request.messages.at(-1).content, '</think>\n\n');
});

test('rejects overlapping coverage, incomplete suffix, and reversed chronology', () => {
    assert.throws(() => buildSeparateSummaryRequest({}, { ...options, coveredTurns: 3 }), /Invalid unprocessed/);
    assert.throws(() => buildSeparateSummaryRequest({}, { ...options, messages: options.messages.slice(0, 1) }), /completed dialogue/);
    assert.throws(() => buildSeparateSummaryRequest({}, { ...options, messages: [{ ...options.messages[0], turn: 4 }, options.messages[1]] }), /chronological/);
});

test('accepts only a complete JSON object or one outer fence and rejects ambiguous output', () => {
    assert.deepEqual(parseSeparateSummary(JSON.stringify(memory)), memory);
    assert.deepEqual(parseSeparateSummary('```json\n' + JSON.stringify(memory) + '\n```'), memory);
    assert.throws(() => parseSeparateSummary('설명\n' + JSON.stringify(memory)));
    assert.throws(() => parseSeparateSummary('{"version":1,"version":1,"scene":"x","facts":[],"open_threads":[],"knowledge":[]}'), /Duplicate/);
    assert.throws(() => parseSeparateSummary(JSON.stringify({ ...memory, facts: Array(13).fill('x') })), /facts/);
    assert.throws(() => parseSeparateSummary(JSON.stringify({ ...memory, extra: 'x' })), /keys/);
});
