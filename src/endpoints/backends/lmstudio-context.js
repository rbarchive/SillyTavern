/**
 * Load an LM Studio model with the context budget selected in SillyTavern.
 * The OpenAI-compatible chat endpoint cannot set this load-time value.
 */
const pendingLoads = new Map();

function hasContext(config, length) {
    return Number.isSafeInteger(config?.context_length) && config.context_length >= length;
}

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
        let detail = '';
        try {
            const body = await result.json();
            if (typeof body?.error?.message === 'string') detail = ` ${body.error.message.slice(0, 500)}`;
        } catch { /* Some errors have no JSON body. */ }
        throw new Error(`LM Studio model management request failed (HTTP ${result.status}).${detail}`);
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
    const needsLoad = !hasContext(active?.config, contextLength);
    const displaced = catalog.models.filter(entry => entry.type === 'llm').flatMap(entry =>
        (entry.loaded_instances || []).filter(instance => entry.key !== model || needsLoad)
            .map(instance => ({ model: entry.key, instance })));
    if (displaced.some(({ model: key, instance }) => instance.id !== key || !Number.isSafeInteger(instance.config?.context_length))) {
        throw new Error('LM Studio has a custom-named instance or missing load configuration; manage it in LM Studio before switching models.');
    }
    if (new Set(displaced.map(entry => entry.model)).size !== displaced.length) {
        throw new Error('LM Studio has multiple instances of a model; manage them in LM Studio before switching models.');
    }
    const loadSettings = (key, config, length) => {
        const body = { model: key, context_length: length, echo_load_config: true };
        for (const name of ['eval_batch_size', 'flash_attention', 'num_experts', 'offload_kv_cache_to_gpu']) {
            if (config?.[name] !== undefined) body[name] = config[name];
        }
        return body;
    };
    const unloaded = [];
    let loadAttempted = false;
    try {
        for (const entry of displaced) {
            await request('/unload', { instance_id: entry.instance.id });
            unloaded.push(entry);
        }
        if (!needsLoad) return;
        loadAttempted = true;
        const loaded = await request('/load', loadSettings(model, active?.config, contextLength));
        if (loaded.status !== 'loaded' || !hasContext(loaded.load_config, contextLength)) {
            throw new Error(`LM Studio did not confirm the requested context length (requested ${contextLength}, reported ${loaded.load_config?.context_length ?? 'unknown'}).`);
        }
    } catch (error) {
        const recoveryErrors = [];
        if (loadAttempted && unloaded.length) {
            try {
                const current = await request('', undefined, null);
                const replacement = current.models?.find(entry => entry.key === model);
                for (const instance of replacement?.loaded_instances || []) {
                    await request('/unload', { instance_id: instance.id }, null);
                }
            } catch (cleanupError) { recoveryErrors.push(cleanupError.message); }
        }
        for (const entry of unloaded) {
            try {
                const restored = await request('/load', loadSettings(entry.model, entry.instance.config, entry.instance.config.context_length), null);
                if (restored.status !== 'loaded' || !hasContext(restored.load_config, entry.instance.config.context_length)) {
                    throw new Error(`Could not confirm restored model "${entry.model}".`);
                }
            } catch (restoreError) { recoveryErrors.push(restoreError.message); }
        }
        if (recoveryErrors.length) {
            throw new Error(`${error.message} Previous model recovery failed: ${recoveryErrors.join('; ')}`);
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
    const key = apiUrl;
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
