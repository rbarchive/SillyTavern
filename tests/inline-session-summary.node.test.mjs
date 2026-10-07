import assert from 'node:assert/strict';
import test from 'node:test';
import {
    SESSION_RESPONSE_SCHEMA, SUMMARY_CLOSE, SUMMARY_OPEN, buildInlineSummaryInstruction, buildSessionSummaryContext,
    buildStructuredSummaryInstruction, splitInlineSummary, splitStructuredSessionResponse,
} from '../src/endpoints/backends/inline-session-summary.js';

const summary = { version: 1, scene: '비가 오는 역', facts: ['문이 잠겼다'], open_threads: ['열쇠는 어디에 있나'], knowledge: ['민수는 열쇠가 있다는 소문을 들었다'] };
const encoded = JSON.stringify(summary);
const complete = `대화${SUMMARY_OPEN}${encoded}${SUMMARY_CLOSE}`;

test('holds every partial opening marker without leaking it', () => {
    for (let i = 1; i < SUMMARY_OPEN.length; i++) {
        const result = splitInlineSummary(`대화${SUMMARY_OPEN.slice(0, i)}`);
        assert.equal(result.text, '대화');
        assert.equal(result.started, true);
        assert.equal(result.status, 'pending');
        assert.equal(result.summary, null);
    }
});

test('hides an in-progress summary and emits it only after complete valid JSON', () => {
    const pending = splitInlineSummary(`대화${SUMMARY_OPEN}${encoded.slice(0, 8)}`);
    assert.deepEqual(pending, { text: '대화', started: true, summary: null, status: 'pending' });
    const result = splitInlineSummary(complete);
    assert.equal(result.status, 'complete');
    assert.deepEqual(result.summary, summary);
    assert.equal(result.text, '대화');
});

test('preserves unicode dialogue and trims only before the delimiter', () => {
    const result = splitInlineSummary(`안녕 🌙  ${SUMMARY_OPEN}${encoded}${SUMMARY_CLOSE}`);
    assert.equal(result.text, '안녕 🌙');
});

test('leaves ordinary content untouched when there is no marker', () => {
    assert.deepEqual(splitInlineSummary('그냥 대화입니다.'), { text: '그냥 대화입니다.', started: false, summary: null, status: 'missing' });
});

test('rejects malformed, truncated, unknown-key, extra-content, and invalid summaries', () => {
    const malformed = splitInlineSummary(`대화${SUMMARY_OPEN}{oops${SUMMARY_CLOSE}`);
    assert.equal(malformed.status, 'failed');
    assert.equal(splitInlineSummary(`대화${SUMMARY_OPEN}${encoded}`, { final: true }).status, 'failed');
    assert.equal(splitInlineSummary(`대화${SUMMARY_OPEN}${JSON.stringify({ ...summary, nope: 1 })}${SUMMARY_CLOSE}`).status, 'failed');
    assert.equal(splitInlineSummary(`${complete}뒤에 글`).status, 'failed');
    assert.equal(splitInlineSummary(`대화${SUMMARY_OPEN}${JSON.stringify({ ...summary, scene: '' })}${SUMMARY_CLOSE}`).status, 'failed');
    assert.equal(splitInlineSummary(`대화${SUMMARY_OPEN}${JSON.stringify({ ...summary, facts: Array(13).fill('x') })}${SUMMARY_CLOSE}`).status, 'failed');
});

test('does not leak a malformed opening marker at finalization', () => {
    const result = splitInlineSummary(`대화${SUMMARY_OPEN.slice(0, -1)}`, { final: true });
    assert.equal(result.text, '대화');
    assert.equal(result.status, 'failed');
});

test('builds concise instruction and deterministic Korean context', () => {
    const instruction = buildInlineSummaryInstruction();
    assert.match(instruction, /<rp-session-summary>/);
    assert.match(instruction, /open_threads/);
    const context = buildSessionSummaryContext(summary);
    assert.match(context, /현재 상태·지속 사실·최근 사건: 문이 잠겼다/);
    assert.match(context, /계획·요청·미해결 사항 .*열쇠는 어디에 있나/);
    assert.match(context, /인물별 지식.*민수는 열쇠가 있다는 소문을 들었다/);
});

const structured = JSON.stringify({ dialogue: '안녕, "친구"!\n다음 장면으로 가자. 🌙', summary });

test('strict structured schema has only dialogue and summary', () => {
    assert.deepEqual(SESSION_RESPONSE_SCHEMA.required, ['dialogue', 'summary']);
    assert.equal(SESSION_RESPONSE_SCHEMA.additionalProperties, false);
    assert.equal(SESSION_RESPONSE_SCHEMA.properties.dialogue.maxLength, 12000);
    assert.equal(SESSION_RESPONSE_SCHEMA.properties.summary.additionalProperties, false);
});

test('structured scanner exposes escaped dialogue on every chunk split without leaking JSON', () => {
    let sawPartial = false;
    for (let i = 1; i < structured.length; i++) {
        const result = splitStructuredSessionResponse(structured.slice(0, i));
        assert.equal(result.text.includes('summary'), false);
        assert.equal(result.text.includes('{'), false);
        assert.equal(result.summary, null);
        assert.equal(result.status, 'pending');
        if (result.text.length > 0 && result.text.length < JSON.parse(structured).dialogue.length) sawPartial = true;
    }
    assert.equal(sawPartial, true);
    const result = splitStructuredSessionResponse(structured, { final: true });
    assert.equal(result.status, 'complete');
    assert.equal(result.dialogueComplete, true);
    assert.equal(result.text, '안녕, "친구"!\n다음 장면으로 가자. 🌙');
    assert.deepEqual(result.summary, summary);
});

test('structured scanner keeps complete dialogue while summary remains pending', () => {
    const dialogueEnd = structured.indexOf('"summary"');
    const result = splitStructuredSessionResponse(structured.slice(0, dialogueEnd));
    assert.equal(result.dialogueComplete, true);
    assert.equal(result.text, '안녕, "친구"!\n다음 장면으로 가자. 🌙');
    assert.equal(result.status, 'pending');
});

test('structured finalization recovers dialogue for malformed tail and rejects keys or truncation', () => {
    const malformed = splitStructuredSessionResponse('{"dialogue":"보존할 답변","summary":', { final: true });
    assert.equal(malformed.text, '보존할 답변');
    assert.equal(malformed.dialogueComplete, true);
    assert.equal(malformed.status, 'failed');
    assert.equal(splitStructuredSessionResponse(JSON.stringify({ dialogue: '답변', summary, extra: 1 }), { final: true }).status, 'failed');
    assert.equal(splitStructuredSessionResponse('{"dialogue":"답변","dialogue":"답변","summary":' + JSON.stringify(summary), { final: true }).status, 'failed');
    assert.equal(splitStructuredSessionResponse('{"dialogue":"답변","summary":' + JSON.stringify(summary) + ',"summary":' + JSON.stringify(summary) + '}', { final: true }).status, 'failed');
    assert.equal(splitStructuredSessionResponse('{"summary":' + JSON.stringify(summary) + ',"dialogue":"답변"}', { final: true }).text, '답변');
});

test('structured instruction requests grounded Korean dialogue before cumulative summary', () => {
    const instruction = buildStructuredSummaryInstruction();
    assert.match(instruction, /dialogue/);
    assert.match(instruction, /summary/);
    assert.match(instruction, /800자/);
    assert.match(instruction, /마지막 user/);
    assert.match(instruction, /모르는 인물/);
});


test('empty checkpoint records are uncertainty rather than factual negatives', () => {
    const context = buildSessionSummaryContext({ version: 1, scene: '창고', facts: [], open_threads: [], knowledge: [] });
    assert.match(context, /기록 없음 \(사실 부정 아님\)/);
    assert.match(context, /기록 없음 \(과제 부재 확정 아님\)/);
    assert.match(context, /기록 없음 \(지식 부재 확정 아님\)/);
});


test('rejects a whole summary escaped into scene and punctuation-only placeholders', () => {
    const escaped = { ...summary, scene: JSON.stringify({ facts: ['표식=윤'], recent_events: ['인계'] }) };
    const placeholder = { ...summary, facts: [', '] };
    for (const malformed of [escaped, placeholder]) {
        const response = JSON.stringify({ dialogue: '응답', summary: malformed });
        assert.equal(splitStructuredSessionResponse(response, { final: true }).status, 'failed');
        assert.equal(splitStructuredSessionResponse(response, { final: true }).text, '응답');
    }
});
