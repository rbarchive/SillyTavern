import assert from 'node:assert/strict';
import test from 'node:test';
import { ensureQwenUserQuery } from '../src/endpoints/backends/qwen-user-query.js';

test('preserves normal queries and their message roles', () => {
    const messages = [{ role: 'system', content: 'rules' }, { role: 'user', content: 'hello' }, { role: 'assistant', content: 'prefill' }];
    assert.equal(ensureQwenUserQuery(messages), messages);
});

for (const [label, messages] of [
    ['continuation', [{ role: 'system', content: 'rules' }, { role: 'assistant', content: 'scene' }]],
    ['system only', [{ role: 'system', content: 'rules' }]],
    ['tool response user', [{ role: 'system', content: 'rules' }, { role: 'user', content: ' <tool_response>result</tool_response> ' }]],
    ['multimodal tool response', [{ role: 'user', content: [{ type: 'text', text: '<tool_response>result</tool_response>' }] }]],
    ['tool only', [{ role: 'tool', content: 'result', tool_call_id: 'id' }]],
]) {
    test(`adds a query for ${label} without modifying original content`, () => {
        const before = structuredClone(messages);
        const result = ensureQwenUserQuery(messages);
        assert.equal(result.length, messages.length + 1);
        assert.deepEqual(messages, before);
        assert.deepEqual(result.filter(message => !message.content?.includes?.("Let's get started.")), before);
        assert.equal(result.find(message => message.content === "Let's get started.").role, 'user');
        assert.equal(ensureQwenUserQuery(result), result);
    });
}

test('does not treat a quoted tool response with user instructions as tool-only', () => {
    const messages = [{ role: 'user', content: '<tool_response>result</tool_response> Explain this.' }];
    assert.equal(ensureQwenUserQuery(messages), messages);
});

test('leaves text completion prompts untouched', () => {
    assert.equal(ensureQwenUserQuery('text prompt'), 'text prompt');
});


test('places user before an opening assistant even when later real user turns exist', () => {
    const messages = [
        { role: 'system', content: 'world rules' },
        { role: 'assistant', content: 'The visitor stands in the room.' },
        { role: 'user', content: 'Introduce yourself.' },
        { role: 'assistant', content: 'My name is Elin.' },
        { role: 'user', content: 'Where are you from?' },
    ];
    const before = structuredClone(messages);
    const result = ensureQwenUserQuery(messages, '[Start a new chat]');
    assert.deepEqual(result.map(message => message.role), ['system', 'user', 'assistant', 'user', 'assistant', 'user']);
    assert.deepEqual(result, [messages[0], { role: 'user', content: '[Start a new chat]' }, ...messages.slice(1)]);
    assert.deepEqual(messages, before);
    assert.equal(ensureQwenUserQuery(result), result);
});
