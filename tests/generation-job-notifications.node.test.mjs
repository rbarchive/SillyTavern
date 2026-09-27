import test from 'node:test';
import assert from 'node:assert/strict';
import { failureNotices, generationFailureMessage } from '../public/scripts/generation-job-notifications.js';

test('failure receipt survives page reload without storing errors or prompts', () => {
    let value;
    const storage = { getItem: () => value, setItem: (key, data) => { value = data; } };
    const before = failureNotices(storage);
    assert.equal(before.has('failed-job'), false);
    before.add('failed-job');
    assert.equal(failureNotices(storage).has('failed-job'), true);
    assert.equal(failureNotices(storage).has('new-job'), false);
    assert.deepEqual(JSON.parse(value), ['failed-job']);
});
test('blocked or malformed browser storage keeps working deduplication', () => {
    for (const storage of [undefined, { getItem: () => '{bad', setItem() { throw Error('disabled'); } }]) {
        const notices = failureNotices(storage); notices.add('job');
        assert.equal(notices.has('job'), true);
    }
});
test('context overflow displays exact limits and actionable settings without giant JSON', () => {
    const message = generationFailureMessage('Engine protocol predict request returned 400: {"error":{"code":400,"message":"request (14104 tokens) exceeds the available context size (8192 tokens), try increasing it","type":"exceed_context_size_error"}}');
    assert.match(message, /14,104토큰/); assert.match(message, /8,192토큰/);
    assert.match(message, /Load LM Studio model with ST Context length/);
    assert.doesNotMatch(message, /exceed_context_size_error/);
    assert.equal(generationFailureMessage('unrelated failure'), 'unrelated failure');
    assert.equal(generationFailureMessage('x'.repeat(5000)).length, 351);
});
