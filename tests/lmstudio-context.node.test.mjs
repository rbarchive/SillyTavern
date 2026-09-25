import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ensureLmStudioContext } from '../src/endpoints/backends/lmstudio-context.js';

function server({ contextLength = 4096, failLoad = false, model = 'story-model' } = {}) {
    let loaded = contextLength;
    const calls = [];
    const fetchImpl = async (url, options) => {
        const path = new URL(url).pathname;
        const body = options.body && JSON.parse(options.body);
        calls.push({ path, body });
        if (path === '/api/v1/models') {
            return { ok: true, json: async () => ({ models: [{
                type: 'llm', key: model, max_context_length: 65536,
                loaded_instances: loaded ? [{ id: model, config: { context_length: loaded, flash_attention: true } }] : [],
            }] }) };
        }
        if (path === '/api/v1/models/unload') {
            loaded = 0;
            return { ok: true, json: async () => ({ instance_id: body.instance_id }) };
        }
        if (path === '/api/v1/models/load') {
            if (failLoad && body.context_length === 32768) return { ok: false, status: 500 };
            loaded = body.context_length;
            return { ok: true, json: async () => ({ status: 'loaded', load_config: { context_length: loaded } }) };
        }
        throw new Error(`Unexpected request: ${path}`);
    };
    return { fetchImpl, calls, get loaded() { return loaded; } };
}

const options = { baseUrl: 'http://127.0.0.1:9998/v1', model: 'story-model', contextLength: 32768 };

test('reloads a short-context model with the ST Context value', async () => {
    const api = server();
    await ensureLmStudioContext({ ...options, fetchImpl: api.fetchImpl });
    assert.equal(api.loaded, 32768);
    assert.deepEqual(api.calls.map(call => call.path), [
        '/api/v1/models', '/api/v1/models/unload', '/api/v1/models/load',
    ]);
    assert.deepEqual(api.calls[1].body, { instance_id: 'story-model' });
    assert.equal(api.calls[2].body.context_length, 32768);
    assert.equal(api.calls[2].body.flash_attention, true);
});

test('keeps a model that already has enough context', async () => {
    const api = server({ contextLength: 40960 });
    await ensureLmStudioContext({ ...options, fetchImpl: api.fetchImpl });
    assert.deepEqual(api.calls.map(call => call.path), ['/api/v1/models']);
});

test('loads an unloaded model at the requested context length', async () => {
    const api = server({ contextLength: 0 });
    await ensureLmStudioContext({ ...options, fetchImpl: api.fetchImpl });
    assert.deepEqual(api.calls.map(call => call.path), ['/api/v1/models', '/api/v1/models/load']);
    assert.equal(api.loaded, 32768);
});

test('restores the previous context when the larger load fails', async () => {
    const api = server({ failLoad: true });
    await assert.rejects(ensureLmStudioContext({ ...options, fetchImpl: api.fetchImpl }), /HTTP 500/);
    assert.equal(api.loaded, 4096);
    assert.equal(api.calls.at(-1).body.context_length, 4096);
});

test('rejects a non-LM Studio base path before any request', async () => {
    const api = server();
    await assert.rejects(ensureLmStudioContext({ ...options, baseUrl: 'http://127.0.0.1:9998/api', fetchImpl: api.fetchImpl }), /\/v1/);
    assert.equal(api.calls.length, 0);
});

test('rejects a model above its supported maximum without unloading', async () => {
    const api = server();
    await assert.rejects(ensureLmStudioContext({ ...options, contextLength: 131072, fetchImpl: api.fetchImpl }), /exceeds/);
    assert.deepEqual(api.calls.map(call => call.path), ['/api/v1/models']);
});

test('serializes simultaneous loads for the same model', async () => {
    const api = server();
    await Promise.all([
        ensureLmStudioContext({ ...options, fetchImpl: api.fetchImpl }),
        ensureLmStudioContext({ ...options, fetchImpl: api.fetchImpl }),
    ]);
    assert.equal(api.calls.filter(call => call.path === '/api/v1/models/unload').length, 1);
});
