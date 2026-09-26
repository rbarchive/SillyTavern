import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import sanitize from 'sanitize-filename';
import { sync as writeAtomic } from 'write-file-atomic';
import { acceptJob, getJob, listJobs, cancelJob } from '../generation-jobs.js';
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
    const { id, origin, operation, status, createdAt, updatedAt, progress, timings, modelStats, error, result, preview } = job;
    return { id, origin, operation, status, createdAt, updatedAt, progress, timings, modelStats, error,
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
        if (chatRequest && (chatRequest.chat_completion_source !== 'custom' || chatRequest.tools?.length || chatRequest.n > 1)) return res.status(400).send({ error: 'Unsupported background generation request' });
        if (kind === 'image' && (!image?.workflow || !image?.url)) return res.status(400).send({ error: 'Missing frozen image workflow' });
        if (kind === 'image' && image.descriptionSettings) image.descriptionSettings = validateDescriptionSettings(image.descriptionSettings);
        const boost = kind === 'image' ? boostPreference(image.boost) : undefined;
        const user = req.user;
        const job = await acceptJob(user, { id, origin, operation, message, imageBoost: boost }, async ({ signal, update }) => {
            let reply;
            if (chatRequest) {
                await update({ phase: kind === 'image' ? 'description' : 'dialogue' });
                reply = await runCustomGeneration(chatRequest, user, signal, progress => update(progress), { imageDescription: kind === 'image', descriptionSettings: kind === 'image' ? image.descriptionSettings : undefined });
            }
            if (kind === 'chat') return {
                message: { ...message, mes: operation === 'continue' ? (message.mes || '') + reply.text : reply.text, extra: { ...message.extra, reasoning: reply.reasoning, api: 'openai', model: reply.model } },
                result: { text: reply.text },
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
    try { res.send((await listJobs(req.user)).map(job => publicGenerationJob(job, true))); } catch (error) { res.status(500).send({ error: error.message }); }
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
