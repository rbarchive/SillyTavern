import fetch from 'node-fetch';
import urlJoin from 'url-join';
import { readSecret, SECRET_KEYS } from '../secrets.js';
import { mergeObjectWithYaml, excludeKeysByYaml, getConfigValue } from '../../util.js';
import { postProcessPrompt, getPromptNames, embedOpenRouterMedia } from '../../prompt-converters.js';
import { ensureLmStudioContext } from './lmstudio-context.js';
import { ensureQwenUserQuery } from './qwen-user-query.js';

/** Frozen custom OpenAI request; no dependence on a browser socket. */
export async function runCustomGeneration(input, user, signal) {
    const body = structuredClone(input);
    if (body.chat_completion_source !== 'custom' || !Array.isArray(body.messages)) throw new Error('Durable generation requires a custom Chat Completion connection.');
    if (body.tools?.length || body.n > 1) throw new Error('Background generation does not support tool calls or multiple replies.');
    if (body.custom_prompt_post_processing) body.messages = postProcessPrompt(body.messages, body.custom_prompt_post_processing, getPromptNames({ body }));
    embedOpenRouterMedia(body.messages, { audio: true, video: false });
    const apiKey = readSecret(user.directories, SECRET_KEYS.CUSTOM, body.secret_id);
    const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey };
    mergeObjectWithYaml(headers, body.custom_include_headers);
    const params = {
        messages: body.messages, model: body.model, temperature: body.temperature,
        max_tokens: body.max_tokens, max_completion_tokens: body.max_completion_tokens,
        presence_penalty: body.presence_penalty, frequency_penalty: body.frequency_penalty,
        top_p: body.top_p, top_k: body.top_k, stop: body.stop, seed: body.seed,
        logit_bias: body.logit_bias,
    };
    mergeObjectWithYaml(params, body.custom_include_body);
    excludeKeysByYaml(params, body.custom_exclude_body);
    // One complete reply makes persistence independent of streaming presentation.
    params.stream = false;
    params.n = 1;
    if (/qwen3/i.test(String(params.model))) params.messages = ensureQwenUserQuery(params.messages, getConfigValue('promptPlaceholder', "Let's get started."));
    if (body.lmstudio_match_context) await ensureLmStudioContext({ baseUrl: body.custom_url, model: body.model, contextLength: body.lmstudio_context_length, apiKey, fetchImpl: fetch, signal });
    const response = await fetch(urlJoin(body.custom_url, '/chat/completions'), { method: 'POST', headers, body: JSON.stringify(params), signal });
    if (!response.ok) throw new Error(`Chat model HTTP ${response.status}: ${(await response.text()).slice(0, 2000)}`);
    const data = await response.json();
    if (data.error) throw new Error(data.error.message || 'Chat model failed.');
    const reply = data.choices?.[0]?.message;
    if (!reply || reply.tool_calls?.length) throw new Error('The chat model returned no usable reply.');
    let text = typeof reply.content === 'string' ? reply.content : '';
    // Reasoning is stored separately, never substituted for visible dialogue.
    let reasoning = reply.reasoning_content || reply.reasoning || '';
    text = text.replace(/<think>([\s\S]*?)<\/think>/g, (_, thought) => { reasoning += thought; return ''; }).trim();
    if (!text) throw new Error('The chat model returned an empty reply.');
    return { text, reasoning, model: data.model || body.model };
}
