import { worldToolAdapter, runWorldToolTurn, decideWorldTool } from './backends/world-tool-runner.js';
import { countLocalMessages } from './backends/local-model-progress.js';
import express from 'express';
import fetch from 'node-fetch';
import { getConfigValue } from '../util.js';
import { runContextMemoryTurn } from './backends/context-memory-runner.js';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sanitize from 'sanitize-filename';
import { sync as writeAtomic } from 'write-file-atomic';
import { acceptJob, getJob, listJobSummaries, cancelJob, stopPendingSessionSummaries, latestSessionSummary, sessionSummarySourceCoverage, contextMemorySourceCoverage, compactSessionMessages, readNativeSession } from '../generation-jobs.js';
import { buildSessionSummaryContext } from './backends/inline-session-summary.js';
import { runCustomGeneration } from './backends/durable-custom.js';
import { runComfyGeneration } from './stable-diffusion.js';
import { clientRelativePath } from '../util.js';
import { validateDescriptionSettings } from './backends/dedicated-image-description.js';
import { boostPreference } from '../local-image-runtime.js';

export function processImagePrompt(text, minimal = false) {
    let value = text.normalize('NFD');
    if (!minimal) value = value.replaceAll('"', '').replaceAll('“', '').replaceAll('\n', ', ').replace(/[^a-zA-Z0-9.,:_(){}<>[\]/\-'|#]+/g, ' ');
    value = value.replace(/\s+/g, ' ').trim();
    return minimal ? value : value.split(',').map(x => x.trim()).filter(Boolean).join(', ');
}

/** Polling must not resend full chat snapshots and reasoning on every tick. */
export function publicGenerationJob(job, summary = false) {
    if (!job) return job;
    const { id, origin, operation, status, createdAt, updatedAt, progress, timings, modelStats, error, result, preview, dialogueReady, sessionSummary, memoryMetrics, memoryOutcome, toolPending, toolReceipts } = job;
    return { id, origin, operation, status, createdAt, updatedAt, progress, timings, modelStats, error, dialogueReady, memoryMetrics, toolPending, toolReceipts, memoryOutcome: sessionSummary?.memoryOutcome ?? memoryOutcome,
        sessionSummary: sessionSummary ? { status: sessionSummary.status, error: sessionSummary.error, keepRaw: sessionSummary.keepRaw } : undefined,
        result: summary ? (result?.path ? { path: result.path } : undefined) : result,
        ...(!summary && preview !== undefined ? { preview } : {}),
    };
}

export const router = express.Router();
router.post('/', async (req, res) => {
    try {
        const { id, origin, operation = 'append', kind, chatRequest, image, message } = req.body;
        if (!['chat', 'image'].includes(kind)) return res.status(400).send({ error: 'Unknown generation kind' });
        if (!message || typeof message.name !== 'string') return res.status(400).send({ error: 'Missing message template' });
        if (chatRequest && (chatRequest.chat_completion_source !== 'custom' || (chatRequest.tools?.length && chatRequest.rp_world_background !== true) || chatRequest.n > 1)) return res.status(400).send({ error: 'Unsupported background generation request' });
        if (kind === 'image' && (!image?.workflow || !image?.url)) return res.status(400).send({ error: 'Missing frozen image workflow' });
        if (kind === 'image' && image.descriptionSettings) image.descriptionSettings = validateDescriptionSettings(image.descriptionSettings);
        const boost = kind === 'image' ? boostPreference(image.boost) : undefined;
        const user = req.user;
        const worldTools = chatRequest?.rp_world_background === true;
        const adapter = worldTools ? worldToolAdapter() : null;
        if (worldTools && (!adapter || kind !== 'chat' || operation !== 'append' || origin?.group || chatRequest.rp_context_memory || chatRequest.rp_inline_summary)) throw new Error('World background tools are unavailable for this request.');
        const toolScope = worldTools ? adapter.prepare(origin, chatRequest.tools) : null;
        const contextMode = chatRequest?.rp_context_memory === true;
        if (contextMode && (chatRequest.rp_inline_summary || kind !== 'chat' || operation !== 'append' || origin?.group)) throw new Error('Context memory requires single-character append and no inline mode');
        if (contextMode && !getConfigValue('enableRpContextMemory', false)) throw new Error('Context memory is disabled');
        const nativeOptions = contextMode && getConfigValue('rpMemoryNativeProgressEnabled', false) && chatRequest.model === getConfigValue('rpMemoryNativeModel', '') ? { sdkPath: getConfigValue('rpMemoryNativeSdkPath', ''), baseUrl: getConfigValue('rpMemoryNativeBaseUrl', ''), modelId: getConfigValue('rpMemoryNativeModel', '') } : undefined;
        const tokenizerUrl = contextMode ? getConfigValue('rpMemoryTokenizerBridgeUrl', '') : '';
        if (contextMode && !nativeOptions && !/^http:\/\/(127\.0\.0\.1|localhost):\d+\/count$/u.test(tokenizerUrl)) throw new Error('A local memory tokenizer bridge is required');
        const contextKey = contextMode ? createHash('sha256').update(JSON.stringify({ mode: 'context-v1', scope: chatRequest.rp_memory_scope, core: chatRequest.rp_memory_prefix_world })).digest('hex') : chatRequest?.rp_inline_summary === true ? createHash('sha256').update(String(chatRequest.rp_memory_prefix_world || chatRequest.messages?.find(row => row.role === 'system')?.content || '')).digest('hex') : undefined;
        if (chatRequest?.rp_inline_summary === true && (kind !== 'chat' || operation !== 'append' || origin?.group)) return res.status(400).send({ error: 'Inline session summary currently supports single-character append only.' });
        const job = await acceptJob(user, { id, origin, operation, message, imageBoost: boost }, async ({ signal, update }) => {
            let reply;
            let summaryUsable = false;
            if (chatRequest) {
                if (chatRequest.rp_inline_summary === true) {
                    await stopPendingSessionSummaries(user);
                    const previous = await latestSessionSummary(user, origin, contextKey);
                    const coverage = sessionSummarySourceCoverage(user, origin, chatRequest.messages);
                    summaryUsable = Boolean(coverage && (coverage.firstRow === 1 || (previous && coverage.firstRow <= previous.coveredRows)));
                    if (previous && summaryUsable) {
                        // A checkpoint replaces its entire prefix: no recent overlap.
                        const tailCount = previous.pendingRows;
                        const dialogueMessages = chatRequest.messages.filter(row => row.role !== 'system');
                        if (dialogueMessages.some(row => typeof row.content !== 'string')) throw new Error('Inline summary supports text-only dialogue.');
                        chatRequest.messages = compactSessionMessages(chatRequest.messages, buildSessionSummaryContext(previous.summary, { coveredTurns: previous.coveredTurns, coveredMessages: previous.coveredRows - 1 }), tailCount);
                        update({ phase: 'dialogue', contextSummary: { coveredRows: previous.coveredRows, retainedMessages: Math.min(tailCount, dialogueMessages.length) } });
                    } else {
                        // No valid checkpoint: retain every original dialogue row.
                        // Move fresh system instructions ahead of the current query.
                        chatRequest.messages = [
                            ...chatRequest.messages.filter(row => row.role === 'system'),
                            ...chatRequest.messages.filter(row => row.role !== 'system'),
                        ];
                    }
                }
                await update({ phase: kind === 'image' ? 'description' : 'dialogue' });
                const dialogueOutput = value => ({
                    message: { ...message, mes: operation === 'continue' ? (message.mes || '') + value.text : value.text, extra: { ...message.extra, reasoning: value.reasoning, api: 'openai', model: value.model } },
                    result: { text: value.text },
                });
                if (worldTools) {
                    reply = await runWorldToolTurn({ input: chatRequest, adapter, scope: toolScope, user, id, signal, update,
                        generate: (input, signal, progress) => runCustomGeneration(input, user, signal, progress, { allowTools: true }),
                    });
                } else if (contextMode) {
                    await stopPendingSessionSummaries(user, origin);
                    const previous = await latestSessionSummary(user, origin, contextKey);
                    const coverage = contextMemorySourceCoverage(user, origin, chatRequest.messages);
                    if (!coverage) throw new Error('Provider query does not match stored native input');
                    const budget = chatRequest.rp_recent_raw_budget ?? getConfigValue('rpMemoryRecentRawBudget', 6144);
                    if (![4096,6144,8192,12288,16384].includes(budget)) throw new Error('Invalid raw budget');
                    const consolidationTokenBudget = getConfigValue('rpMemoryConsolidationTokenBudget', 512);
                    if (!Number.isSafeInteger(consolidationTokenBudget) || consolidationTokenBudget < 1 || consolidationTokenBudget > 8192) throw new Error('Invalid consolidation token budget');
                    const memoryWireFormat = getConfigValue('rpMemoryConsolidationWireFormat', 'legacy-v1');
                    if (!['legacy-v1', 'compact-v2'].includes(memoryWireFormat)) throw new Error('Invalid consolidation wire format');
                    reply = await runContextMemoryTurn({ request: chatRequest, session: readNativeSession(user, origin), previous, scope: chatRequest.rp_memory_scope,
                        latestStateEnabled: getConfigValue('rpMemoryLatestStateEnabled', false), latestStateStorageRoot: path.join(user.directories.root, 'rp-memory-context'), fixedContext: chatRequest.rp_memory_prefix_world, rawBudget: budget, consolidationTokenBudget, memoryWireFormat, signal, update, readSession: () => readNativeSession(user, origin),
                        countMessages: async (messages, countSignal) => {
                            if (nativeOptions) return countLocalMessages(messages, nativeOptions);
                            const response = await fetch(tokenizerUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: chatRequest.model, messages }), signal: countSignal });
                            if (!response.ok) throw new Error('Memory tokenizer failed');
                            const data = await response.json();
                            if (!Number.isSafeInteger(data.tokens) || data.tokens < 0) throw new Error('Invalid tokenizer result');
                            return data.tokens;
                        },
                        generate: (input, requestSignal, progress, preparedParams, workPhase) => runCustomGeneration(input, user, requestSignal, progress, { preparedParams, nativeOptions, workPhase }),
                        saveDialogue: value => update({ dialogueOutput: dialogueOutput(value), event: 'dialogueComplete', phase: 'session-summary' }),
                    });
                    if (reply.sessionSummary) Object.assign(reply.sessionSummary, { contextKey });
                } else reply = await runCustomGeneration(chatRequest, user, signal, progress => update(progress), { imageDescription: kind === 'image', descriptionSettings: kind === 'image' ? image.descriptionSettings : undefined,
                    onDialogue: value => update({ dialogueOutput: dialogueOutput(value), phase: 'session-summary' }),
                });
            }
            if (kind === 'chat') return {
                message: { ...message, mes: operation === 'continue' ? (message.mes || '') + reply.text : reply.text, extra: { ...message.extra, reasoning: reply.reasoning, api: 'openai', model: reply.model } },
                result: { text: reply.text },
                ...(reply.sessionSummary ? { sessionSummary: { ...reply.sessionSummary, contextKey, usable: contextMode ? true : summaryUsable } } : {}),
            };
            const prompt = processImagePrompt(reply?.text ?? image.prompt, image.minimal);
            if (!prompt) throw new Error('The chat model returned no image description.');
            const prefixed = image.prefix?.includes('{prompt}') ? image.prefix.replaceAll('{prompt}', prompt) : image.prefix ? `${image.prefix}, ${prompt}` : prompt;
            const workflow = image.workflow.replaceAll('"%prompt%"', JSON.stringify(prefixed));
            await update({ phase: 'drawing', event: 'drawing' });
            const output = await runComfyGeneration({ url: image.url, boost, prompt: JSON.stringify({ prompt: JSON.parse(workflow) }) }, signal, promptId => { update({ phase: 'drawing', promptId, event: 'comfySubmitted' }); });
            await update({ event: 'imageReceived' });
            signal.throwIfAborted();
            if (!/^(png|jpg|jpeg|webp|gif)$/.test(output.format)) throw new Error('Unsupported image format.');
            const folder = path.join(user.directories.userImages, sanitize(image.folder || ''));
            fs.mkdirSync(folder, { recursive: true });
            const file = path.join(folder, `generation-${id}.${output.format}`);
            writeAtomic(file, Buffer.from(output.data, 'base64'));
            await update({ event: 'imageSaved' });
            const url = clientRelativePath(user.directories.root, file);
            const messageText = (image.messageTemplate || '{{prompt}}').replaceAll('{{prompt}}', prompt).replaceAll('{{prefixedPrompt}}', prefixed);
            return { message: { ...message, mes: messageText, extra: {
                ...message.extra, image_generation_prompt: messageText,
                media: [{ url, type: 'image', title: prompt, generation_type: image.generationType, negative: image.negative, source: 'generated',
                    ...(image.imageContext ? { image_context: structuredClone(image.imageContext) } : {}),
                }],
                media_display: 'gallery', media_index: 0, inline_image: false,
            } }, result: { path: url, prompt } };
        });
        res.status(202).send(publicGenerationJob(job));
    } catch (error) { res.status(400).send({ error: error.message }); }
});
router.get('/', async (req, res) => {
    try { res.send(await listJobSummaries(req.user)); } catch (error) { res.status(500).send({ error: error.message }); }
});
router.get('/capabilities', (_req, res) => res.send({ contextMemory: getConfigValue('enableRpContextMemory', false) && getConfigValue('rpMemoryDefaultContextMemory', false), contextModel: getConfigValue('rpMemoryNativeModel', ''), recentRawBudget: getConfigValue('rpMemoryRecentRawBudget', 6144), worldBackground: Boolean(worldToolAdapter()) }));
router.post('/:id/tool-decision', async (req, res) => {
    try {
        const job = await getJob(req.user, req.params.id);
        if (!job || !job.toolPending || ['completed','failed','cancelled','conflict','interrupted'].includes(job.status)) return res.status(409).send({ error: 'Tool request is not active.' });
        res.send(decideWorldTool(req.user, req.params.id, req.body));
    } catch (error) { res.status(409).send({ error: error.message }); }
});
router.get('/:id', async (req, res) => {
    try {
        const job = await getJob(req.user, req.params.id);
        if (!job) return res.sendStatus(404);
        res.send(publicGenerationJob(job));
    } catch (error) { res.status(400).send({ error: error.message }); }
});
router.post('/:id/cancel', async (req, res) => {
    try {
        const job = await cancelJob(req.user, req.params.id);
        if (!job) return res.sendStatus(404);
        res.send(publicGenerationJob(job));
    } catch (error) { res.status(400).send({ error: error.message }); }
});
