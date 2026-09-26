import test from 'node:test';
import assert from 'node:assert/strict';
import { readGenerationResponse, visibleGenerationText, extractGenerationReply } from '../src/endpoints/backends/generation-stream.js';

test('split UTF8/SSE and think tags produce visible preview before completion', async () => {
    const previews = [];
    let finished = false;
    const data = parts => parts.map(content => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\r\n\r\n`).join('');
    const bytes = new TextEncoder().encode(data(['<thi', 'nk>secret</think>안녕하세요.']));
    const response = { headers: new Headers({ 'content-type': 'text/event-stream' }), body: (async function* () {
        for (let n = 0; n < bytes.length; n += 7) yield bytes.slice(n, n + 7);
        await new Promise(resolve => setTimeout(resolve, 210));
        yield new TextEncoder().encode(data([' 반갑습니다.']));
        finished = true;
        yield new TextEncoder().encode('data: [DONE]\n\n');
    })() };
    const result = await readGenerationResponse(response, p => previews.push({ ...p, finished }));
    assert.ok(previews.some(p => p.preview.includes('안녕하세요') && !p.finished));
    assert.ok(previews.every(p => !p.preview.includes('secret') && !p.preview.includes('<thi')));
    assert.match(result.choices[0].message.content, /반갑습니다/);
    assert.equal(visibleGenerationText('hello<think>unfinished'), 'hello');
});

test('JSON fallback and stream errors never turn into a partial success', async () => {
    const json = { choices: [{ message: { content: 'complete' } }] };
    assert.equal(await readGenerationResponse({ headers: new Headers(), json: async () => json }), json);
    const response = raw => ({ headers: new Headers({ 'content-type': 'text/event-stream' }), body: (async function* () { yield new TextEncoder().encode(raw); })() });
    await assert.rejects(readGenerationResponse(response('data: {"error":{"message":"provider failed"}}\n\n')), /provider failed/);
    await assert.rejects(readGenerationResponse(response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')), /before completion/);
});


test('unfinished reasoning is hidden from final persistence as well as previews', () => {
    const data = content => ({ choices: [{ message: { content } }] });
    assert.throws(() => extractGenerationReply(data('<think>secret'), 'mock'), /empty reply/);
    assert.deepEqual(extractGenerationReply(data('Visible<think>secret'), 'mock'), { text: 'Visible', reasoning: 'secret', model: 'mock' });
    assert.equal(extractGenerationReply(data('Visible<thi'), 'mock').text, 'Visible');
});


test('stream preserves completion termination and provider usage for bounded image requests', async () => {
    const response = { headers: new Headers({ 'content-type': 'text/event-stream' }), body: (async function* () {
        yield new TextEncoder().encode('data: {"choices":[{"delta":{"content":"unfinished"},"finish_reason":"length"}]}\n\n');
        yield new TextEncoder().encode('data: {"usage":{"prompt_tokens":200,"completion_tokens":512},"choices":[]}\n\ndata: [DONE]\n\n');
    })() };
    const result = await readGenerationResponse(response);
    assert.equal(result.choices[0].finish_reason, 'length'); assert.equal(result.usage.completion_tokens, 512);
});
