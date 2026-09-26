import { imageBoostEnabled } from '../public/scripts/extensions/stable-diffusion/image-boost-settings.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { applyReferenceImage, collectImageEvidence, createImageProvenance, normalizeLocalImageUrl, prepareImageContinuity, selectPixelImageReference } from '../public/scripts/extensions/stable-diffusion/image-continuity.js';
import { applyLocalImagePreset } from '../public/scripts/extensions/stable-diffusion/local-image-preset.js';

const source = fs.readFileSync(new URL('../public/scripts/extensions/stable-diffusion/index.js', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const workflowFile = new URL('../default/content/Local_Reference_Image_Continuity.json', import.meta.url);
const referenceWorkflow = fs.readFileSync(workflowFile, 'utf8');
const qualityWorkflow = fs.readFileSync(new URL('../default/content/Local_Juggernaut_XL_Quality.json', import.meta.url), 'utf8');
const extract = name => source.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?^\\}`, 'm'))[0];
const noop = () => {};
const origin = { file: 'original', avatar: 'Hero.png', integrity: 'synthetic', expectedLength: 4 };
const scope = { worldId: 'world', storyId: 'story', branchId: 'main', worldBranchId: 'root' };
const canonical = () => ({ scope: { ...scope }, appearanceRevision: 'current', characters: [{ characterId: 'hero', name: 'Hero', appearance: 'Black hair' }],
    currentScene: { location: 'Garden', activeCharacterIds: ['hero'] } });
const evidence = () => collectImageEvidence(['anchor', 'recent'].map(name => ({ extra: { media_index: 0, media: [{
    type: 'image', source: 'generated', url: `/user/images/Hero/${name}.png`, title: `Requested ${name}`,
    image_context: { version: 1, sourceKind: 'requested_prompt', scope: { ...scope }, appearanceRevision: 'current', appearanceContextApplied: true, sceneLocation: 'Garden', contextCharacterIds: ['hero'], referenceIds: [] },
}] } })));
const continuity = () => {
    const context = canonical(), refs = evidence();
    return { chatId: 'original', origin: { ...origin }, appearanceContext: context, evidence: refs, references: refs.slice(-1), contextResolved: true,
        provenance: createImageProvenance({ appearanceContext: context, references: refs.slice(-1), appearanceContextApplied: true }) };
};

function fixture({ workflow = referenceWorkflow, responseOk = true, mime = 'image/png', dataUrl = 'data:image/png;base64,cGl4ZWw=', switchOnImage = false } = {}) {
    const calls = [], jobs = [], descriptionRequests = [];
    let current = 'original';
    const context = { chatId: current, name2: 'Hero', saveChat: async () => {} };
    const globals = { performance, imageBoostEnabled,
        extension_settings: { sd: { comfy_workflow: 'Local_Reference_Image_Continuity.json', seed: 1, model: 'installed.safetensors', sampler: 'dpmpp_2m', scheduler: 'karras', steps: 35, scale: 5, width: 1280, height: 720, prompt_prefix: '', negative_prompt: '', prompts: {}, comfy_url: 'mock://comfy' } },
        getCurrentChatId: () => current, generationOrigin: () => ({ ...origin, file: current }), getContext: () => context,
        getRequestHeaders: () => ({}), collectImageEvidence, applyReferenceImage, prepareImageContinuity,
        getBase64Async: async () => dataUrl, substituteParams: value => value, structuredClone, Error,
        toastr: { error: noop }, console: { log: noop }, getUserAvatarUrl: () => { throw new Error('No avatar fallback'); }, getCharacterAvatarUrl: () => { throw new Error('No avatar fallback'); },
        eventSource: { emit: async (_, payload) => { payload.appearanceContext = canonical(); } },
        fetch: async (url, options) => {
            calls.push({ url, options });
            if (url === '/api/sd/comfy/workflow') return { ok: true, json: async () => workflow };
            if (url.startsWith('/user/images/')) { if (switchOnImage) current = 'other'; return { ok: responseOk, status: responseOk ? 200 : 404, blob: async () => ({ type: mime }) }; }
            if (url === '/api/sd/comfy/generate') return { ok: true, json: async () => ({ format: 'png', data: 'synthetic' }) };
            throw new Error(`Unexpected fetch ${url}`);
        },
        generationMode: { FREE: 6, RAW_LAST: 3, USER: 1, BACKGROUND: 7, FREE_EXTENDED: 11, MESSAGE: -1 },
        generateQuietPrompt: async options => { descriptionRequests.push(options); return { request: { messages: [{ role: 'user', content: options.quietPrompt }] } }; },
        combinePrefixes: (...values) => values.filter(Boolean).join(', '), getCharacterPrefix: () => '', getCharacterNegativePrefix: () => '',
        systemUserName: 'System', substituteParamsExtended: value => value, getVisibilityByInitiator: () => true, getMessageTimeStamp: () => 'synthetic',
        runGenerationJob: async payload => { jobs.push(payload); return { result: { path: '/success.png' } }; },
    };
    const sandbox = vm.createContext(globals);
    for (const name of ['assertImageGenerationOrigin', 'imageDescriptionInstruction', 'prepareComfyWorkflow', 'generateComfyImageCommon', 'generateComfyImage', 'generateBackgroundImage']) vm.runInContext(extract(name), sandbox);
    return { sandbox, calls, jobs, descriptionRequests };
}
const placeholders = ['model', 'vae', 'sampler', 'scheduler', 'steps', 'scale', 'width', 'height'];

test('actual shared prepare function leaves ordinary t2i output unchanged and never fetches a reference', async () => {
    const f = fixture({ workflow: '{"fixed":"unchanged","denoise":1}' });
    assert.equal(await f.sandbox.prepareComfyWorkflow('', [], continuity()), '{"fixed":"unchanged","denoise":1}');
    assert.equal(f.calls.length, 1, 'only existing workflow load');
    const noFetch = await applyReferenceImage(qualityWorkflow, null, { fetchImage: () => { throw new Error('Unexpected reference fetch'); } });
    assert.equal(noFetch, qualityWorkflow);
});

test('actual workflow inserts earliest compatible selected local image into connected latent graph and metadata', async () => {
    const f = fixture();
    const c = continuity();
    const signal = new AbortController().signal;
    const processed = JSON.parse(await f.sandbox.prepareComfyWorkflow('', placeholders, c, signal));
    assert.equal(processed['10'].class_type, 'ETN_LoadImageBase64');
    assert.equal(processed['10'].inputs.image, 'cGl4ZWw=');
    assert.deepEqual(processed['13'].inputs.image, ['10', 0]);
    assert.deepEqual(processed['12'].inputs.pixels, ['13', 0]);
    assert.deepEqual(processed['3'].inputs.latent_image, ['12', 0]);
    assert.equal(processed['3'].inputs.denoise, 0.7);
    assert.equal(f.calls[1].url, '/user/images/Hero/anchor.png');
    assert.equal(f.calls[1].options.signal, signal);
    assert.ok(c.provenance.referenceIds.includes(c.evidence[0].id), 'pixel anchor recorded even outside capped text refs');
    assert.equal(c.provenance.sourceKind, 'requested_prompt');
});

test('linked pixel eligibility rejects unknown, old appearance, wrong scope/scene/subjects and raw unapplied evidence', async () => {
    for (const patch of [
        { appearanceRevision: 'old' }, { appearanceRevision: undefined }, { appearanceContextApplied: false },
        { scope: { ...scope, worldId: 'other-world' } }, { scope: undefined }, { sceneLocation: '' }, { sceneLocation: 'Castle' },
        { contextCharacterIds: ['other'] }, { contextCharacterIds: undefined },
    ]) {
        const c = continuity(); c.evidence = c.evidence.map(row => ({ ...row, ...patch }));
        assert.equal(selectPixelImageReference(c.evidence, c.appearanceContext), undefined);
        const f = fixture();
        await assert.rejects(f.sandbox.prepareComfyWorkflow('', placeholders, c), /successful compatible image/);
        assert.equal(f.calls.length, 1, 'invalid reference rejected before byte fetch');
    }
    const refs = evidence(); refs[0].selected = false;
    assert.equal(selectPixelImageReference(refs, canonical()).imageUrl, '/user/images/Hero/recent.png');
});

test('copied pre-fork current-chat history retains compatible text and pixel anchors without borrowing original future', async () => {
    const originalHistory = ['A', 'B', 'C-future'].map(name => ({ extra: { media_index: 0, media: [{
        type: 'image', source: 'generated', url: `/user/images/Hero/${name}.png`, title: `Requested ${name}`,
        image_context: { scope: { ...scope }, appearanceRevision: 'current', appearanceContextApplied: true,
            sceneLocation: 'Garden', contextCharacterIds: ['hero'], referenceIds: [] },
    }] } }));
    const copiedPast = JSON.parse(JSON.stringify(originalHistory.slice(0, 2)));
    const context = canonical();
    context.scope = { ...scope, storyId: 'new-story', branchId: 'new-branch', worldBranchId: 'new-world-branch' };
    const prepared = await prepareImageContinuity({ chatId: 'original', origin, chat: copiedPast, currentRequest: 'picture', appearanceContextApplied: true,
        isCurrent: () => true, emit: async (_, payload) => { payload.appearanceContext = context; },
    });
    assert.deepEqual(prepared.references.map(row => row.prompt), ['Requested A', 'Requested B']);
    assert.equal(selectPixelImageReference(prepared.evidence, prepared.appearanceContext).imageUrl, '/user/images/Hero/A.png');
    assert.ok(!prepared.instruction.includes('C-future'));
    assert.ok(!prepared.references.some(row => row.imageUrl.includes('C-future')));
    const f = fixture();
    await f.sandbox.prepareComfyWorkflow('', placeholders, prepared);
    assert.equal(f.calls[1].url, '/user/images/Hero/A.png');
    prepared.appearanceContext = { ...context, currentScene: { ...context.currentScene, location: 'Castle' } };
    assert.equal(selectPixelImageReference(prepared.evidence, prepared.appearanceContext), undefined);
});

test('unsafe schemes, remote and ambiguous paths fail before reference fetch', async () => {
    const bad = [
        'https://example.com/user/images/ref.png', 'http://localhost/user/images/ref.png', '//example.com/ref.png',
        'data:image/png;base64,cGl4ZWw=', 'blob:local', 'file:///user/images/ref.png', '/user/images/../secret.png',
        '/user/images/%2e%2e/secret.png', '/user/images/%252e%252e/secret.png', '/user/images/Hero\\ref.png',
        '/user/images/ref.png?query=1', '/user/images/ref.png#part', '/user/images/ref%3fquery.png', '/user/images/%00ref.png', '/elsewhere/ref.png',
    ];
    for (const url of bad) {
        assert.throws(() => normalizeLocalImageUrl(url));
        const f = fixture(), c = continuity(); c.evidence = [{ ...c.evidence[0], imageUrl: url }];
        await assert.rejects(f.sandbox.prepareComfyWorkflow('', placeholders, c));
        assert.equal(f.calls.length, 1);
    }
    assert.equal(normalizeLocalImageUrl('user/images/Some Hero/ref.png'), '/user/images/Some%20Hero/ref.png');
});

test('missing reference, failed response and invalid MIME/base64 fail explicitly without PNG fallback', async () => {
    const empty = continuity(); empty.evidence = [];
    await assert.rejects(fixture().sandbox.prepareComfyWorkflow('', placeholders, empty), /successful compatible image/);
    for (const options of [{ responseOk: false }, { mime: 'text/html' }, { dataUrl: 'data:image/png;base64,"unsafe"' }, { dataUrl: 'data:image/png;base64,a' }, { dataUrl: 'data:image/jpeg;base64,cGl4ZWw=' }]) {
        const f = fixture(options);
        await assert.rejects(f.sandbox.prepareComfyWorkflow('', placeholders, continuity()));
        assert.equal(f.jobs.length, 0);
    }
});

test('actual foreground and durable builders use the same workflow parameter and abort on asynchronous chat change', async () => {
    for (const durable of [false, true]) {
        const f = fixture(), c = continuity(), signal = new AbortController().signal;
        if (durable) {
            await f.sandbox.generateBackgroundImage(11, 'picture', undefined, 'Describe canonical black hair', '', 'Hero', 'tool', signal, { update: noop }, c);
            assert.equal(JSON.parse(f.jobs[0].image.workflow)['10'].inputs.image, 'cGl4ZWw=');
            assert.equal(f.jobs[0].image.imageContext.referenceIds.length, 2);
            assert.equal(f.jobs[0].image.boost, true);
        } else {
            await f.sandbox.generateComfyImage('black hair', '', signal, c);
            const payload = JSON.parse(f.calls.at(-1).options.body);
            assert.equal(payload.boost, true);
            assert.equal(JSON.parse(payload.prompt).prompt['10'].inputs.image, 'cGl4ZWw=');
        }
        const switched = fixture({ switchOnImage: true });
        const work = durable
            ? switched.sandbox.generateBackgroundImage(11, 'picture', undefined, 'Describe', '', 'Hero', 'tool', signal, { update: noop }, continuity())
            : switched.sandbox.generateComfyImage('black hair', '', signal, continuity());
        await assert.rejects(work, /chat changed/);
        assert.equal(switched.jobs.length, 0);
        assert.ok(!switched.calls.some(call => call.url.endsWith('/generate')));
    }
});

test('raw opt-in lazy provider lookup marks context unapplied and never invokes description model', async () => {
    const f = fixture(), c = continuity();
    delete c.appearanceContext; delete c.contextResolved; delete c.provenance;
    const output = await f.sandbox.prepareComfyWorkflow('', placeholders, c);
    assert.equal(JSON.parse(output)['10'].inputs.image, 'cGl4ZWw=');
    assert.equal(c.provenance.appearanceContextApplied, false);
    assert.equal(f.descriptionRequests.length, 0);
    const legacy = continuity(); legacy.evidence = legacy.evidence.map(row => ({ ...row, appearanceRevision: undefined, scope: undefined }));
    delete legacy.appearanceContext; legacy.contextResolved = true;
    assert.ok(JSON.parse(await fixture().sandbox.prepareComfyWorkflow('', placeholders, legacy))['10'].inputs.image);
});

test('opt-in registry has exactly one workflow and existing default selection and quality graph remain unchanged', () => {
    const index = JSON.parse(fs.readFileSync(new URL('../default/content/index.json', import.meta.url), 'utf8'));
    assert.deepEqual(index.filter(row => row.filename === 'Local_Reference_Image_Continuity.json'), [{ filename: 'Local_Reference_Image_Continuity.json', type: 'workflow' }]);
    const settings = {}; applyLocalImagePreset(settings);
    assert.equal(settings.comfy_workflow, 'Local_Juggernaut_XL_Quality.json');
    assert.equal(settings.model, 'Juggernaut-XL_v9_RunDiffusionPhoto_v2.safetensors');
    assert.deepEqual(JSON.parse(qualityWorkflow)['3'].inputs.latent_image, ['5', 0]);
    assert.ok(!qualityWorkflow.includes('%reference_image%'));
});

test('text-to-image empty latent uses full denoise while reference samplers preserve configured strength', async () => {
    const f = fixture({ workflow: qualityWorkflow });
    f.sandbox.extension_settings.sd.denoising_strength = 0.4;
    const graph = JSON.parse(await f.sandbox.prepareComfyWorkflow('', placeholders, continuity()));
    assert.equal(graph['3'].inputs.denoise, 1);
    assert.equal(graph['5'].class_type, 'EmptyLatentImage');
    const ref = fixture(); ref.sandbox.extension_settings.sd.denoising_strength = 0.4;
    const refGraph = JSON.parse(await ref.sandbox.prepareComfyWorkflow('', placeholders, continuity()));
    assert.equal(refGraph['3'].inputs.denoise, 0.4);
});
