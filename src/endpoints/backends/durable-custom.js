import { generateLocalWithProgress } from './local-model-progress.js';
import { prepareLocalDialogueParams } from '../../../public/scripts/local-dialogue-defaults.js';
import fetch from 'node-fetch';
import urlJoin from 'url-join';
import { readSecret, SECRET_KEYS } from '../secrets.js';
import { mergeObjectWithYaml, excludeKeysByYaml, getConfigValue } from '../../util.js';
import { postProcessPrompt, getPromptNames, embedOpenRouterMedia } from '../../prompt-converters.js';
import { ensureLmStudioContext } from './lmstudio-context.js';
import { readGenerationResponse, extractGenerationReply, visibleGenerationText } from './generation-stream.js';
import { SESSION_RESPONSE_SCHEMA, splitStructuredSessionResponse, buildStructuredSummaryInstruction } from './inline-session-summary.js';
import { PATCH_RESPONSE_SCHEMA, EVIDENCE_RESPONSE_SCHEMA, splitExperimentalResponse, buildPatchInstruction, buildEvidenceInstruction, validateLedger, applyLedgerPatch, ledgerAsSummary, checkEvidenceSummary } from './session-ledger.js';
import { prepareImageDescriptionParams } from './image-description.js';
import { ensureQwenUserQuery } from './qwen-user-query.js';
import { runDedicatedImageDescription } from './dedicated-image-description.js';

/** Frozen custom OpenAI request; no dependence on a browser socket. */
export async function runCustomGeneration(input, user, signal, onProgress = () => {}, { imageDescription = false, descriptionSettings, onDialogue = () => {}, preparedParams, nativeOptions, workPhase, allowTools = false } = {}) {
    if (imageDescription && descriptionSettings) return runDedicatedImageDescription(input, descriptionSettings, signal, onProgress);
    const body = structuredClone(input);
    if (body.chat_completion_source !== 'custom' || !Array.isArray(body.messages)) throw new Error('Durable generation requires a custom Chat Completion connection.');
    if ((!allowTools && body.tools?.length) || body.n > 1) throw new Error('Background generation does not support tool calls or multiple replies.');
    if (!preparedParams && body.custom_prompt_post_processing) body.messages = postProcessPrompt(body.messages, body.custom_prompt_post_processing, getPromptNames({ body }));
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
    if (preparedParams) params = structuredClone(preparedParams);
    // Actor sampling comes from the frozen ST request; record writers remain deterministic.
    if (['latest-state', 'episodic'].includes(workPhase)) params.temperature = 0;
    if (allowTools) {
        // YAML extras cannot replace the validated tools or erase a tool result.
        params.messages = body.messages;
        params.tools = body.tools;
        params.tool_choice = ['auto', 'none', 'required'].includes(body.tool_choice) ? body.tool_choice : 'auto';
    }
    // The server owns the stream; browser disconnects cannot cancel it.
    params.stream = preparedParams ? true : !!body.stream;
    params.n = 1;
    if (imageDescription) params = prepareImageDescriptionParams(params);
    if (/qwen3/i.test(String(params.model))) params.messages = ensureQwenUserQuery(params.messages, getConfigValue('promptPlaceholder', "Let's get started."));
    const inlineSummary = !imageDescription && body.rp_inline_summary === true && !preparedParams;
    const experiment = inlineSummary ? body.rp_session_experiment : null;
    if (experiment && !getConfigValue('enableRpSessionExperiments', false)) throw new Error('RP session experiments are disabled');
    if (experiment && !['delta', 'evidence'].includes(experiment.mode)) throw new Error('Unknown RP session experiment');
    if (experiment?.mode === 'delta') validateLedger(experiment.state);
    const splitResponse = experiment ? (content, options = {}) => splitExperimentalResponse(content, { ...options, mode: experiment.mode }) : splitStructuredSessionResponse;
    if (inlineSummary) {
        params.messages = structuredClone(params.messages);
        const instruction = experiment?.mode === 'delta' ? buildPatchInstruction(experiment.state) : (experiment?.mode === 'evidence' ? buildStructuredSummaryInstruction().replaceAll('\"version\":1', '\"version\":3') + '\n' + buildEvidenceInstruction() : buildStructuredSummaryInstruction());
        // Preserve World/common instructions as the exact leading prefix.
        // The output contract belongs after context, ahead of pending dialogue.
        const firstDialogue = params.messages.findIndex(row => row.role !== 'system');
        params.messages.splice(firstDialogue < 0 ? params.messages.length : firstDialogue, 0, { role: 'system', content: instruction });
        params.max_tokens = 8192;
        if (params.max_completion_tokens !== undefined) params.max_completion_tokens = 8192;
        params.stream = true;
        params.response_format = { type: 'json_schema', json_schema: { name: 'rp_dialogue_session', strict: true, schema: experiment?.mode === 'delta' ? PATCH_RESPONSE_SCHEMA : experiment?.mode === 'evidence' ? EVIDENCE_RESPONSE_SCHEMA : SESSION_RESPONSE_SCHEMA } };
        params.stream_options = { include_usage: true };
        delete params.stop;
    }
    // Prepare the assistant boundary after the final output contract is set.
    // The verified local 27B template uses close-only thinking-off prefill,
    // including structured dialogue; removing prefill would enable thinking.
    if (!imageDescription) params = prepareLocalDialogueParams(params, body);
    const controller = new AbortController();
    const abort = () => controller.abort();
    let summaryTimer, dialogue, dialogueSaved = false, accumulated = '', lastVisibleAt;
    const summaryOptions = inlineSummary ? {
        visibleText: content => splitResponse(visibleGenerationText(content)).text.trim(),
        onContent: async content => {
            accumulated = content;
            const clean = visibleGenerationText(content);
            const parsed = splitResponse(clean);
            if (!dialogue && parsed.dialogueComplete) {
                dialogue = parsed.text.trim();
                if (!dialogue) throw new Error('Inline summary arrived before dialogue.');
                summaryTimer = setTimeout(abort, Math.max(0, 30000 - (Date.now() - (lastVisibleAt || Date.now()))));
                onProgress({ event: 'dialogueComplete', phase: 'session-summary' });
                await onDialogue({ text: dialogue, reasoning: '', model: params.model });
                dialogueSaved = true;
            }
        },
    } : {};
    onProgress({ event: 'modelPreparation' });
    if (body.lmstudio_match_context) await ensureLmStudioContext({ baseUrl: body.custom_url, model: body.model, contextLength: body.lmstudio_context_length, apiKey, fetchImpl: fetch, signal });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    let data;
    try {
        const requestedAt = Date.now();
        onProgress({ event: 'modelRequest', streamMetrics: { requestedAt } });
        if (nativeOptions) data = await generateLocalWithProgress({ ...params, top_p: 1, presence_penalty: 0, top_k: undefined, stop: undefined }, { ...nativeOptions, signal: controller.signal, onProgress, repeatPenalty: workPhase === 'dialogue' ? 1 : 1.1 });
        else {
        const response = await fetch(urlJoin(body.custom_url, '/chat/completions'), { method: 'POST', headers, body: JSON.stringify(params), signal: controller.signal });
        if (!response.ok) throw new Error(`Chat model HTTP ${response.status}: ${(await response.text()).slice(0, 2000)}`);
        data = await readGenerationResponse(response, progress => {
            if (progress.lastVisibleAt) lastVisibleAt = progress.lastVisibleAt;
            onProgress(progress);
        }, { ...summaryOptions, requestedAt, allowToolCalls: allowTools });
        }
    }
    catch (error) {
        if (!dialogueSaved) throw error;
        return { text: dialogue, reasoning: '', model: params.model,
            sessionSummary: { status: 'failed', error: error.name === 'AbortError' ? 'Summary cancelled or exceeded 30 seconds' : error.message, ...(experiment ? { keepRaw: true } : {}) } };
    } finally {
        clearTimeout(summaryTimer);
        signal?.removeEventListener('abort', abort);
    }
    onProgress({ event: 'modelComplete', modelStats: { inputTokens: data.usage?.prompt_tokens, outputTokens: data.usage?.completion_tokens,
        reasoningTokens: data.usage?.completion_tokens_details?.reasoning_tokens, cachedTokens: data.usage?.prompt_tokens_details?.cached_tokens,
        finishReason: data.choices?.[0]?.finish_reason } });
    if (imageDescription && data.choices?.[0]?.finish_reason === 'length') throw new Error('이미지 묘사가 출력 한도 안에 완성되지 않았습니다. 잘린 묘사로 이미지를 생성하지 않았습니다.');
    if (inlineSummary) {
        const parsed = splitResponse(visibleGenerationText(data.choices?.[0]?.message?.content || accumulated), { final: true });
        const reply = extractGenerationReply({ ...data, choices: [{ ...data.choices?.[0], message: { content: parsed.text } }] }, body.model);
        const complete = parsed.status === 'complete' && data.choices?.[0]?.finish_reason !== 'length' && (!dialogue || dialogue === parsed.text.trim());
        if (complete && experiment) {
            const sources = { ...(experiment.sources || {}), d: { role: 'assistant', text: parsed.text } };
            const cpuStart = Date.now();
            try {
                const state = experiment.mode === 'delta' ? applyLedgerPatch(experiment.state, parsed.summary, sources) : null;
                const evidence = experiment.mode === 'evidence' ? checkEvidenceSummary(parsed.summary, sources) : null;
                const summary = state ? ledgerAsSummary(state) : evidence.summary;
                onProgress({ event: 'summaryComplete' });
                return { ...reply, sessionSummary: { status: 'complete', summary, ...(state ? { ledger: state, patch: parsed.summary } : { evidence: evidence.evidence }), cpuMs: Date.now() - cpuStart } };
            } catch (error) {
                return { ...reply, sessionSummary: { status: 'failed', error: error.message, rejected: parsed.summary, cpuMs: Date.now() - cpuStart, keepRaw: true } };
            }
        }
        if (complete) onProgress({ event: 'summaryComplete' });
        return { ...reply, sessionSummary: complete ? { status: 'complete', summary: parsed.summary } : { status: 'failed', error: parsed.error || 'Summary missing or output truncated', ...(experiment ? { keepRaw: true } : {}) } };
    }
    return allowTools ? data : extractGenerationReply(data, body.model);
}
