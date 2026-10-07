import test from 'node:test';
import assert from 'node:assert/strict';
import { countLocalMessages, generateLocalWithProgress } from '../src/endpoints/backends/local-model-progress.js';

const params = { messages: [{ role: 'user', content: 'hello' }], model: 'local' };
function fakeModel(run, result = {}) {
    return { respond(messages, config) {
        assert.deepEqual(messages, params.messages);
        return {
            async *[Symbol.asyncIterator]() { yield* run(config); },
            then(resolve, reject) { return Promise.resolve({ content: 'Hello', stats: { stopReason: 'eosFound', promptTokensCount: 10000, predictedTokensCount: 2, totalTokensCount: 10002 }, predictionConfig: { fields: [{ key: 'llm.prediction.reasoning.enableThinking', value: false }] }, ...result }).then(resolve, reject); },
        };
    } };
}

test('real input fractions precede visible body timestamps and usage preserves cached tokens', async () => {
    const events = [];
    let clock = 100;
    const model = fakeModel(async function* (config) {
        for (const fraction of [0, 0.5, 1]) {
            clock += 100;
            config.onPromptProcessingProgress(fraction, { cachedTokenCount: 1000, totalPromptTokenCount: 10000, processedPromptTokenCount: fraction * 9000 });
        }
        assert.equal(events.some(e => e.streamMetrics?.firstContentAt !== undefined), false);
        yield { content: '<think>', isStructural: true };
        yield { content: '</think>', isStructural: true };
        yield { content: 'Hello', reasoningType: 'none' };
    });
    const result = await generateLocalWithProgress(params, { model, now: () => clock, onProgress: e => events.push(e) });
    assert.deepEqual(events.filter(e => e.reading).map(e => e.inputProgress.fraction), [0, 0.5, 1]);
    assert.equal(events.filter(e => e.reading).every(e => e.longReadPossible), true);
    for (const event of ['firstContent', 'firstToken', 'firstVisible', 'serverFirstVisible']) assert.equal(events.filter(e => e.event === event).length, 1);
    assert.equal(result.streamMetrics.firstContentAt, 400);
    assert.equal(result.choices[0].finish_reason, 'stop');
    assert.equal(result.choices[0].message.content, 'Hello');
    assert.deepEqual(result.usage, { prompt_tokens: 10000, completion_tokens: 2, total_tokens: 10002, prompt_tokens_details: { cached_tokens: 1000 } });
});

test('missing and invalid progress counts stay unknown while valid fraction is preserved', async () => {
    const events = [];
    const model = fakeModel(async function* (config) {
        config.onPromptProcessingProgress(0.5, { cachedTokenCount: -1, totalPromptTokenCount: NaN, processedPromptTokenCount: 1.2 });
        config.onPromptProcessingProgress(2);
        yield { content: 'Hello' };
    });
    await generateLocalWithProgress(params, { model, onProgress: e => events.push(e) });
    assert.deepEqual(events.filter(e => e.reading).map(e => e.inputProgress), [{ fraction: 0.5 }, {}]);
    assert.equal(events.some(e => e.longReadPossible), false);
});

test('sampling is explicit and never forces a schema or an unsupported seed', async () => {
    let captured;
    const model = fakeModel(async function* (config) { captured = config; yield { content: 'Hello' }; });
    const result = await generateLocalWithProgress({ ...params, temperature: 0.7, top_p: 0.8, presence_penalty: 0.2, top_k: 20, seed: 17, stop: ['END'] }, { model, repeatPenalty: 1.1 });
    assert.deepEqual([captured.maxTokens, captured.enableThinking, captured.temperature, captured.topPSampling, captured.presencePenalty, captured.topKSampling, captured.repeatPenalty, captured.stopStrings], [8192, false, 0.7, 0.8, 0.2, 20, 1.1, ['END']]);
    assert.equal('structured' in captured, false);
    assert.equal('raw' in captured, false);
    assert.equal(result.sampling.seed.applied, false);
    await assert.rejects(generateLocalWithProgress({ ...params, response_format: { type: 'json_object' } }, { model }), /structured/);
});

test('empty thinking prefill is removed, actual reasoning and unconfirmed config fail', async () => {
    let model = fakeModel(async function* () { yield { content: '<think></think></think>Hello' }; });
    assert.equal((await generateLocalWithProgress(params, { model })).choices[0].message.content, 'Hello');
    model = fakeModel(async function* () { yield { content: 'secret', reasoningType: 'reasoning' }; });
    await assert.rejects(generateLocalWithProgress(params, { model }), /returned reasoning/);
    model = fakeModel(async function* () { yield { content: '<think>secret</think>Hello' }; });
    await assert.rejects(generateLocalWithProgress(params, { model }), /returned reasoning/);
    model = fakeModel(async function* () { yield { content: 'Hello' }; }, { predictionConfig: { enableThinking: true } });
    await assert.rejects(generateLocalWithProgress(params, { model }), /did not confirm/);
});

test('abort and provider read errors propagate without successful completion', async () => {
    const controller = new AbortController();
    const model = fakeModel(async function* () { controller.abort(); yield { content: 'Hello' }; });
    await assert.rejects(generateLocalWithProgress(params, { model, signal: controller.signal }), { name: 'AbortError' });
    const failure = new Error('read failed');
    const broken = fakeModel(async function* () { throw failure; });
    await assert.rejects(generateLocalWithProgress(params, { model: broken }), error => error === failure);
});

test('no-body fallback and length completion remain honest', async () => {
    const events = [];
    const model = fakeModel(async function* () {}, { content: '</think>Hello', stats: { stopReason: 'maxPredictedTokensReached' } });
    const result = await generateLocalWithProgress(params, { model, onProgress: e => events.push(e) });
    assert.equal(result.choices[0].finish_reason, 'length');
    assert.equal(result.choices[0].message.content, 'Hello');
    assert.equal(events.filter(e => e.event === 'firstToken').length, 1);
    assert.deepEqual(result.usage, {});
});

test('prompt counting uses the loaded model template and propagates counting failures', async () => {
    const model = { async applyPromptTemplate(messages) { assert.deepEqual(messages, params.messages); return 'formatted'; }, async countTokens(text) { assert.equal(text, 'formatted'); return 19; } };
    assert.equal(await countLocalMessages(params.messages, { model }), 19);
    await assert.rejects(countLocalMessages(params.messages, { model: { ...model, countTokens: async () => -1 } }), /invalid/);
});

test('non-local endpoints are rejected before SDK import', async () => {
    await assert.rejects(countLocalMessages(params.messages, { baseUrl: 'ws://example.com:9998', sdkPath: '/does/not/exist.mjs', modelId: 'local' }), /localhost/);
});
