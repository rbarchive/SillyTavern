import assert from 'node:assert/strict';
import test from 'node:test';
import { applyLocalImageModel } from '../public/scripts/extensions/stable-diffusion/local-image-models.js';

test('switches between installed model families without changing image content or size', () => {
    const settings = { source: 'comfy', width: 1280, height: 720, prompt_prefix: 'watercolor', negative_prompt: 'blur', character_prompts: { hero: 'coat' } };
    const cases = [
        ['z_image_bf16.safetensors', 'Local_ZImage_Base.json', 40, 4, 'res_multistep', 'simple'],
        ['sd_xl_turbo_1.0_fp16.safetensors', 'Local_SDXL_Turbo_Selectable.json', 4, 1, 'euler_ancestral', 'sgm_uniform'],
        ['Juggernaut-XL_v9_RunDiffusionPhoto_v2.safetensors', 'Local_Juggernaut_XL_Quality.json', 24, 5, 'dpmpp_2m', 'karras'],
    ];
    for (const [model, workflow, steps, cfg, sampler, scheduler] of cases) {
        settings.model = model;
        assert.equal(applyLocalImageModel(settings), true);
        assert.deepEqual([settings.comfy_workflow, settings.steps, settings.scale, settings.sampler, settings.scheduler], [workflow, steps, cfg, sampler, scheduler]);
        if (model.startsWith('Juggernaut')) assert.equal(settings.denoising_strength, 1);
        assert.deepEqual([settings.width, settings.height, settings.prompt_prefix, settings.negative_prompt, settings.character_prompts], [1280,720,'watercolor','blur',{hero:'coat'}]);
    }
});

test('leaves unknown models and other providers unchanged', () => {
    for (const settings of [{source:'comfy',model:'custom.safetensors',comfy_workflow:'custom.json'}, {source:'auto',model:'z_image_bf16.safetensors',steps:12}]) {
        const before = structuredClone(settings);
        assert.equal(applyLocalImageModel(settings), false);
        assert.deepEqual(settings,before);
    }
});
