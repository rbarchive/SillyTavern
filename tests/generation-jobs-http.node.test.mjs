import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { setConfigFilePath } from '../src/util.js';
setConfigFilePath(path.resolve('default/config.yaml'));
const { router } = await import('../src/endpoints/generation-jobs.js');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('real HTTP acceptance survives closing its socket through quiet description, Comfy and persistence', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-durable-http-'));
    const directories = { root, chats: path.join(root, 'chats'), groupChats: path.join(root, 'group chats'), userImages: path.join(root, 'user/images') };
    fs.mkdirSync(path.join(directories.chats, 'Narrator'), { recursive: true });
    const file = path.join(directories.chats, 'Narrator', 'origin.jsonl');
    fs.writeFileSync(file, [{ chat_metadata: { integrity: 'http-origin' } }, { name: 'User', is_user: true, mes: 'Describe a visitor.' }].map(JSON.stringify).join('\n'));
    let modelCalls = 0, imageCalls = 0, interrupts = 0;
    const upstream = express(); upstream.use(express.json());
    upstream.post('/v1/chat/completions', async (req, res) => {
        modelCalls++; assert.equal(req.body.stream, false);
        await delay(80); res.json({ choices: [{ message: { content: 'woman, gray coat, brown hair', reasoning_content: 'private reasoning' } }] });
    });
    upstream.post('/prompt', async (req, res) => { imageCalls++; assert.match(req.body.prompt.text, /gray coat/); res.json({ prompt_id: 'own-image-job' }); });
    let histories = 0;
    upstream.get('/history/own-image-job', (req, res) => { histories++; res.json(histories < 2 ? {} : { 'own-image-job': { status: { status_str: 'success' }, outputs: { 1: { images: [{ filename: 'image.png', subfolder: '', type: 'output' }] } } } }); });
    upstream.get('/view', (req, res) => res.send(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')));
    upstream.post('/interrupt', (req, res) => { interrupts++; res.sendStatus(200); });
    const provider = upstream.listen(0, '127.0.0.1'); await new Promise(resolve => provider.once('listening', resolve));
    const providerUrl = `http://127.0.0.1:${provider.address().port}`;
    const app = express(); app.use(express.json()); app.use((req, res, next) => { req.user = { directories }; next(); }); app.use('/jobs', router);
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        const payload = { id: 'http-survival', kind: 'image', origin: { avatar: 'Narrator.png', file: 'origin', integrity: 'http-origin' }, message: { name: 'Narrator', is_user: false, mes: '', extra: {} }, chatRequest: { chat_completion_source: 'custom', custom_url: providerUrl + '/v1', model: 'mock', messages: [{ role: 'user', content: 'Describe visitor' }] }, image: { url: providerUrl, workflow: '{"text":"%prompt%"}', prefix: 'photo of {prompt}', folder: 'Narrator', messageTemplate: '{{prompt}}' } };
        await new Promise((resolve, reject) => {
            const req = http.request(base + '/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close' } }, res => { assert.equal(res.statusCode, 202); res.resume(); res.on('end', () => { req.destroy(); resolve(); }); });
            req.on('error', reject); req.end(JSON.stringify(payload));
        });
        const duplicate = await fetch(base + '/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); assert.equal(duplicate.status, 202);
        let job;
        for (let n = 0; n < 80; n++) { job = await (await fetch(base + '/jobs/http-survival')).json(); if (['completed', 'failed', 'conflict'].includes(job.status)) break; await delay(20); }
        assert.equal(job.status, 'completed', job.error);
        assert.equal(modelCalls, 1); assert.equal(imageCalls, 1); assert.equal(interrupts, 0);
        const rows = fs.readFileSync(file, 'utf8').split('\n').map(JSON.parse);
        assert.equal(rows.filter(row => row.extra?.generation_job === payload.id).length, 1);
        assert.match(rows.at(-1).mes, /gray coat/); assert.ok(rows.at(-1).extra.media[0].url);
        assert.equal((await fetch(base + '/jobs/a.b')).status, 400);
        assert.equal((await fetch(base + '/jobs/a.b/cancel', { method: 'POST' })).status, 400);
        const { protectJobResults } = await import('../src/generation-jobs.js');
        assert.equal(protectJobResults(file, rows.slice(0, -1)).length, 2, 'an observed completion can be deliberately deleted');
    } finally { server.closeAllConnections(); provider.closeAllConnections(); await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => provider.close(resolve))]); fs.rmSync(root, { recursive: true, force: true }); }
});
