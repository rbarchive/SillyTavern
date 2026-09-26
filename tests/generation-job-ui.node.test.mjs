import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
// Execute the actual UI entry functions with controlled I/O and delayed hooks.
const source = fs.readFileSync(new URL('../public/script.js', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
function entry(name, context) {
    const start = source.indexOf(`export async function ${name}(`);
    const end = source.indexOf('\n}', start) + 2;
    return vm.runInNewContext(source.slice(start, end).replace('export ', '') + `\n${name}`, context);
}
const job = { id: 'owned', origin: { avatar: 'card.png', file: 'chat', integrity: 'identity' }, result: {} };
function context() {
    const message = { mes: 'answer', extra: { generation_job: 'owned' } };
    return { chat: [message], chat_metadata: { integrity: 'identity' }, characters: [{ avatar: 'card.png', chat: 'chat', name: 'Card' }], this_chid: 0, selected_group: null, isChatSaving: false, this_edit_mes_id: -1,
        cleanUpMessage: ({getMessage}) => getMessage, updateMessageElement() {}, $() {},
        eventSource: { async emit() {} }, event_types: { MESSAGE_RECEIVED: 'received', CHARACTER_MESSAGE_RENDERED: 'rendered' }, async saveChatConditional() {},
        document: { getElementById() { return null; } }, getRequestHeaders() { return {}; }, ensureMessageMediaIsArray() {}, async redisplayChat() {},
    };
}
test('switching during completion hooks defers processing and skips foreign hooks/save', async () => {
    const c = context(); let saved = 0; const events = [];
    c.saveChatConditional = async () => { saved++; };
    c.eventSource.emit = async event => { events.push(event); c.chat.splice(0, 1, { mes: 'other chat', extra: {} }); };
    assert.equal(await entry('applyGenerationJobResult', c)(job), false);
    assert.deepEqual(events, ['received']); assert.equal(saved, 0);
    assert.equal(c.chat[0].extra.generation_job_processed, undefined);
});
test('completion save failure clears processing flag and permits retry', async () => {
    const c = context(); const apply = entry('applyGenerationJobResult', c);
    c.saveChatConditional = async options => { assert.equal(options.throwOnError, true); throw new Error('offline'); };
    await assert.rejects(apply(job), /offline/);
    assert.equal(c.chat[0].extra.generation_job_processed, undefined);
    c.saveChatConditional = async () => {};
    assert.equal(await apply(job), true); assert.equal(c.chat[0].extra.generation_job_processed, true);
});
test('authoritative snapshot cannot replace a switched or edited chat during fetch', async () => {
    for (const change of [c => { c.characters[0].chat = 'other'; }, c => { c.chat[0].mes = 'edited'; }]) {
        const c = context(); let rendered = 0;
        c.redisplayChat = async () => { rendered++; };
        c.fetch = async () => { change(c); return { ok: true, async json() { return [{ chat_metadata: { integrity: 'identity' } }, { mes: 'generated', extra: { generation_job: 'owned' } }]; } }; };
        assert.equal(await entry('loadGenerationJobResult', c)(job), false);
        assert.equal(rendered, 0); assert.notEqual(c.chat[0].mes, 'generated');
    }
});
test('authoritative deletion stays deleted and completion never reinserts receipt message', async () => {
    const c = context(); let rendered = 0;
    c.fetch = async () => ({ ok: true, async json() { return [{ chat_metadata: { integrity: 'identity', generation_revision: 'owned' } }]; } });
    c.redisplayChat = async () => { rendered++; };
    assert.equal(await entry('loadGenerationJobResult', c)(job), true);
    assert.equal(c.chat.length, 0); assert.equal(rendered, 1);
    assert.equal(await entry('applyGenerationJobResult', c)({ ...job, message: { mes: 'never resurrect' } }), true);
    assert.equal(c.chat.length, 0);
});


test('recovery with two completions defers both after switching during the first hook', async () => {
    const browserSource = fs.readFileSync(new URL('../public/scripts/generation-jobs.js', import.meta.url), 'utf8');
    const start = browserSource.indexOf('async function recoverGenerationJobs(');
    const end = browserSource.indexOf('\n}', start) + 2;
    let current = 'A', calls = 0;
    const observed = new Set();
    const c = { recovering: false, document: { hidden: false, querySelector: () => null }, observed, waiting: new Set(), terminal: new Set(['completed']), is_send_press: false,
        request: async () => [{ id: 'first', origin: { file: 'A' }, status: 'completed' }, { id: 'second', origin: { file: 'A' }, status: 'completed' }],
        sameOrigin: origin => origin.file === current, chat: [], clearPreview() {}, loadGenerationJobResult: async () => true,
        applyGenerationJobResult: async () => { calls++; current = 'B'; return false; }, console,
    };
    const recover = vm.runInNewContext(browserSource.slice(start, end) + '\nrecoverGenerationJobs', c);
    await recover();
    assert.equal(calls, 1); assert.equal(observed.size, 0);
});


test('image completion retains the already rendered image without a second media rebuild', async () => {
    const c = context(); let rebuilt = 0;
    c.updateMessageElement = () => { rebuilt++; };
    assert.equal(await entry('applyGenerationJobResult', c)({ ...job, result: { path: '/user/images/test.png' } }), true);
    assert.equal(rebuilt, 0); assert.equal(c.chat[0].extra.generation_job_processed, true);
});
