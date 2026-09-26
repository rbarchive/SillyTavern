import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import sanitize from 'sanitize-filename';
import { sync as writeAtomic } from 'write-file-atomic';
import { acceptJob, getJob, listJobs, cancelJob } from '../generation-jobs.js';
import { runCustomGeneration } from './backends/durable-custom.js';
import { runComfyGeneration } from './stable-diffusion.js';
import { clientRelativePath } from '../util.js';

export function processImagePrompt(text, minimal = false) {
    let value = text.normalize('NFD');
    if (!minimal) value = value.replaceAll('"', '').replaceAll('“', '').replaceAll('\n', ', ').replace(/[^a-zA-Z0-9.,:_(){}<>[\]/\-'|#]+/g, ' ');
    value = value.replace(/\s+/g, ' ').trim();
    return minimal ? value : value.split(',').map(x => x.trim()).filter(Boolean).join(', ');
}

export const router = express.Router();
router.post('/', async (req, res) => {
    try {
        const { id, origin, operation = 'append', kind, chatRequest, image, message } = req.body;
        if (!['chat', 'image'].includes(kind)) return res.status(400).send({ error: 'Unknown generation kind' });
        if (!message || typeof message.name !== 'string') return res.status(400).send({ error: 'Missing message template' });
        if (chatRequest && (chatRequest.chat_completion_source !== 'custom' || chatRequest.tools?.length || chatRequest.n > 1)) return res.status(400).send({ error: 'Unsupported background generation request' });
        if (kind === 'image' && (!image?.workflow || !image?.url)) return res.status(400).send({ error: 'Missing frozen image workflow' });
        const user = req.user;
        const job = await acceptJob(user, { id, origin, operation, message }, async ({ signal, update }) => {
            let reply;
            if (chatRequest) {
                await update({ phase: kind === 'image' ? 'description' : 'dialogue' });
                reply = await runCustomGeneration(chatRequest, user, signal);
            }
            if (kind === 'chat') return {
                message: { ...message, mes: operation === 'continue' ? (message.mes || '') + reply.text : reply.text, extra: { ...message.extra, reasoning: reply.reasoning, api: 'openai', model: reply.model } },
                result: { text: reply.text },
            };
            const prompt = processImagePrompt(reply?.text ?? image.prompt, image.minimal);
            if (!prompt) throw new Error('The chat model returned no image description.');
            const prefixed = image.prefix?.includes('{prompt}') ? image.prefix.replaceAll('{prompt}', prompt) : image.prefix ? `${image.prefix}, ${prompt}` : prompt;
            const workflow = image.workflow.replaceAll('"%prompt%"', JSON.stringify(prefixed));
            await update({ phase: 'drawing' });
            const output = await runComfyGeneration({ url: image.url, prompt: JSON.stringify({ prompt: JSON.parse(workflow) }) }, signal, promptId => { update({ phase: 'drawing', promptId }); });
            signal.throwIfAborted();
            if (!/^(png|jpg|jpeg|webp|gif)$/.test(output.format)) throw new Error('Unsupported image format.');
            const folder = path.join(user.directories.userImages, sanitize(image.folder || ''));
            fs.mkdirSync(folder, { recursive: true });
            const file = path.join(folder, `generation-${id}.${output.format}`);
            writeAtomic(file, Buffer.from(output.data, 'base64'));
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
        res.status(202).send(job);
    } catch (error) { res.status(400).send({ error: error.message }); }
});
router.get('/', async (req, res) => {
    try { res.send(await listJobs(req.user)); } catch (error) { res.status(500).send({ error: error.message }); }
});
router.get('/:id', async (req, res) => {
    try {
        const job = await getJob(req.user, req.params.id);
        if (!job) return res.sendStatus(404);
        res.send(job);
    } catch (error) { res.status(400).send({ error: error.message }); }
});
router.post('/:id/cancel', async (req, res) => {
    try {
        const job = await cancelJob(req.user, req.params.id);
        if (!job) return res.sendStatus(404);
        res.send(job);
    } catch (error) { res.status(400).send({ error: error.message }); }
});
