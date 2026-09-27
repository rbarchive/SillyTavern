import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { imageEditSettings, imageEditInstruction, assertImageEditGraph } from '../public/scripts/extensions/stable-diffusion/image-edit.js';
import { applyReferenceImage, buildContinuityInstruction, collectImageEvidence, selectPixelImageReference } from '../public/scripts/extensions/stable-diffusion/image-continuity.js';

const settings = () => ({ source: 'comfy', comfy_type: 'standard', model: 'Juggernaut-XL_v9_RunDiffusionPhoto_v2.safetensors', comfy_workflow: 'Local_Juggernaut_XL_Quality.json',
    width: 1152, height: 648, steps: 24, scale: 5, sampler: 'dpmpp_2m', scheduler: 'karras', seed: 10, denoising_strength: 1, clip_skip: 1, comfy_placeholders: [{ find: 'reference_image', replace: 'wrong' }] });
const reference = { id: 'clicked-middle', imageUrl: '/user/images/Synthetic/middle.png' };
const attachment = { url: reference.imageUrl, width: 768, height: 1024 };
const source = fs.readFileSync(new URL('../public/scripts/extensions/stable-diffusion/index.js', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const extract = name => source.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?^\\}`, 'm'))[0];
const workflow = fs.readFileSync(new URL('../default/content/Local_Reference_Image_Continuity.json', import.meta.url), 'utf8');

test('edit snapshots pixel settings without changing full-noise text generation or source attachment', () => {
    const original = settings(), before = structuredClone(original), src = structuredClone(attachment);
    const result = imageEditSettings(original, attachment);
    assert.equal(result.comfy_workflow, 'Local_Reference_Image_Continuity.json');
    assert.equal(result.denoising_strength, 0.55);
    assert.equal(result.width, 768); assert.equal(result.height, 1024);
    assert.deepEqual(result.comfy_placeholders, []);
    assert.deepEqual(original, before); assert.deepEqual(attachment, src);
});

test('unsupported provider/model and unsafe selected paths fail without fallback; strength never reaches full redraw', () => {
    for (const change of [{ source: 'openai' }, { comfy_type: 'runpod' }, { model: 'z_image_bf16.safetensors' }]) {
        assert.throws(() => imageEditSettings({ ...settings(), ...change }, attachment), /ComfyUI/);
    }
    assert.throws(() => imageEditSettings(settings(), { url: 'https://example.com/a.png' }), /local|Local/);
    for (const value of [0, 1, NaN, Infinity, -1]) assert.throws(() => imageEditSettings(settings(), attachment, value), /0.1/);
    for (const value of [0.1, 0.35, 0.85]) assert.equal(imageEditSettings(settings(), attachment, value).denoising_strength, value);
});

test('correction request keeps source data quoted and asks for current scene and complete revised visual description', () => {
    const request = imageEditInstruction('garden, blue coat\n"historical"', '오른손은 잔을 잡고, 시선은 정면');
    assert.ok(request.includes(JSON.stringify('garden, blue coat\n"historical"')));
    assert.ok(request.includes('오른손은 잔을 잡고'));
    assert.match(request, /current conversation and scene/);
    assert.match(request, /historical requested-prompt data, not verified observations/);
    assert.match(request, /complete updated/);
});

function fixture(graph = workflow) {
    const original = settings(), calls = [];
    const snapshot = { chatId: 'synthetic', origin: { file: 'synthetic' }, contextResolved: true,
        evidence: [{ id: 'anchor', imageUrl: '/user/images/Synthetic/anchor.png', sourceKind: 'requested_prompt' }],
        imageEdit: { reference, settings: imageEditSettings(original, attachment) }, provenance: { referenceIds: [] } };
    const sandbox = vm.createContext({ extension_settings: { sd: original }, getRequestHeaders: () => ({}), applyReferenceImage, assertImageEditGraph,
        getBase64Async: async () => 'data:image/png;base64,bWlkZGxl', assertImageGenerationOrigin: () => {}, substituteParams: x => x,
        fetch: async (url, options) => { calls.push({ url, options }); return url === '/api/sd/comfy/workflow'
            ? { ok: true, json: async () => graph } : { ok: true, blob: async () => ({ type: 'image/png' }) }; }, console, Math });
    vm.runInContext(extract('prepareComfyWorkflow'), sandbox);
    return { original, sandbox, snapshot, calls };
}

test('actual workflow uses exactly clicked middle pixels through VAEEncode with lower noise and original dimensions', async () => {
    const f = fixture();
    const graph = JSON.parse(await f.sandbox.prepareComfyWorkflow('', ['model','sampler','scheduler','steps','scale','width','height'], f.snapshot));
    assert.equal(f.calls[1].url, reference.imageUrl);
    assert.equal(JSON.parse(f.calls[0].options.body).file_name, 'Local_Reference_Image_Continuity.json');
    assert.equal(graph['10'].inputs.image, 'bWlkZGxl');
    assert.equal(graph['12'].class_type, 'VAEEncode');
    assert.deepEqual(graph['12'].inputs.pixels, ['13', 0]);
    assert.deepEqual(graph['13'].inputs.image, ['10', 0]);
    assert.deepEqual(graph['3'].inputs.latent_image, ['12', 0]);
    assert.equal(graph['3'].inputs.denoise, 0.55);
    assert.equal(graph['13'].inputs.width, 768); assert.equal(graph['13'].inputs.height, 1024);
    assert.deepEqual(f.snapshot.provenance.referenceIds, ['clicked-middle']);
    assert.deepEqual(f.original, settings());
});

test('a modified edit workflow lacking a pixel input fails before any image or drawing request', async () => {
    const f = fixture('{"3":{"class_type":"EmptyLatentImage","inputs":{}}}');
    await assert.rejects(f.sandbox.prepareComfyWorkflow('', [], f.snapshot), /selected image pixels/);
    assert.equal(f.calls.length, 1);
});

test('explicit editing retains cancellation, failed-image and MIME safety checks', async () => {
    const continuity = { imageEdit: { reference } };
    const controller = new AbortController(); controller.abort();
    let fetched = false;
    await assert.rejects(applyReferenceImage(workflow, continuity, { signal: controller.signal, assertCurrent: () => {}, fetchImage: async () => { fetched = true; } }), /abort/i);
    assert.equal(fetched, false);
    await assert.rejects(applyReferenceImage(workflow, continuity, { assertCurrent: () => {}, fetchImage: async () => ({ ok: false, status: 404 }) }), /404/);
    await assert.rejects(applyReferenceImage(workflow, continuity, { assertCurrent: () => {}, fetchImage: async () => ({ ok: true, blob: async () => ({ type: 'text/html' }) }) }), /MIME/);
});

test('unused image placeholder does not permit a text-to-image edit or global-noise override', async () => {
    const disconnected = JSON.parse(workflow);
    disconnected['3'].inputs.latent_image = ['99', 0];
    disconnected['99'] = { class_type: 'EmptyLatentImage', inputs: {} };
    const f = fixture(JSON.stringify(disconnected));
    await assert.rejects(f.sandbox.prepareComfyWorkflow('', [], f.snapshot), /sampler input/);
    assert.equal(f.original.denoising_strength, 1);
});

test('edit strength overrides saved numeric sampler strengths and placeholders, leaving normal settings untouched', async () => {
    for (const saved of [1, 0.7, '%denoise%']) {
        for (const strength of [0.35, 0.55]) {
            const graph = JSON.parse(workflow); graph['3'].inputs.denoise = saved;
            const f = fixture(JSON.stringify(graph)); f.snapshot.imageEdit.settings.denoising_strength = strength;
            const result = JSON.parse(await f.sandbox.prepareComfyWorkflow('', [], f.snapshot));
            assert.equal(result['3'].inputs.denoise, strength);
            assert.equal(f.original.denoising_strength, 1);
        }
    }
});


test('explicit image corrections override appearance for this edit while ordinary continuity retains canonical rules', () => {
    const ordinary = buildContinuityInstruction({ currentRequest: 'red hair' });
    const edit = buildContinuityInstruction({ currentRequest: 'red hair', allowAppearanceChanges: true });
    assert.match(ordinary, /unconfirmed unless saved/);
    assert.doesNotMatch(edit, /unconfirmed unless saved/);
    assert.match(edit, /explicitly requested visual changes override canonical/);
    assert.match(edit, /saved Story profiles remain unchanged/);
});

test('appearance edits never become automatic canonical pixel references but can still be explicitly re-edited', async () => {
    const evidence = collectImageEvidence([{ extra: { media_index: 0, media: [{ type: 'image', source: 'generated', url: reference.imageUrl, title: 'red hair', image_edit: { correction: 'red hair' }, image_context: { appearanceContextApplied: true, appearanceRevision: 'black-hair' } }] } }]);
    assert.equal(evidence[0].isImageEdit, true);
    assert.equal(selectPixelImageReference(evidence), undefined);
    const continuity = { imageEdit: { reference: evidence[0] }, provenance: { referenceIds: [] } };
    const result = await applyReferenceImage(workflow, continuity, { assertCurrent() {}, fetchImage: async () => ({ ok: true, blob: async () => ({ type: 'image/png' }) }), toBase64: async () => 'data:image/png;base64,bWlkZGxl' });
    assert.ok(result.includes('bWlkZGxl'));
});
