import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createLocalImageRuntime, createComfyProcess, comfyModeArgs, boostPreference } from '../src/local-image-runtime.js';
import { imageBoostEnabled } from '../public/scripts/extensions/stable-diffusion/image-boost-settings.js';

const source = 'http://127.0.0.1:8188';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture() {
    const events = []; let running = false;
    const backend = { url: 'http://127.0.0.1:8190', alive: () => running,
        async start(mode) { events.push(['start', mode]); running = true; },
        async idle() { events.push(['idle']); }, async stop() { events.push(['stop']); running = false; } };
    return { events, backend, runtime: createLocalImageRuntime({ enabled: true, sourceUrl: source }, backend) };
}
test('default ON and persisted OFF use only the measured flags', () => {
    assert.equal(imageBoostEnabled({}), true); assert.equal(imageBoostEnabled({ comfy_boost: false }), false);
    assert.equal(boostPreference(undefined), true); assert.throws(() => boostPreference('false'));
    assert.deepEqual(comfyModeArgs(true), ['--use-pytorch-cross-attention']);
    assert.deepEqual(comfyModeArgs(false), ['--cache-none']);
});
test('idle toggle changes only owned process and reports readiness after startup', async () => {
    const { events, runtime } = fixture();
    assert.equal(runtime.status(source).ready, false);
    assert.equal((await runtime.apply(source, true)).applied, true);
    assert.equal((await runtime.apply(source, false)).applied, false);
    assert.deepEqual(events, [['start', true], ['idle'], ['stop'], ['start', false]]);
    await runtime.close(); assert.equal(runtime.status(source).ready, false);
});
test('cancel/disconnect cannot release active inference; captured queued ON/OFF/ON modes retain ordering', async () => {
    const { events, runtime } = fixture(); const entered = deferred(); const finished = deferred();
    const cancel = new AbortController();
    const first = runtime.run(source, true, cancel.signal, async (url, signal) => {
        assert.equal(url, 'http://127.0.0.1:8190'); assert.equal(signal, undefined);
        events.push(['image', true]); entered.resolve(); await finished.promise; events.push(['completed']); return 'image';
    });
    await entered.promise;
    const second = runtime.run(source, false, undefined, async () => { events.push(['image', false]); });
    const third = runtime.run(source, true, undefined, async () => { events.push(['image', true]); });
    cancel.abort(); await Promise.resolve();
    assert.equal(runtime.status(source).applied, true); assert.equal(runtime.status(source).pending, 2);
    assert.ok(!events.some(event => event[0] === 'stop'));
    finished.resolve(); assert.equal(await first, 'image'); await second; await third;
    assert.deepEqual(events, [['start', true], ['image', true], ['completed'], ['idle'], ['stop'], ['start', false], ['image', false], ['idle'], ['stop'], ['start', true], ['image', true]]);
    await runtime.close();
});
test('queued cancellation does not invoke provider and graceful shutdown drains work', async () => {
    const { runtime } = fixture(); const entered = deferred(); const finished = deferred();
    const first = runtime.run(source, true, undefined, async () => { entered.resolve(); await finished.promise; });
    await entered.promise; const cancel = new AbortController(); let invoked = false;
    const queued = runtime.run(source, false, cancel.signal, async () => { invoked = true; });
    const rejected = assert.rejects(queued, /abort/i); cancel.abort();
    const close = runtime.close();
    await assert.rejects(runtime.apply(source, false), /종료 중/);
    assert.equal(runtime.status(source).ready, true);
    finished.resolve(); await first; await rejected; await close;
    assert.equal(invoked, false); assert.equal(runtime.status(source).ready, false);
});
test('failed launch is visible without fallback and subsequent valid attempt recovers', async () => {
    const { runtime, backend } = fixture(); const start = backend.start; let fail = true;
    backend.start = async mode => { if (fail) throw new Error('launch failed'); return start(mode); };
    let called = false;
    await assert.rejects(runtime.run(source, true, undefined, async () => { called = true; }), /launch failed/);
    assert.equal(called, false); assert.equal(runtime.status(source).ready, false); assert.equal(runtime.status(source).error, 'launch failed');
    fail = false; await runtime.apply(source, true); assert.equal(runtime.status(source).error, null);
    await runtime.close();
});
test('failed idle check refuses restart after a provider poll error', async () => {
    const { runtime, events, backend } = fixture(); await runtime.apply(source, true);
    backend.idle = async () => { throw new Error('queue unknown'); };
    await assert.rejects(runtime.apply(source, false), /queue unknown/);
    assert.equal(events.filter(e => e[0] === 'stop').length, 0); assert.equal(runtime.status(source).applied, true);
    backend.idle = async () => {}; await runtime.close();
});
test('remote and disabled connections remain unmanaged and cannot supply process arguments', async () => {
    const { runtime } = fixture(); assert.equal(runtime.supports('http://user:pass@localhost:8188'), false);
    assert.equal(runtime.supports('http://127.0.0.1:8188/other'), false);
    assert.equal(runtime.supports('http://localhost:8188/'), true);
    const remote = 'http://example.org:8188'; const signal = new AbortController().signal;
    await runtime.run(remote, true, signal, async (url, actual) => { assert.equal(url, remote); assert.equal(actual, signal); });
    await assert.rejects(runtime.apply(remote, true));
    assert.equal(createLocalImageRuntime().status(source).supported, false);
    assert.throws(() => createLocalImageRuntime({ enabled: true, sourceUrl: remote }));
    await runtime.close();
});
test('occupied port is never adopted, queried or killed', async () => {
    const server = net.createServer(socket => socket.end()).listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    try {
        const backend = createComfyProcess({ sourceUrl: source, port: server.address().port,
            python: '/not/executed', main: '/not/executed.py', modelPaths: '/not/read', dataDirectory: '/not/created' });
        await assert.rejects(backend.start(true), /포트가 사용 중/);
        assert.equal(backend.alive(), false); assert.equal(server.listening, true);
    } finally { await new Promise(resolve => server.close(resolve)); }
});
