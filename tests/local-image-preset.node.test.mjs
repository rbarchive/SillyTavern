import assert from 'node:assert/strict';
import test from 'node:test';
import { applyLocalImagePreset } from '../public/scripts/extensions/stable-diffusion/local-image-preset.js';

test('enables the installed local backend without removing unrelated settings', () => {
    const settings = { source: 'extras', character_prompts: { hero: 'red coat' } };
    assert.equal(applyLocalImagePreset(settings), true);
    assert.equal(settings.source, 'comfy');
    assert.equal(settings.comfy_workflow, 'Local_SDXL_Turbo_Selectable.json');
    assert.equal(settings.width, 1280);
    assert.equal(settings.height, 720);
    assert.equal((settings.height - 64) % settings.dimension_step, 0);
    assert.deepEqual(settings.character_prompts, { hero: 'red coat' });
});

test('subsequent loads preserve user-selected backend and resolution', () => {
    const settings = {};
    applyLocalImagePreset(settings);
    Object.assign(settings, { source: 'drawthings', width: 768, height: 512 });
    const before = structuredClone(settings);
    assert.equal(applyLocalImagePreset(settings), false);
    assert.deepEqual(settings, before);
});
