import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { prepareImageContinuity, collectImageEvidence, IMAGE_CONTEXT_REQUESTED } from '../public/scripts/extensions/stable-diffusion/image-continuity.js';

const source = fs.readFileSync(new URL('../public/scripts/extensions/stable-diffusion/index.js', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const extract = name => {
    const found = source.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?^\\}`, 'm'));
    assert.ok(found, name);
    return found[0];
};
const noop = () => {};
const history = () => ['A', 'B', 'C'].map(key => ({ extra: { media_index: 0, media: [{ type: 'image', source: 'generated', url: `/${key}.png`, title: `Requested ${key}` }] } }));
const canonical = () => ({ scope: { worldId: 'world', storyId: 'story', branchId: 'main', worldBranchId: 'root' },
    characters: [{ characterId: 'hero', name: 'Hero', appearance: 'Black hair', source: 'world_snapshot' }],
    currentScene: { location: 'Garden', activeCharacterIds: ['hero'] }, appearanceRevision: 'stable-appearance', revision: 'scene-revision' });

function fixture({ durable = false, emitOverride, fail = false, switchOnSave = false } = {}) {
    const context = { chatId: 'original', chat: history(), characters: [{ name: 'Hero' }], characterId: 0, name2: 'Narrator',
        addOneMessage: noop, scrollOnMediaLoad: noop, saveChat: async () => { if (switchOnSave) context.chatId = 'switched'; } };
    const requests = [], jobs = [], callbacks = [];
    const modes = { TOOL: -2, MESSAGE: -1, CHARACTER: 0, USER: 1, SCENARIO: 2, RAW_LAST: 3, NOW: 4, FACE: 5, FREE: 6, BACKGROUND: 7, CHARACTER_MULTIMODAL: 8, USER_MULTIMODAL: 9, FACE_MULTIMODAL: 10, FREE_EXTENDED: 11 };
    const prompts = Object.fromEntries(Object.values(modes).map(mode => [mode, 'Describe {0}']));
    prompts[-1] = '{{prompt}}';
    const handle = { hide: async () => {} };
    const globals = {
        console: { log: noop, warn: noop, trace: noop, error: noop }, Error, AbortController, structuredClone, MODULE_NAME: 'sd',
        generationMode: modes, initiators: { tool: 'tool', command: 'command', swipe: 'swipe' }, sources: { comfy: 'comfy', extras: 'extras' }, comfyTypes: { standard: 'standard' },
        extension_settings: { sd: { source: durable ? 'comfy' : 'extras', comfy_type: 'standard', free_extend: false, multimodal_captioning: false, prompts, comfy_url: 'mock://comfy', prompt_prefix: '', negative_prompt: '' } },
        promptTemplates: {}, multimodalMap: {},
        triggerWords: { 0: ['you'], 1: ['me'], 2: ['scene'], 3: ['raw_last'], 4: ['last'], 5: ['face'], 7: ['background'] },
        getContext: () => context, getCurrentChatId: () => context.chatId,
        generationOrigin: () => ({ file: context.chatId, avatar: 'Narrator.png', integrity: 'fixture', expectedLength: context.chat.length + 1 }),
        prepareImageContinuity, collectImageEvidence,
        eventSource: { emit: async (event, payload) => { callbacks.push(event); if (event === IMAGE_CONTEXT_REQUESTED) {
            if (emitOverride) await emitOverride(payload, context); else payload.appearanceContext = canonical();
        } } },
        event_types: { SD_PROMPT_PROCESSING: 'process', FORCE_SET_BACKGROUND: 'background', MESSAGE_RECEIVED: 'received', CHARACTER_MESSAGE_RENDERED: 'rendered' },
        isValidState: () => true, ensureSelectionExists: noop, isTrueBoolean: value => value === true, isFalseBoolean: value => value === false,
        setTypeSpecificDimensions: () => ({}), restoreOriginalDimensions: noop, ActionLoaderHandle: { EMPTY: handle }, loader: { show: () => handle },
        beginImageGenerationStatus: () => ({ update: noop, hide: noop }), selected_group: null, this_chid: 0, main_api: durable ? 'openai' : 'other', oai_settings: { chat_completion_source: 'custom' },
        combinePrefixes: (...args) => args.filter(Boolean).join(', '), getCharacterPrefix: () => '', getCharacterNegativePrefix: () => '',
        substituteParams: value => value, substituteParamsExtended: (value, params) => value.replaceAll('{{prompt}}', params.prompt).replaceAll('{{prefixedPrompt}}', params.prefixedPrompt),
        stringFormat: (value, trigger) => value.replace('{0}', trigger), generateFreeModePrompt: value => value, getRawLastMessage: () => 'Raw unchanged',
        refinePrompt: async value => value, processReply: value => value,
        generateQuietPrompt: async options => { requests.push(options); return options.prepareRequest ? { request: { messages: [{ role: 'user', content: options.quietPrompt }] } } : 'black hair, garden'; },
        prepareComfyWorkflow: async () => '{"text":"%prompt%"}', getVisibilityByInitiator: () => true, getMessageTimeStamp: () => 'synthetic', systemUserName: 'System',
        runGenerationJob: async payload => { jobs.push(payload); return { result: { path: '/durable.png' } }; },
        generateExtrasImage: async () => { if (fail) throw new Error('Synthetic endpoint failure'); return { data: 'pixel', format: 'png' }; },
        saveBase64AsFile: async () => { if (switchOnSave) context.chatId = 'switched'; return '/success.png'; },
        humanizedDateTime: () => 'synthetic', isVideo: () => false, MEDIA_TYPE: { IMAGE: 'image', VIDEO: 'video' }, MEDIA_SOURCE: { GENERATED: 'generated' }, MEDIA_DISPLAY: { GALLERY: 'gallery' },
        debounce_timeout: { short: 0 }, setTimeout: noop,
        toastr: { info: noop, error: noop, warning: noop, clear: noop }, t: (parts, ...args) => parts.reduce((text, part, i) => text + part + (args[i] || ''), ''),
    };
    const sandbox = vm.createContext(globals);
    for (const name of ['getGenerationType', 'getQuietPrompt', 'getPrompt', 'imageDescriptionInstruction', 'assertImageGenerationOrigin', 'generateBackgroundImage', 'generatePrompt', 'sendGenerationRequest', 'sendMessage', 'generatePicture']) {
        vm.runInContext(extract(name), sandbox);
    }
    return { sandbox, context, requests, jobs, callbacks, modes };
}

test('actual foreground and durable description requests include canonical appearance and A/B/C evidence', async () => {
    for (const durable of [false, true]) {
        const f = fixture({ durable });
        const url = await f.sandbox.generatePicture('tool', {}, 'Seated beside the fountain');
        assert.ok(url);
        assert.equal(f.requests.length, 1);
        const instruction = f.requests[0].quietPrompt;
        assert.match(instruction, /Black hair/);
        for (const key of ['A', 'B', 'C']) assert.ok(instruction.includes(`Requested ${key}`));
        assert.match(instruction, /Seated beside the fountain/);
        assert.match(instruction, /Canonical appearance takes precedence/);
        if (durable) {
            assert.equal(f.jobs[0].image.generationType, f.modes.FREE_EXTENDED, 'tool participates with free_extend false');
            assert.equal(f.jobs[0].image.imageContext.appearanceRevision, 'stable-appearance');
            assert.equal(f.jobs[0].image.imageContext.appearanceContextApplied, true);
            assert.equal(f.jobs[0].image.imageContext.referenceIds.length, 3);
        } else {
            const saved = f.context.chat.at(-1);
            assert.equal(saved.extra.image_generation_prompt, saved.mes);
            assert.equal(saved.extra.media[0].image_context.appearanceRevision, 'stable-appearance');
            assert.equal(saved.extra.media[0].image_context.appearanceContextApplied, true);
            assert.equal(collectImageEvidence(JSON.parse(JSON.stringify(f.context.chat))).length, 4);
        }
    }
});

test('actual first-image description uses canonical context without needing historical images', async () => {
    const f = fixture();
    f.context.chat = [];
    await f.sandbox.generatePicture('tool', {}, 'Portrait at the garden');
    assert.match(f.requests[0].quietPrompt, /Black hair/);
    assert.equal(f.context.chat[0].extra.media[0].image_context.referenceIds.length, 0);
});

test('history evidence is frozen before async provider work and no-provider chats remain usable', async () => {
    const original = history();
    const prepared = await prepareImageContinuity({ chatId: 'original', origin: {}, chat: original, currentRequest: 'picture', isCurrent: () => true,
        emit: async () => { original.push({ extra: { media: [{ type: 'image', source: 'generated', url: '/late.png', title: 'Late unrelated evidence' }] } }); },
    });
    assert.equal(prepared.references.length, 3);
    assert.equal(prepared.appearanceContext, undefined);
    assert.ok(!prepared.instruction.includes('Late unrelated evidence'));
});

test('actual foreground normal description modes and BACKGROUND receive context; raw FREE and RAW_LAST remain raw', async () => {
    for (const trigger of ['you', 'me', 'scene', 'last', 'face', 'background']) {
        const f = fixture();
        await f.sandbox.generatePicture('command', {}, trigger);
        assert.match(f.requests[0].quietPrompt, /Black hair/);
        assert.ok(f.context.chat.at(-1).extra.media[0].image_context);
    }
    for (const trigger of ['raw words unchanged', 'raw_last']) {
        const f = fixture();
        await f.sandbox.generatePicture('command', {}, trigger);
        assert.equal(f.requests.length, 0);
        assert.ok(!f.callbacks.includes(IMAGE_CONTEXT_REQUESTED));
        assert.equal(f.context.chat.at(-1).extra.media[0].image_context, undefined);
    }
});

test('captured history survives await; chat switch and swallowed provider error fail closed', async () => {
    const f = fixture({ emitOverride: async (payload, context) => { context.chat.push(...history()); payload.appearanceContext = canonical(); } });
    // A chat length/origin change is also a conflict, not permission to reuse stale input.
    await assert.rejects(f.sandbox.generatePicture('tool', {}, 'image request'), /chat changed/);
    assert.equal(f.requests.length, 0);
    for (const durable of [false, true]) {
        const switched = fixture({ durable, emitOverride: async (_, context) => { context.chatId = 'other'; } });
        await assert.rejects(switched.sandbox.generatePicture('tool', {}, 'image request'), /chat changed/);
        assert.equal(switched.requests.length, 0); assert.equal(switched.jobs.length, 0);
    }
    const eventSource = fs.readFileSync(new URL('../public/lib/eventemitter.js', import.meta.url), 'utf8');
    const events = vm.createContext({ localStorage: { getItem: () => null }, console: { debug: noop, error: noop, trace: noop } });
    vm.runInContext(eventSource.replace(/export\s*\{\s*EventEmitter\s*\}/, ''), events);
    const emitter = vm.runInContext('new EventEmitter()', events);
    emitter.on(IMAGE_CONTEXT_REQUESTED, payload => { payload.error = new Error('Linked lookup failure'); throw payload.error; });
    await assert.rejects(prepareImageContinuity({ chatId: 'original', origin: {}, chat: history(), currentRequest: 'picture', isCurrent: () => true,
        emit: (...args) => emitter.emit(...args) }), /Linked lookup failure/);
});

test('actual failed generation and changed chat after file save create no successful media', async () => {
    const failed = fixture({ fail: true });
    assert.equal(await failed.sandbox.generatePicture('tool', {}, 'image request'), undefined);
    assert.equal(failed.context.chat.length, 3);
    const switched = fixture({ switchOnSave: true });
    await assert.rejects(switched.sandbox.generatePicture('tool', {}, 'image request'), /chat changed/);
    assert.equal(switched.context.chat.length, 3);
});

test('actual durable endpoint success stamps provenance, and failure/cancellation cannot return saved media', async () => {
    const endpoint = fs.readFileSync(new URL('../src/endpoints/generation-jobs.js', import.meta.url), 'utf8');
    const start = endpoint.indexOf('            let reply;');
    const end = endpoint.indexOf('\n        });', start);
    assert.ok(start > 0 && end > start);
    const worker = `async function worker({ signal, update }) {\n${endpoint.slice(start, end)}\n}`;
    for (const outcome of ['success', 'failed', 'cancelled']) {
        const writes = [];
        const abort = new AbortController();
        const metadata = { version: 1, sourceKind: 'requested_prompt', appearanceRevision: 'stable-appearance', referenceIds: ['prior'], sceneLocation: 'Garden', contextCharacterIds: ['hero'] };
        const sandbox = vm.createContext({
            kind: 'image', chatRequest: undefined, image: { prompt: 'black hair', workflow: '{"text":"%prompt%"}', imageContext: metadata },
            message: { name: 'Narrator', extra: {} }, user: { directories: { userImages: '/synthetic/images', root: '/synthetic' } }, id: 'job',
            processImagePrompt: value => value, path, sanitize: value => value, Buffer, structuredClone,
            fs: { mkdirSync: noop }, writeAtomic: (...args) => writes.push(args), clientRelativePath: () => '/image.png',
            runComfyGeneration: async () => { if (outcome === 'failed') throw new Error('Mock failure'); if (outcome === 'cancelled') abort.abort(); return { format: 'png', data: 'cGl4ZWw=' }; },
        });
        vm.runInContext(worker, sandbox);
        if (outcome !== 'success') {
            await assert.rejects(sandbox.worker({ signal: abort.signal, update: async () => {} }));
            assert.equal(writes.length, 0);
        } else {
            const result = await sandbox.worker({ signal: abort.signal, update: async () => {} });
            assert.equal(result.message.extra.image_generation_prompt, result.message.mes);
            assert.deepEqual(result.message.extra.media[0].image_context, metadata);
            assert.equal(result.message.extra.media[0].source, 'generated');
            assert.equal(writes.length, 1);
        }
    }
});
