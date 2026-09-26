import test from 'node:test';
import assert from 'node:assert/strict';
import { orderedExtensionPromptKeys } from '../public/scripts/rp-extension-order.js';

const rp = ['rp_memory_context', 'rp_memory_mode', 'rp_memory_story_role'];
function permutations(items) {
    return items.length ? items.flatMap((key, i) => permutations(items.filter((_, j) => j !== i)).map(rest => [key, ...rest])) : [[]];
}
test('all RP insertion orders preserve unrelated slots and prompt contents', () => {
    for (const order of permutations(rp)) {
        const keys = ['otherA', order[0], 'otherB', order[1], order[2], 'otherC'];
        const prompts = Object.fromEntries(keys.map(key => [key, { value: key }]));
        const original = JSON.stringify(prompts);
        assert.deepEqual(orderedExtensionPromptKeys(prompts), ['otherA', rp[0], 'otherB', rp[1], rp[2], 'otherC']);
        assert.equal(JSON.stringify(prompts), original);
    }
});
test('missing RP keys and inherited properties retain own-key enumeration', () => {
    const prompts = Object.assign(Object.create({ rp_memory_mode: {} }), { unrelated: {}, rp_memory_story_role: { value: '' }, rp_memory_context: { value: 'memory', position: 99 } });
    assert.deepEqual(orderedExtensionPromptKeys(prompts), ['unrelated', rp[0], rp[2]]);
    assert.deepEqual(orderedExtensionPromptKeys({ a: {}, b: {} }), ['a', 'b']);
    assert.deepEqual(orderedExtensionPromptKeys({}), []);
    Object.defineProperty(prompts, 'rp_memory_mode', { value: {}, enumerable: false });
    assert.deepEqual(orderedExtensionPromptKeys(prompts), ['unrelated', rp[0], rp[2]]);
});
