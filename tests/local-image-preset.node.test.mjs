import assert from 'node:assert/strict';
import test from 'node:test';
import { applyLocalImagePreset } from '../public/scripts/extensions/stable-diffusion/local-image-preset.js';

test('enables the installed local backend without removing unrelated settings', () => {
    const settings = { source: 'extras', character_prompts: { hero: 'red coat' } };
    assert.equal(applyLocalImagePreset(settings), true);
    assert.equal(settings.source, 'comfy');
    assert.equal(settings.comfy_workflow, 'Local_Juggernaut_XL_Quality.json');
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

for (const version of [1, 2, 3]) test(`upgrades preset v${version} to the selected Juggernaut default`, () => {
    const settings = { local_image_preset_version: version, source: 'comfy', steps: 4, scale: 1 };
    assert.equal(applyLocalImagePreset(settings), true);
    assert.equal(settings.local_image_preset_version, 4);
    assert.equal(settings.model, 'Juggernaut-XL_v9_RunDiffusionPhoto_v2.safetensors');
    assert.equal(settings.comfy_workflow, 'Local_Juggernaut_XL_Quality.json');
    assert.equal(settings.steps, 35);
    assert.equal(settings.scale, 5);
    assert.equal(settings.sampler, 'dpmpp_2m');
    assert.equal(settings.scheduler, 'karras');
    assert.equal(settings.negative_prompt, '');
});
