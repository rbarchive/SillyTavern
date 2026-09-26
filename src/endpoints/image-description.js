import express from 'express';
import { listDescriptionModels, runDedicatedImageDescription } from './backends/dedicated-image-description.js';

export const router = express.Router();
router.post('/models', async (req, res) => {
    try { res.send(await listDescriptionModels(req.body.settings, { signal: AbortSignal.timeout(10000) })); }
    catch (error) { res.status(400).send({ error: error.message }); }
});
router.post('/test', async (req, res) => {
    const start = performance.now();
    try {
        const reply = await runDedicatedImageDescription({ messages: [{ role: 'user', content: '성인 방문자가 갈색 머리에 회색 코트를 입고 흰 돌 관청 앞에 서 있다. 현재 인물 그림.' }] }, req.body.settings, AbortSignal.timeout(120000));
        res.send({ model: reply.model, totalMs: Math.round(performance.now() - start) });
    } catch (error) { res.status(400).send({ error: error.message }); }
});
router.post('/generate', async (req, res) => {
    try { res.send(await runDedicatedImageDescription({ messages: req.body.messages }, req.body.settings, AbortSignal.timeout(180000))); }
    catch (error) { res.status(400).send({ error: error.message }); }
});
