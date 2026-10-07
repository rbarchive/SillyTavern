import test from 'node:test';
import assert from 'node:assert/strict';
import { readGenerationResponse } from '../src/endpoints/backends/generation-stream.js';

const frame = delta => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;
function response(chunks, clock) {
    return { headers: { get: () => 'text/event-stream' }, body: (async function* () {
        for (const [at, text] of chunks) { clock.at = at; yield Buffer.from(text); }
    })() };
}

test('role delta is legacy firstToken, not content TTFT; reasoning and visible receipt are separate', async () => {
    const clock = { at: 120 }; const events = [];
    const data = await readGenerationResponse(response([
        [130, frame({ role: 'assistant' })],
        [140, frame({ reasoning_content: 'hidden' })],
        [150, frame({ content: '<think>hidden</think>' })],
        [160, frame({ content: '안녕하세요.' })],
        [170, 'data: [DONE]\n\n'],
    ], clock), value => events.push(value), { requestedAt: 100, now: () => clock.at });
    assert.equal(events.find(event => event.event === 'firstToken').preview, '');
    assert.deepEqual(data.streamMetrics, { requestedAt: 100, responseReceivedAt: 120, firstReasoningAt: 140, firstContentAt: 150, serverFirstVisibleAt: 160, completedAt: 170 });
    assert.equal(data.choices[0].message.content, '<think>hidden</think>안녕하세요.');
});

test('persistence callback delay does not inflate first content or server-visible receipt', async () => {
    const clock = { at: 10 };
    const data = await readGenerationResponse(response([[20, frame({ content: '본문' })], [40, 'data: [DONE]\n\n']], clock), () => {}, {
        requestedAt: 0, now: () => clock.at, onContent: async () => { clock.at += 1000; },
    });
    assert.equal(data.streamMetrics.firstContentAt, 20);
    assert.equal(data.streamMetrics.serverFirstVisibleAt, 20);
});

test('coalesced role and content frames share chunk receipt time despite callback delay', async () => {
    const clock = { at: 10 };
    const data = await readGenerationResponse(response([[20, frame({ role: 'assistant' }) + frame({ content: '본문' }) + 'data: [DONE]\n\n']], clock), () => {}, {
        now: () => clock.at, onContent: async () => { clock.at += 1000; },
    });
    assert.equal(data.streamMetrics.firstContentAt, 20);
    assert.equal(data.streamMetrics.serverFirstVisibleAt, 20);
});

test('missing content is unavailable, not zero; non-SSE reply contract is preserved', async () => {
    const clock = { at: 10 };
    const data = await readGenerationResponse(response([[20, frame({ role: 'assistant' })], [30, 'data: [DONE]\n\n']], clock), () => {}, { now: () => clock.at });
    assert.equal(Object.hasOwn(data.streamMetrics, 'firstContentAt'), false);
    const json = { choices: [] };
    assert.equal(await readGenerationResponse({ headers: { get: () => 'application/json' }, json: async () => json }), json);
});

test('custom visibility excludes internal output while raw content timing stays measurable', async () => {
    const clock = { at: 10 };
    const data = await readGenerationResponse(response([[20, frame({ content: 'internal' })], [30, frame({ content: '|대사' })], [40, 'data: [DONE]\n\n']], clock), () => {}, {
        now: () => clock.at, visibleText: content => content.split('|')[1] || '',
    });
    assert.equal(data.streamMetrics.firstContentAt, 20);
    assert.equal(data.streamMetrics.serverFirstVisibleAt, 30);
});

test('unfinished streams expose partial receipt metrics without reporting completion', async () => {
    const clock = { at: 10 }; const events = [];
    await assert.rejects(readGenerationResponse(response([[20, frame({ content: 'partial' })]], clock), value => events.push(value), { requestedAt: 0, now: () => clock.at }), /before completion/);
    const metrics = Object.assign({}, ...events.map(event => event.streamMetrics));
    assert.equal(metrics.requestedAt, 0);
    assert.equal(metrics.firstContentAt, 20);
    assert.equal(metrics.serverFirstVisibleAt, 20);
    assert.equal(Object.hasOwn(metrics, 'completedAt'), false);
});
