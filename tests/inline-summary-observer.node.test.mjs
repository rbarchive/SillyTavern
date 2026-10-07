import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { correctKoreanDialogueDisplay } from '../public/scripts/korean-dialogue-display.js';
import { generationProgressDisplay, visibleGenerationJobs } from '../public/scripts/generation-progress-display.js';

const source = fs.readFileSync(new URL('../public/scripts/generation-jobs.js', import.meta.url), 'utf8');
const start = source.indexOf('const terminal = new Set');
const end = source.indexOf('\nexport function initializeGenerationJobs', start);
const observerSource = source.slice(start, end)
    .replaceAll('export function ', 'function ')
    .replaceAll('export async function ', 'async function ')
    .replace('const pause = (ms = 1000) => new Promise(resolve => setTimeout(resolve, ms));', 'const pause = async () => {};');

function makeContext({ post, polls = [], signal = null }) {
    const origin = { avatar: 'card.png', file: 'chat', integrity: 'identity' };
    const calls = { load: 0, apply: 0, pause: 0, cancel: 0 };
    const logs = [];
    const context = {
        correctKoreanDialogueDisplay, generationProgressDisplay, visibleGenerationJobs,
        uuidv4: () => 'job-1',
        getRequestHeaders: () => ({}),
        characters: [{ avatar: origin.avatar, chat: origin.file, name: 'Card' }], this_chid: 0,
        chat: [{ extra: { generation_job: 'job-1' } }], chat_metadata: { integrity: origin.integrity },
        selected_group: null, groups: [], is_send_press: false,
        loadGenerationJobResult: async () => { calls.load++; return true; },
        applyGenerationJobResult: async () => { calls.apply++; return true; },
        eventSource: {}, event_types: {},
        failureNotices: () => new Set(), generationFailureMessage: value => value,
        performance: { now: () => 0 }, console: { ...console, info: (...args) => logs.push(args) },
        document: { hidden: true, querySelector: () => null, getElementById: () => null },
        window: { sessionStorage: null },
        fetch: async (url, options) => {
            if (url.endsWith('/cancel')) { calls.cancel++; return { ok: true, async json() { return { ...post, status: 'cancelled' }; } }; }
            if (options?.method === 'POST') return { ok: true, async json() { return post; } };
            const next = polls.shift() ?? post;
            return { ok: true, async json() { return next; } };
        },
    };
    const observedSignal = signal || { aborted: false, addEventListener() {}, removeEventListener() {} };
    const exports = vm.runInNewContext(`${observerSource}\n({ runGenerationJob })`, { ...context, signal: observedSignal });
    return { run: exports.runGenerationJob, context, calls, origin, signal: observedSignal, logs };
}

test('pending summary receipt resolves immediately and applies once without polling', async () => {
    const post = { id: 'job-1', status: 'running', dialogueReady: true, sessionSummary: { status: 'pending' }, origin: { avatar: 'card.png', file: 'chat', integrity: 'identity' }, operation: 'append' };
    const f = makeContext({ post });
    const result = await f.run({ origin: f.origin, kind: 'chat' });
    assert.equal(result.dialogueReady, true);
    assert.equal(f.calls.load, 1);
    assert.equal(f.calls.apply, 1);
    assert.equal(f.calls.cancel, 0);
});

test('ordinary running receipt polls until completed before applying', async () => {
    const running = { id: 'job-1', status: 'running', dialogueReady: false, origin: { avatar: 'card.png', file: 'chat', integrity: 'identity' }, operation: 'append' };
    const completed = { ...running, status: 'completed', result: {} };
    const f = makeContext({ post: running, polls: [completed] });
    const result = await f.run({ origin: f.origin, kind: 'chat' });
    assert.equal(result.status, 'completed');
    assert.equal(f.calls.load, 1);
    assert.equal(f.calls.apply, 1);
});

test('abort listener is removed after return and does not issue a late cancellation', async () => {
    const post = { id: 'job-1', status: 'running', dialogueReady: true, sessionSummary: { status: 'pending' }, origin: { avatar: 'card.png', file: 'chat', integrity: 'identity' }, operation: 'append' };
    let listener; let removed = false;
    const signal = { aborted: false, addEventListener(_name, callback) { listener = callback; }, removeEventListener() { removed = true; listener = null; } };
    const f = makeContext({ post, signal });
    await f.run({ origin: f.origin, kind: 'chat' }, signal);
    assert.equal(removed, true);
    signal.aborted = true;
    listener?.();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.calls.cancel, 0);
});

test('visible connected preview records DOM and render opportunity once without changing completion', async () => {
    const running = { id: 'job-1', status: 'running', preview: '첫 대사', origin: { avatar: 'card.png', file: 'chat', integrity: 'identity' }, operation: 'append' };
    const completed = { ...running, status: 'completed', result: {} };
    const f = makeContext({ post: running, polls: [running, completed] });
    let element;
    const container = { scrollHeight: 100, scrollTop: 0, clientHeight: 100, append(value) { element = value; value.isConnected = true; } };
    const status = { dataset: {}, append() {} };
    f.context.document.querySelector = selector => selector === '#background_generation_status' ? status : container;
    f.context.document.createTextNode = text => text;
    f.context.document.getElementById = () => element;
    f.context.document.createElement = () => ({ style: {}, append() {}, setAttribute() {}, remove() { this.isConnected = false; element = null; } });
    f.context.window.requestAnimationFrame = callback => callback();
    const result = await f.run({ origin: f.origin, kind: 'chat' }, f.signal, () => { f.context.document.hidden = false; });
    assert.equal(result.status, 'completed');
    assert.equal(f.logs.filter(row => row[0] === 'Generation first preview DOM (milliseconds)').length, 1);
    assert.equal(f.logs.filter(row => row[0] === 'Generation first preview render opportunity (milliseconds)').length, 1);
    assert.equal(f.calls.apply, 1);
});
