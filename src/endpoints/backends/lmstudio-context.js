/**
 * Load an LM Studio model with the context budget selected in SillyTavern.
 * The OpenAI-compatible chat endpoint cannot set this load-time value.
 */
const pendingLoads = new Map();

function hasContext(config, length) {
    return Number.isSafeInteger(config?.context_length) && config.context_length >= length;
}

export function lmStudioModelsUrl(baseUrl) {
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
    // Reusing an already-ready dialogue model must not evict an image model.
    if (!needsLoad) return;
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
    const apiUrl = lmStudioModelsUrl(options.baseUrl);
    const contextLength = Number(options.contextLength);
    if (!options.model || !Number.isSafeInteger(contextLength) || contextLength < 512) {
        throw new Error('Select an LM Studio model and a valid ST Context length first.');
    }
    return withLmStudioModelLock(options.baseUrl, () => ensureLoaded({
        apiUrl, model: options.model, contextLength, apiKey: options.apiKey,
        fetchImpl: options.fetchImpl, signal: options.signal,
    }), options.signal);
}

/** Protect an image model from this server's model switches until its stream ends. */
export async function withLmStudioModelLock(baseUrl, action, signal) {
    const key = lmStudioModelsUrl(baseUrl);
    const previous = pendingLoads.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(() => { signal?.throwIfAborted(); return action(); });
    pendingLoads.set(key, current);
    try {
        return await current;
    } finally {
        if (pendingLoads.get(key) === current) pendingLoads.delete(key);
    }
}

/** Add a model without unloading any existing instance; callback holds the lock. */
export async function withLmStudioImageModel(options, action) {
    const apiUrl = lmStudioModelsUrl(options.baseUrl);
    return withLmStudioModelLock(options.baseUrl, async () => {
        const request = (suffix = '', body, signal = options.signal) => apiRequest(options.fetchImpl, apiUrl + suffix, undefined, {
            method: body ? 'POST' : 'GET', signal,
            ...(body ? { body: JSON.stringify(body) } : {}),
        });
        const getSelected = catalog => {
            const model = catalog.models?.find(m => m.type === 'llm' && m.key === options.model);
            if (!model) throw new Error('선택한 이미지 묘사 모델을 LM Studio에서 찾지 못했습니다. 목록을 새로고침해 주세요.');
            if (options.contextLength > model.max_context_length) throw new Error('설정한 컨텍스트가 선택 모델의 최대 길이를 초과합니다.');
            return model;
        };
        let selected = getSelected(await request());
        let instance = selected.loaded_instances?.find(i => hasContext(i.config, options.contextLength));
        if (!instance && selected.loaded_instances?.length) {
            if (!options.reloadIfNeeded) throw new Error('선택 모델의 로드된 컨텍스트가 부족합니다. 이미지 생성 설정에서 컨텍스트를 늘린 뒤 “적용 및 모델 로드”를 눌러 주세요.');
            const instances = selected.loaded_instances;
            if (instances.length !== 1 || instances[0].id !== options.model || !Number.isSafeInteger(instances[0].config?.context_length)) {
                throw new Error('추가 인스턴스 또는 사용자 지정 이름이 있는 모델은 LM Studio에서 직접 다시 로드해 주세요.');
            }
            const previous = instances[0];
            const loadBody = contextLength => {
                const body = { model: options.model, context_length: contextLength, echo_load_config: true };
                for (const key of ['eval_batch_size', 'flash_attention', 'num_experts', 'offload_kv_cache_to_gpu']) {
                    if (previous.config[key] !== undefined) body[key] = previous.config[key];
                }
                return body;
            };
            await request('/unload', { instance_id: previous.id });
            try {
                await request('/load', loadBody(options.contextLength));
                selected = getSelected(await request());
                instance = selected.loaded_instances?.find(i => hasContext(i.config, options.contextLength));
                if (!instance) throw new Error('요청한 컨텍스트로 로드되었는지 확인하지 못했습니다.');
            } catch (error) {
                try {
                    const current = getSelected(await request('', undefined, null));
                    for (const replacement of current.loaded_instances || []) {
                        if (replacement.id !== previous.id) throw new Error('모델 인스턴스가 변경되어 자동 복원을 중단했습니다.');
                        await request('/unload', { instance_id: replacement.id }, null);
                    }
                    await request('/load', loadBody(previous.config.context_length), null);
                    const restored = getSelected(await request('', undefined, null));
                    if (!restored.loaded_instances?.some(i => i.id === previous.id && hasContext(i.config, previous.config.context_length))) throw new Error('이전 컨텍스트 복원을 확인하지 못했습니다.');
                } catch (recoveryError) { throw new Error(`${error.message} 이전 모델 복원 실패: ${recoveryError.message}`); }
                throw error;
            }
        }
        if (!instance) {
            await request('/load', { model: options.model, context_length: options.contextLength, echo_load_config: true });
            selected = getSelected(await request());
            instance = selected.loaded_instances?.find(i => hasContext(i.config, options.contextLength));
        }
        if (!instance?.id) throw new Error('이미지 묘사 모델 로드와 컨텍스트를 확인하지 못했습니다.');
        return action(instance.id, instance.config);
    }, options.signal);
}
