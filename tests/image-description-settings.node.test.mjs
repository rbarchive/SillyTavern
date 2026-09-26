import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultImageDescriptionSettings, imageDescriptionSnapshot } from '../public/scripts/extensions/stable-diffusion/image-description-settings.js';

test('defaults are fresh and have no aliases', () => {
    const a = defaultImageDescriptionSettings();
    const b = defaultImageDescriptionSettings();
    assert.deepEqual(a, { mode: 'main', url: 'http://127.0.0.1:9998/v1', model: 'gemma-4-e4b-uncensored-hauhaucs-aggressive', context_length: 8192, max_tokens: 512 });
    a.model = 'changed';
    assert.equal(b.model, 'gemma-4-e4b-uncensored-hauhaucs-aggressive');
});

test('main mode snapshots as null and does not mutate settings', () => {
    const settings = { image_description: defaultImageDescriptionSettings(), ordinary: { keep: true } };
    const before = structuredClone(settings);
    assert.equal(imageDescriptionSnapshot(settings), null);
    assert.deepEqual(settings, before);
});

test('dedicated snapshots are validated and detached', () => {
    const settings = { image_description: { mode: 'dedicated', url: 'https://localhost:1234/v1/', model: 'vision', context_length: 4096, max_tokens: 256 } };
    const snapshot = imageDescriptionSnapshot(settings);
    assert.deepEqual(snapshot, { mode: 'dedicated', url: 'https://localhost:1234/v1', model: 'vision', context_length: 4096, max_tokens: 256 });
    snapshot.model = 'changed';
    assert.equal(settings.image_description.model, 'vision');
});

for (const [name, patch] of [
    ['invalid URL', { url: 'http://user:pass@localhost/v1?x=1' }],
    ['empty model', { model: '' }],
    ['invalid context', { context_length: 100 }],
    ['invalid output', { max_tokens: 2048 }],
]) test(`${name} is rejected`, () => {
    const config = { mode: 'dedicated', url: 'http://127.0.0.1:9998/v1', model: 'vision', context_length: 8192, max_tokens: 512, ...patch };
    assert.throws(() => imageDescriptionSnapshot({ image_description: config }));
});

