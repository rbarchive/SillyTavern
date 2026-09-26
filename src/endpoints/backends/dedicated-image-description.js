import fetch from 'node-fetch';
import { lmStudioModelsUrl, withLmStudioImageModel } from './lmstudio-context.js';
import { prepareImageDescriptionParams } from './image-description.js';
import { readGenerationResponse, extractGenerationReply } from './generation-stream.js';

export function validateDescriptionSettings(input) {
    if (!input || input.mode !== 'dedicated') throw new Error('이미지 묘사 전용 모델을 선택해 주세요.');
    let url;
    try { url = new URL(input.url); lmStudioModelsUrl(input.url); } catch { throw new Error('LM Studio 주소는 http(s)://서버:포트/v1 형식이어야 합니다.'); }
    if (typeof input.model !== 'string' || !input.model.trim() || input.model.length > 300) throw new Error('이미지 묘사 모델을 선택해 주세요.');
    if (!Number.isSafeInteger(input.context_length) || input.context_length < 1024 || input.context_length > 131072) throw new Error('컨텍스트는 1024~131072 사이 정수여야 합니다.');
    if (!Number.isSafeInteger(input.max_tokens) || input.max_tokens < 128 || input.max_tokens > 1024) throw new Error('최대 출력은 128~1024 사이 정수여야 합니다.');
    return { mode: 'dedicated', url: url.origin + '/v1', model: input.model, context_length: input.context_length, max_tokens: input.max_tokens };
}

export async function listDescriptionModels(input, { fetchImpl = fetch, signal } = {}) {
    const settings = validateDescriptionSettings(input);
    const response = await fetchImpl(lmStudioModelsUrl(settings.url), { signal });
    if (!response.ok) throw new Error(`LM Studio 모델 목록 확인 실패 (HTTP ${response.status}).`);
    const catalog = await response.json();
    if (!Array.isArray(catalog.models)) throw new Error('LM Studio 모델 목록을 받지 못했습니다.');
    return { models: catalog.models.filter(m => m.type === 'llm').map(m => ({ key: m.key, display_name: m.display_name || m.key, size_bytes: m.size_bytes,
        loaded: !!m.loaded_instances?.length, context_length: m.loaded_instances?.[0]?.config?.context_length })) };
}

/** Dedicated requests use only their own allowlisted settings, never chat secrets/YAML. */
export async function runDedicatedImageDescription(input, settingsInput, signal, onProgress = () => {}, { fetchImpl = fetch } = {}) {
    const settings = validateDescriptionSettings(settingsInput);
    if (!Array.isArray(input.messages) || !input.messages.length) throw new Error('이미지 묘사에 필요한 대화 정보가 없습니다.');
    onProgress({ event: 'modelPreparation' });
    return withLmStudioImageModel({ baseUrl: settings.url, model: settings.model, contextLength: settings.context_length, fetchImpl, signal }, async instanceId => {
        const params = prepareImageDescriptionParams({ model: instanceId, messages: structuredClone(input.messages) });
        params.messages[1].content += '\n\nEND OF QUOTED SOURCE. Actual task: Extract the requested visual details into ONE ENGLISH image prompt, 60-100 English words. Translate Korean facts into English. Output English only, no Korean, no explanation, no dialogue, no thinking.';
        // Non-thinking Qwen Instruct models do not need assistant continuation.
        if (/instruct.*2507|coder/i.test(instanceId)) params.messages = params.messages.filter(m => m.role !== 'assistant');
        params.max_tokens = settings.max_tokens;
        params.reasoning_effort = 'none';
        params.chat_template_kwargs = { enable_thinking: false };
        onProgress({ event: 'modelRequest' });
        const response = await fetchImpl(settings.url + '/chat/completions', { method: 'POST', signal,
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) });
        if (!response.ok) throw new Error(`이미지 묘사 모델 응답 실패 (HTTP ${response.status}): ${(await response.text()).slice(0, 500)}`);
        const data = await readGenerationResponse(response, onProgress);
        onProgress({ event: 'modelComplete', modelStats: { inputTokens: data.usage?.prompt_tokens, outputTokens: data.usage?.completion_tokens, reasoningTokens: data.usage?.completion_tokens_details?.reasoning_tokens } });
        if (data.choices?.[0]?.finish_reason === 'length') throw new Error('이미지 묘사가 출력 한도 안에 완성되지 않았습니다. 최대 출력을 늘려 주세요.');
        const reply = extractGenerationReply(data, instanceId);
        if (!/[A-Za-z]{2,}/.test(reply.text) || /[가-힣\u3040-\u30ff\u3400-\u9fff]/u.test(reply.text)) throw new Error('이미지 묘사 모델이 영문 묘사를 반환하지 않았습니다. 모델과 설정을 확인해 주세요.');
        return reply;
    });
}
