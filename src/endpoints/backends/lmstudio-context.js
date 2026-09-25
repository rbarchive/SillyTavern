/**
 * Load an LM Studio model with the context budget selected in SillyTavern.
 * The OpenAI-compatible chat endpoint cannot set this load-time value.
 */
const pendingLoads = new Map();

function nativeApiUrl(baseUrl) {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !/^\/v1\/?$/.test(url.pathname)) {
        throw new Error('LM Studio context sync requires a Custom endpoint URL ending in /v1.');
    }
    return `${url.origin}/api/v1/models`;
}

async function apiRequest(fetchImpl, url, apiKey, options = {}) {
    const result = await fetchImpl(url, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
    });
    if (!result.ok) {
        throw new Error(`LM Studio model management request failed (HTTP ${result.status}).`);
    }
    return result.json();
}

async function ensureLoaded({ apiUrl, model, contextLength, apiKey, fetchImpl, signal }) {
    const request = (path, body, requestSignal = signal) => apiRequest(fetchImpl, `${apiUrl}${path}`, apiKey, {
        method: body ? 'POST' : 'GET',
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: requestSignal,
    });
    const catalog = await request('');
    if (!Array.isArray(catalog.models)) {
        throw new Error('The Custom endpoint did not return an LM Studio model catalog.');
    }
    const selected = catalog.models.find(entry => entry.type === 'llm' && entry.key === model);
    if (!selected) {
        throw new Error(`LM Studio model "${model}" was not found. Select its model key in ST.`);
    }
    if (Number.isFinite(selected.max_context_length) && contextLength > selected.max_context_length) {
        throw new Error(`ST Context ${contextLength} exceeds the model maximum ${selected.max_context_length}.`);
    }
    const instances = selected.loaded_instances || [];
    const active = instances.find(instance => instance.id === model);
    if (instances.length > 1 || (instances.length && !active)) {
        throw new Error('LM Studio has a differently named or additional instance of this model; manage it in LM Studio first.');
    }
    if (active?.config?.context_length >= contextLength) return;

    const previous = active?.config;
    if (active) await request('/unload', { instance_id: active.id });

    const loadBody = { model, context_length: contextLength, echo_load_config: true };
    for (const key of ['eval_batch_size', 'flash_attention', 'num_experts', 'offload_kv_cache_to_gpu']) {
        if (previous?.[key] !== undefined) loadBody[key] = previous[key];
    }
    try {
        const loaded = await request('/load', loadBody);
        if (loaded.status !== 'loaded' || loaded.load_config?.context_length !== contextLength) {
            throw new Error('LM Studio did not confirm the requested context length.');
        }
    } catch (error) {
        if (previous?.context_length) {
            try {
                await request('/load', { ...loadBody, context_length: previous.context_length }, null);
            } catch {
                throw new Error(`LM Studio failed to load at ${contextLength} and could not restore the previous model: ${error.message}`);
            }
        }
        throw error;
    }
}

/** @param {{ baseUrl: string, model: string, contextLength: number, apiKey?: string, fetchImpl: Function, signal?: AbortSignal }} options */
export async function ensureLmStudioContext(options) {
    const apiUrl = nativeApiUrl(options.baseUrl);
    const contextLength = Number(options.contextLength);
    if (!options.model || !Number.isSafeInteger(contextLength) || contextLength < 512) {
        throw new Error('Select an LM Studio model and a valid ST Context length first.');
    }
    const key = `${apiUrl}\n${options.model}`;
    const previous = pendingLoads.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(() => ensureLoaded({
        apiUrl,
        model: options.model,
        contextLength,
        apiKey: options.apiKey,
        fetchImpl: options.fetchImpl,
        signal: options.signal,
    }));
    pendingLoads.set(key, current);
    try {
        await current;
    } finally {
        if (pendingLoads.get(key) === current) pendingLoads.delete(key);
    }
}
