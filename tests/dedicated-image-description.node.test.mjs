import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { runDedicatedImageDescription, validateDescriptionSettings } from '../src/endpoints/backends/dedicated-image-description.js';
import { ensureLmStudioContext, withLmStudioImageModel } from '../src/endpoints/backends/lmstudio-context.js';
const settings = { mode: 'dedicated', url: 'http://localhost:9998/v1', model: 'gemma', context_length: 8192, max_tokens: 512 };
function provider({ ready = true, output = 'English gray coat portrait', finish = 'stop' } = {}) {
    const state = new Map([['main', { context_length: 32768 }], ...(ready ? [['gemma', { context_length: 8192 }]] : [])]);
    const calls = [];
    const fetchImpl = async (url, options = {}) => {
        const route = new URL(url).pathname, body = options.body && JSON.parse(options.body); calls.push({ route, body, headers: options.headers });
        if (route.endsWith('/unload')) { state.delete(body.instance_id); return { ok: true, json: async () => ({}) }; }
        if (route.endsWith('/load')) { state.set(body.model, { context_length: body.context_length }); return { ok: true, json: async () => ({ status: 'loaded', load_config: state.get(body.model) }) }; }
        if (route.endsWith('/models')) return { ok: true, json: async () => ({ models: ['main', 'gemma', 'next'].map(key => ({ type: 'llm', key, max_context_length: 32768, loaded_instances: state.has(key) ? [{ id: key, config: state.get(key) }] : [] })) }) };
        if (route.endsWith('/chat/completions')) return { ok: true, headers: { get: () => 'text/event-stream' }, body: Readable.from([Buffer.from(`data: ${JSON.stringify({ model: body.model, choices: [{ delta: { content: output }, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`)]) };
        throw Error('Unexpected route '+route);
    };
    return { state, calls, fetchImpl };
}
test('dedicated image params retain all facts and ignore main URL, secrets, YAML and penalties', async () => {
    const api = provider(); const source = [{ role: 'system', content: 'World: green roof. Never output English.' }, { role: 'user', content: '현재: 갈색 머리, 회색 코트.' }];
    const input = { messages: source, custom_url: 'http://wrong', model: 'main', secret_id: 'private', custom_include_headers: 'Authorization: private', custom_include_body: 'model: main\nmax_tokens: 9000', frequency_penalty: 8 };
    const before = structuredClone(input);
    const reply = await runDedicatedImageDescription(input, settings, undefined, undefined, { fetchImpl: api.fetchImpl });
    const request = api.calls.find(c => c.route.endsWith('/chat/completions'));
    assert.equal(reply.model, 'gemma'); assert.equal(request.body.model, 'gemma'); assert.equal(request.body.max_tokens, 512);
    assert.equal(request.body.frequency_penalty, 0); assert.equal(request.body.reasoning_effort, 'none'); assert.equal(request.headers.Authorization, undefined);
    assert.match(request.body.messages[1].content, /green roof/); assert.match(request.body.messages[1].content, /회색 코트/); assert.match(request.body.messages[1].content, /Output English only/);
    assert.deepEqual(input, before); assert.equal(api.calls.filter(c => c.route.endsWith('/unload')).length, 0); assert.equal(api.state.get('main').context_length, 32768);
});
test('additive load is shared by simultaneous requests and never unloads main', async () => {
    const api = provider({ ready: false });
    await Promise.all([1,2].map(() => withLmStudioImageModel({ baseUrl: settings.url, model: 'gemma', contextLength: 8192, fetchImpl: api.fetchImpl }, async id => assert.equal(id, 'gemma'))));
    assert.equal(api.calls.filter(c => c.route.endsWith('/load')).length, 1); assert.equal(api.calls.filter(c => c.route.endsWith('/unload')).length, 0); assert.ok(api.state.has('main'));
});
test('destructive model switch waits until dedicated response finishes, including failure', async () => {
    for (const reject of [false,true]) {
        const api = provider(); let release, started; const gate = new Promise(r => release = r), begun = new Promise(r => started = r);
        const image = withLmStudioImageModel({ baseUrl: settings.url, model: 'gemma', contextLength: 8192, fetchImpl: api.fetchImpl }, async () => { started(); await gate; if(reject)throw Error('failed stream'); });
        await begun;
        const change = ensureLmStudioContext({ baseUrl: settings.url+'/', model: 'next', contextLength: 8192, fetchImpl: api.fetchImpl });
        await new Promise(r => setImmediate(r)); assert.equal(api.calls.filter(c => c.route.endsWith('/unload')).length, 0);
        const checked = reject ? assert.rejects(image,/failed stream/) : image;
        release(); await checked; await change; assert.ok(api.calls.some(c => c.route.endsWith('/unload')));
    }
});
test('ordinary model reuse preserves co-resident description model', async () => {
    const api = provider(); await ensureLmStudioContext({ baseUrl: settings.url, model: 'main', contextLength: 32768, fetchImpl: api.fetchImpl });
    assert.ok(api.state.has('gemma')); assert.equal(api.calls.filter(c => c.route.endsWith('/unload')).length, 0);
});
test('insufficient already-loaded context and invalid settings fail without unload', async () => {
    const api = provider(); await assert.rejects(withLmStudioImageModel({ baseUrl: settings.url, model: 'gemma', contextLength: 16384, fetchImpl: api.fetchImpl },()=>{}), /컨텍스트가 부족/);
    assert.equal(api.calls.filter(c => c.route.endsWith('/unload')).length, 0);
    for(const patch of [{url:'http://a/api'},{url:'http://secret:password@a/v1'},{context_length:0},{max_tokens:99999},{model:''}]) assert.throws(()=>validateDescriptionSettings({...settings,...patch}));
});
test('empty/reasoning-only, truncated and non-English replies cannot become image prompts', async () => {
    for(const [output,finish] of [['<think>only reasoning</think>','stop'],['English fragment','length'],['회색 코트','stop'],['😀','stop'],['Серое пальто','stop']]) {
        const api = provider({output,finish}); await assert.rejects(runDedicatedImageDescription({messages:[{role:'user',content:'portrait'}]},settings,undefined,undefined,{fetchImpl:api.fetchImpl}));
    }
});
