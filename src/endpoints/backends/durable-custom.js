import fetch from 'node-fetch';
import urlJoin from 'url-join';
import { readSecret, SECRET_KEYS } from '../secrets.js';
import { mergeObjectWithYaml, excludeKeysByYaml, getConfigValue } from '../../util.js';
import { postProcessPrompt, getPromptNames, embedOpenRouterMedia } from '../../prompt-converters.js';
import { ensureLmStudioContext } from './lmstudio-context.js';
import { readGenerationResponse, extractGenerationReply } from './generation-stream.js';
import { prepareImageDescriptionParams } from './image-description.js';
import { ensureQwenUserQuery } from './qwen-user-query.js';
import { runDedicatedImageDescription } from './dedicated-image-description.js';

/** Frozen custom OpenAI request; no dependence on a browser socket. */
export async function runCustomGeneration(input, user, signal, onProgress = () => {}, { imageDescription = false, descriptionSettings } = {}) {
    if (imageDescription && descriptionSettings) return runDedicatedImageDescription(input, descriptionSettings, signal, onProgress);
    const body = structuredClone(input);
    if (body.chat_completion_source !== 'custom' || !Array.isArray(body.messages)) throw new Error('Durable generation requires a custom Chat Completion connection.');
    if (body.tools?.length || body.n > 1) throw new Error('Background generation does not support tool calls or multiple replies.');
    if (body.custom_prompt_post_processing) body.messages = postProcessPrompt(body.messages, body.custom_prompt_post_processing, getPromptNames({ body }));
    embedOpenRouterMedia(body.messages, { audio: true, video: false });
    const apiKey = readSecret(user.directories, SECRET_KEYS.CUSTOM, body.secret_id);
    const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey };
    mergeObjectWithYaml(headers, body.custom_include_headers);
    let params = {
        messages: body.messages, model: body.model, temperature: body.temperature,
        max_tokens: body.max_tokens, max_completion_tokens: body.max_completion_tokens,
        presence_penalty: body.presence_penalty, frequency_penalty: body.frequency_penalty,
        top_p: body.top_p, top_k: body.top_k, stop: body.stop, seed: body.seed,
        logit_bias: body.logit_bias,
    };
    mergeObjectWithYaml(params, body.custom_include_body);
    excludeKeysByYaml(params, body.custom_exclude_body);
    // The server owns the stream; browser disconnects cannot cancel it.
    params.stream = !!body.stream;
    params.n = 1;
    if (imageDescription) params = prepareImageDescriptionParams(params);
    if (/qwen3/i.test(String(params.model))) params.messages = ensureQwenUserQuery(params.messages, getConfigValue('promptPlaceholder', "Let's get started."));
    onProgress({ event: 'modelPreparation' });
    if (body.lmstudio_match_context) await ensureLmStudioContext({ baseUrl: body.custom_url, model: body.model, contextLength: body.lmstudio_context_length, apiKey, fetchImpl: fetch, signal });
    onProgress({ event: 'modelRequest' });
    const response = await fetch(urlJoin(body.custom_url, '/chat/completions'), { method: 'POST', headers, body: JSON.stringify(params), signal });
    if (!response.ok) throw new Error(`Chat model HTTP ${response.status}: ${(await response.text()).slice(0, 2000)}`);
    const data = await readGenerationResponse(response, onProgress);
    onProgress({ event: 'modelComplete', modelStats: { inputTokens: data.usage?.prompt_tokens, outputTokens: data.usage?.completion_tokens, reasoningTokens: data.usage?.completion_tokens_details?.reasoning_tokens } });
    if (imageDescription && data.choices?.[0]?.finish_reason === 'length') throw new Error('이미지 묘사가 출력 한도 안에 완성되지 않았습니다. 잘린 묘사로 이미지를 생성하지 않았습니다.');
    return extractGenerationReply(data, body.model);
}
