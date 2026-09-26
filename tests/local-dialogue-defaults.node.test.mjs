import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateLocalDialogueDefaults, prepareLocalDialogueParams } from '../public/scripts/local-dialogue-defaults.js';

test('existing custom connections upgrade once; later OFF and other providers remain unchanged', () => {
    const settings = { chat_completion_source: 'custom', stream_openai: false };
    migrateLocalDialogueDefaults(settings);
    assert.deepEqual(settings, { chat_completion_source: 'custom', stream_openai: true, lmstudio_skip_reasoning: true, rp_dialogue_defaults_version: 1 });
    settings.stream_openai = false; settings.lmstudio_skip_reasoning = false;
    migrateLocalDialogueDefaults(settings);
    assert.equal(settings.stream_openai, false); assert.equal(settings.lmstudio_skip_reasoning, false);
    const other = { chat_completion_source: 'openai', stream_openai: false };
    migrateLocalDialogueDefaults(other); assert.equal(other.stream_openai, false);
});

test('local Qwen defaults skip reasoning without losing any RP source or continuation', () => {
    const input = { model: 'qwen3.8-27b-uncensored-mlx', messages: [{ role: 'system', content: '월드' }, { role: 'user', content: '대화' }], max_tokens: 8192, stream: true };
    const settings = { custom_url: 'http://127.0.0.1:9998/v1' };
    const result = prepareLocalDialogueParams(input, settings);
    assert.deepEqual(result.messages.slice(0, -1), input.messages);
    assert.equal(result.messages.at(-1).content, '<think>\n\n</think>\n\n');
    assert.equal(input.messages.length, 2); assert.equal(result.max_tokens, 8192);
    const continuation = { ...input, messages: [...input.messages, { role: 'assistant', content: '그녀는' }] };
    assert.equal(prepareLocalDialogueParams(continuation, settings).messages.at(-1).content, '<think>\n\n</think>\n\n그녀는');
    assert.deepEqual(prepareLocalDialogueParams(result, settings), result);
    for (const excluded of [{ lmstudio_skip_reasoning: false }, { json_schema: {} }]) {
        assert.equal(prepareLocalDialogueParams(input, { ...settings, ...excluded }), input);
    }
    assert.equal(prepareLocalDialogueParams(input, { custom_url: 'https://example.com/v1' }), input);
    assert.equal(prepareLocalDialogueParams({ ...input, model: 'gemma4' }, settings).model, 'gemma4');
});

test('tool-enabled Qwen dialogue skips reasoning and preserves tool definitions and call history', () => {
    const tools = [{ type: 'function', function: { name: 'RpMemoryOpenWorldHub', parameters: { type: 'object', properties: {} } } }];
    const settings = { custom_url: 'http://127.0.0.1:9998/v1', tools };
    const call = { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'RpMemoryOpenWorldHub', arguments: '{}' } }] };
    for (const history of [[], [call], [call, { role: 'tool', tool_call_id: 'call_1', content: 'World Hub opened' }]]) {
        const input = { model: 'qwen3.8-27b-uncensored-mlx', messages: [{ role: 'user', content: '허브를 열어 주세요' }, ...history], tools, tool_choice: 'auto' };
        const before = structuredClone(input);
        const result = prepareLocalDialogueParams(input, settings);
        assert.deepEqual(result.messages.slice(0, -1), before.messages);
        assert.deepEqual(result.messages.at(-1), { role: 'assistant', content: '<think>\n\n</think>\n\n' });
        assert.deepEqual(result.tools, tools);
        assert.equal(result.tool_choice, 'auto');
        assert.deepEqual(input, before);
    }
});
