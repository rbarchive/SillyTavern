import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { visibleGenerationText } from './generation-stream.js';

const handles = new Map();
const validCount = value => Number.isSafeInteger(value) && value >= 0;

async function localModel({ sdkPath, baseUrl, modelId, model }) {
    if (model) return model;
    const url = new URL(baseUrl);
    if (url.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
        || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
        throw new Error('Local model progress requires a localhost WebSocket endpoint.');
    }
    if (typeof modelId !== 'string' || !modelId.trim()) throw new Error('A loaded local model identifier is required.');
    if (typeof sdkPath !== 'string' || !isAbsolute(sdkPath) || !/\.(?:mjs|js)$/.test(sdkPath)
        || !(await stat(sdkPath)).isFile()) throw new Error('An existing absolute LM Studio SDK module path is required.');
    const key = JSON.stringify([sdkPath, url.href, modelId]);
    if (!handles.has(key)) {
        const pending = import(pathToFileURL(sdkPath).href).then(({ LMStudioClient }) => {
            const client = new LMStudioClient({ baseUrl: url.href.replace(/\/$/, '') });
            return { client, model: client.llm.createDynamicHandle(modelId) };
        });
        handles.set(key, pending);
        pending.catch(() => { if (handles.get(key) === pending) handles.delete(key); });
    }
    return (await handles.get(key)).model;
}

/** Count the selected loaded model's formatted chat prompt without generating. */
export async function countLocalMessages(messages, options = {}) {
    const model = await localModel(options);
    const count = await model.countTokens(await model.applyPromptTemplate(messages));
    if (!validCount(count)) throw new Error('Local model returned an invalid prompt token count.');
    return count;
}

function checkThinking(config) {
    if (config === undefined || config === null) return;
    const field = config.fields?.find(entry => ['reasoning.enableThinking', 'llm.prediction.reasoning.enableThinking'].includes(entry.key));
    if ((field ? field.value : config.enableThinking) !== false) {
        throw new Error('Local model did not confirm that thinking was disabled.');
    }
}

/** Reuse a loaded model and expose real prompt processing and visible output timing. */
export async function generateLocalWithProgress(params, options = {}) {
    const { signal, onProgress = () => {}, repeatPenalty = 1, now = Date.now } = options;
    signal?.throwIfAborted();
    if (params.response_format !== undefined || params.structured !== undefined) {
        throw new Error('Native local generation does not support structured response formats.');
    }
    const model = await localModel(options);
    signal?.throwIfAborted();
    const metrics = { requestedAt: now() };
    let content = '', cachedTokens, lastPreviewAt, lastPreview = '';
    const emitVisible = () => {
        const preview = visibleGenerationText(content).replace(/^\s*<\/think>\s*/, '').slice(-32000);
        if (!preview) return;
        const receivedAt = now();
        if (metrics.firstContentAt === undefined) {
            onProgress({ reading: false });
            metrics.firstContentAt = receivedAt;
            metrics.serverFirstVisibleAt = receivedAt;
            for (const event of ['firstContent', 'firstToken', 'firstVisible', 'serverFirstVisible']) {
                onProgress({ event, receivedAt, streamMetrics: { ...metrics }, preview, received: content.length });
            }
        }
        if (preview !== lastPreview && (lastPreviewAt === undefined || receivedAt - lastPreviewAt >= 200)) {
            onProgress({ preview, received: content.length, lastVisibleAt: receivedAt });
            lastPreviewAt = receivedAt;
            lastPreview = preview;
        }
    };
    const config = {
        maxTokens: 8192, enableThinking: false,
        temperature: params.temperature ?? 0,
        topPSampling: params.top_p ?? 1,
        presencePenalty: params.presence_penalty ?? 0,
        repeatPenalty, signal,
        onPromptProcessingProgress(fraction, details = {}) {
            const inputProgress = {};
            if (Number.isFinite(fraction) && fraction >= 0 && fraction <= 1) inputProgress.fraction = fraction;
            for (const [source, target] of [['cachedTokenCount', 'cachedTokens'], ['totalPromptTokenCount', 'totalTokens'], ['processedPromptTokenCount', 'processedTokens']]) {
                if (validCount(details[source])) inputProgress[target] = details[source];
            }
            if (validCount(inputProgress.cachedTokens)) cachedTokens = inputProgress.cachedTokens;
            const uncached = inputProgress.totalTokens - inputProgress.cachedTokens;
            onProgress({ reading: true, inputProgress, ...(Number.isFinite(uncached) && uncached > 4096 ? { longReadPossible: true } : {}) });
        },
    };
    if (params.top_k !== undefined) config.topKSampling = params.top_k;
    if (params.stop !== undefined) config.stopStrings = typeof params.stop === 'string' ? [params.stop] : params.stop;
    const prediction = model.respond(params.messages, config);
    metrics.responseReceivedAt = now();
    onProgress({ event: 'streamMetrics', streamMetrics: { ...metrics }, preview: '' });
    try {
        for await (const fragment of prediction) {
            signal?.throwIfAborted();
            if (fragment.isStructural || typeof fragment.content !== 'string') continue;
            if (fragment.reasoningType === 'reasoning' && fragment.content.trim()) throw new Error('Local non-thinking generation returned reasoning.');
            content += fragment.content;
            emitVisible();
        }
    } catch (error) {
        // Cancel this prediction only; retain the reusable client and loaded model.
        try { await prediction.cancel?.(); } catch { /* Preserve the original failure. */ }
        throw error;
    }
    const result = await prediction;
    signal?.throwIfAborted();
    checkThinking(result.predictionConfig);
    if (!content && typeof result.content === 'string') { content = result.content; emitVisible(); }
    if (result.reasoningContent?.trim() || [...content.matchAll(/<think>([\s\S]*?)(?:<\/think>|$)/g)].some(match => match[1].trim())) {
        throw new Error('Local non-thinking generation returned reasoning.');
    }
    content = visibleGenerationText(content).replace(/^\s*<\/think>\s*/, '');
    const stats = result.stats || {};
    let finishReason;
    switch (stats.stopReason) {
        case 'eosFound': case 'stopStringFound': finishReason = 'stop'; break;
        case 'maxPredictedTokensReached': case 'contextLengthReached': finishReason = 'length'; break;
        case 'userStopped': throw new DOMException('Local generation was canceled.', 'AbortError');
        case 'failed': case 'modelUnloaded': case 'toolCalls': throw new Error(`Local generation ended with ${stats.stopReason}.`);
        default: finishReason = null;
    }
    const usage = {};
    for (const [source, target] of [['promptTokensCount', 'prompt_tokens'], ['predictedTokensCount', 'completion_tokens'], ['totalTokensCount', 'total_tokens']]) {
        if (validCount(stats[source])) usage[target] = stats[source];
    }
    if (validCount(cachedTokens)) usage.prompt_tokens_details = { cached_tokens: cachedTokens };
    metrics.completedAt = now();
    onProgress({ event: 'streamMetrics', streamMetrics: { ...metrics }, preview: content.slice(-32000) });
    onProgress({ preview: content.slice(-32000), received: content.length });
    return { model: result.modelInfo?.identifier || options.modelId || params.model, usage, streamMetrics: metrics,
        ...(params.seed !== undefined ? { sampling: { seed: { requested: params.seed, applied: false, reason: 'unsupported-sdk-input' } } } : {}),
        choices: [{ finish_reason: finishReason, message: { content, reasoning_content: '' } }] };
}
