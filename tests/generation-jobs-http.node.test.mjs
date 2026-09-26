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
        modelCalls++; assert.equal(req.body.stream, true); assert.equal(req.body.max_tokens, 512); assert.match(req.body.messages[0].content, /No roleplay/); assert.match(req.body.messages[1].content, /Describe visitor/); if (req.body.model === 'qwen3-mock') { assert.equal(req.body.messages.at(-1).role, 'assistant'); assert.equal(req.body.messages.at(-1).content, '<think>\n\n</think>\n\n'); }
        if (req.body.model === 'truncated') { res.type('text/event-stream'); return res.end('data: {\"choices\":[{\"delta\":{\"content\":\"unfinished\"},\"finish_reason\":\"length\"}]}\n\ndata: {\"choices\":[],\"usage\":{\"completion_tokens\":512}}\n\ndata: [DONE]\n\n'); }
        if (req.body.model === 'reasoning-only') return res.json({ choices: [{ finish_reason: 'stop', message: { content: '', reasoning_content: 'private thinking' } }] });
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
        const payload = { id: 'http-survival', kind: 'image', origin: { avatar: 'Narrator.png', file: 'origin', integrity: 'http-origin' }, message: { name: 'Narrator', is_user: false, mes: '', extra: {} }, chatRequest: { chat_completion_source: 'custom', custom_url: providerUrl + '/v1', model: 'qwen3-mock', messages: [{ role: 'user', content: 'Describe visitor' }], custom_include_body: 'max_tokens: 8192' }, image: { url: providerUrl, workflow: '{"text":"%prompt%"}', prefix: 'photo of {prompt}', folder: 'Narrator', messageTemplate: '{{prompt}}' } };
        payload.image.imageContext = { version: 1, sourceKind: 'requested_prompt', scope: { worldId: 'synthetic-world', storyId: 'synthetic-story', branchId: 'main' }, appearanceRevision: 'synthetic-appearance', referenceIds: ['synthetic-image-A', 'synthetic-image-B'], sceneLocation: 'synthetic-cafe', contextCharacterIds: ['keeper'] };
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
        assert.deepEqual(rows.at(-1).extra.media[0].image_context, payload.image.imageContext);
        assert.equal(rows.at(-1).extra.image_generation_prompt, rows.at(-1).mes);
        for (const model of ['truncated', 'reasoning-only']) {
            const failed = { ...payload, id: model, chatRequest: { ...payload.chatRequest, model } };
            assert.equal((await fetch(base + '/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(failed) })).status, 202);
            let rejected;
            for (let n = 0; n < 50; n++) { rejected = await (await fetch(base + '/jobs/' + model)).json(); if (rejected.status === 'failed') break; await delay(10); }
            assert.equal(rejected.status, 'failed');
            assert.equal(imageCalls, 1, 'incomplete/empty description must not reach Comfy');
        }
        assert.equal((await fetch(base + '/jobs/a.b')).status, 400);
        assert.equal((await fetch(base + '/jobs/a.b/cancel', { method: 'POST' })).status, 400);
        const { protectJobResults } = await import('../src/generation-jobs.js');
        assert.equal(protectJobResults(file, rows.slice(0, -1)).length, 2, 'an observed completion can be deliberately deleted');
    } finally { server.closeAllConnections(); provider.closeAllConnections(); await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => provider.close(resolve))]); fs.rmSync(root, { recursive: true, force: true }); }
});


test('stream preview is observable before completion and disconnect does not lose final reply', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-preview-http-'));
    const directories = { root, chats: path.join(root, 'chats'), groupChats: path.join(root, 'groups'), userImages: path.join(root, 'images') };
    fs.mkdirSync(path.join(directories.chats, 'Narrator'), { recursive: true });
    const file = path.join(directories.chats, 'Narrator', 'origin.jsonl');
    fs.writeFileSync(file, [{ chat_metadata: { integrity: 'preview-origin' } }, { name: 'User', mes: 'Hello', is_user: true }].map(JSON.stringify).join('\n'));
    const provider = express(); provider.use(express.json());
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    provider.post('/chat/completions', async (req, res) => {
        assert.equal(req.body.stream, true);
        res.setHeader('Content-Type', 'text/event-stream');
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] }) + '\n\n');
        await gate;
        res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: ' world' } }] }) + '\n\ndata: [DONE]\n\n');
    });
    const upstream = provider.listen(0, '127.0.0.1'); await new Promise(resolve => upstream.once('listening', resolve));
    const app = express(); app.use(express.json()); app.use((req, res, next) => { req.user = { directories }; next(); }); app.use('/jobs', router);
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/jobs`;
    try {
        const payload = { image: { descriptionSettings: { mode: 'dedicated', url: 'http://invalid', model: 'gemma', context_length: 0 } }, id: 'preview', kind: 'chat', origin: { avatar: 'Narrator.png', file: 'origin', integrity: 'preview-origin' }, message: { name: 'Narrator', mes: '', extra: {} }, chatRequest: { chat_completion_source: 'custom', custom_url: `http://127.0.0.1:${upstream.address().port}`, model: 'mock', stream: true, messages: [{ role: 'user', content: 'hello' }] } };
        assert.equal((await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })).status, 202);
        let job;
        for (let n = 0; n < 50; n++) { job = await (await fetch(base + '/preview')).json(); if (job.preview) break; await delay(10); }
        assert.equal(job.status, 'running'); assert.equal(job.preview, 'Hello');
        assert.equal(fs.readFileSync(file, 'utf8').split('\n').length, 2, 'partial preview is not saved in chat');
        assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'generation-jobs/preview.json'))).preview, undefined);
        release();
        for (let n = 0; n < 50; n++) { job = await (await fetch(base + '/preview')).json(); if (job.status === 'completed') break; await delay(10); }
        assert.equal(job.status, 'completed', job.error); assert.equal(job.result.text, 'Hello world');
        assert.ok(job.timings.firstToken <= job.timings.modelComplete); assert.ok(job.timings.committed >= job.timings.modelComplete);
        const summary = (await (await fetch(base)).json())[0];
        assert.equal(summary.message, undefined); assert.equal(summary.anchor, undefined); assert.equal(summary.result, undefined);
        assert.equal(fs.readFileSync(file, 'utf8').split('\n').map(JSON.parse).filter(row => row.extra?.generation_job === 'preview').length, 1);
    } finally { release(); server.closeAllConnections(); upstream.closeAllConnections(); await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => upstream.close(resolve))]); fs.rmSync(root, { recursive: true, force: true }); }
});
