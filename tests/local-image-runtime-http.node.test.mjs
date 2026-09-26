import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import express from 'express';
import { setConfigFilePath } from '../src/util.js';
import { createComfyProcess } from '../src/local-image-runtime.js';
setConfigFilePath(path.resolve('default/config.yaml'));
const { router, runComfyGeneration } = await import('../src/endpoints/stable-diffusion.js');
const { closeLocalImageRuntime } = await import('../src/endpoints/local-image-runtime.js');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('managed HTTP ON/OFF, request disconnect and cancellation drain inference before switching', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-boost-http-'));
    const placeholder = net.createServer().listen(0, '127.0.0.1');
    await new Promise(resolve => placeholder.once('listening', resolve));
    const port = placeholder.address().port; await new Promise(resolve => placeholder.close(resolve));
    const main = path.join(root, 'comfy.mjs');
    fs.writeFileSync(main, `import http from 'node:http'; import fs from 'node:fs';
const args=process.argv.slice(2),port=Number(args[args.indexOf('--port')+1]);
const boost=args.includes('--use-pytorch-cross-attention');
const events=${JSON.stringify(path.join(root, 'events.jsonl'))};
const record=e=>fs.appendFileSync(events,JSON.stringify(e)+'\\n');record({event:'start',boost,args});
let running=false,complete=false;
http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');
 if(req.url==='/system_stats')return res.end('{}');
 if(req.url==='/queue')return res.end(JSON.stringify({queue_running:running?[1]:[],queue_pending:[]}));
 if(req.url==='/prompt'){running=true;complete=false;record({event:'accepted',boost});setTimeout(()=>{running=false;complete=true;record({event:'finished',boost});},350);return res.end(JSON.stringify({prompt_id:'own'}));}
 if(req.url==='/history/own')return res.end(JSON.stringify(complete?{own:{status:{status_str:'success'},outputs:{9:{images:[{filename:'own.png',subfolder:'',type:'output'}]}}}}:{}));
 if(req.url.startsWith('/view'))return res.end('pixel');
 if(req.url==='/interrupt')record({event:'interrupt'});
 res.statusCode=404;res.end('{}');
}).listen(port,'127.0.0.1',()=>console.log('To see the GUI go to: http://127.0.0.1:'+port));
process.on('SIGTERM',()=>{record({event:'stop',running});process.exit(0);});`);
    process.env.SILLYTAVERN_LOCALIMAGERUNTIME = JSON.stringify({ enabled: true, sourceUrl: 'http://127.0.0.1:8188', port,
        python: process.execPath, main, modelPaths: path.join(root, 'models.yaml'), dataDirectory: path.join(root, 'managed') });
    const app = express(); app.use(express.json()); app.use('/sd', router);
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/sd/comfy`;
    const payload = { url: 'http://127.0.0.1:8188', prompt: '{"prompt":{}}' };
    const request = (route, body) => fetch(`${base}/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const events = () => fs.existsSync(path.join(root, 'events.jsonl')) ? fs.readFileSync(path.join(root, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) : [];
    try {
        assert.equal((await request('boost/apply', { ...payload, boost: 'true' })).status, 409);
        const on = await (await request('boost/apply', payload)).json(); assert.equal(on.applied, true); assert.equal(on.ready, true);
        const socket = http.request(`${base}/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
        socket.on('error', () => {}); socket.end(JSON.stringify({ ...payload, boost: true }));
        while (!events().some(e => e.event === 'accepted')) await delay(10);
        socket.destroy();
        const off = await (await request('boost/apply', { ...payload, boost: false })).json(); assert.equal(off.applied, false);
        assert.equal(events().filter(e => e.event === 'finished').length, 1);
        assert.ok(events().every(e => e.event !== 'interrupt' && !(e.event === 'stop' && e.running)));
        const cancelled = new AbortController(); const before = events().filter(e => e.event === 'accepted').length;
        const image = runComfyGeneration({ ...payload, boost: false }, cancelled.signal);
        while (events().filter(e => e.event === 'accepted').length === before) await delay(10);
        cancelled.abort();
        const toggled = request('boost/apply', { ...payload, boost: true });
        assert.equal((await image).format, 'png'); assert.equal((await (await toggled).json()).applied, true);
        const starts = events().filter(e => e.event === 'start');
        assert.deepEqual(starts.map(e => e.boost), [true, false, true]);
        assert.equal(starts[0].args.includes('--cache-none'), false); assert.equal(starts[1].args.includes('--cache-none'), true);
        assert.equal((await (await request('boost/status', { url: 'http://example.org:8188' })).json()).supported, false);
    } finally {
        await closeLocalImageRuntime(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
        delete process.env.SILLYTAVERN_LOCALIMAGERUNTIME; fs.rmSync(root, { recursive: true, force: true });
    }
});

test('unwritable log is a contained startup failure and owned child is cleaned up', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-boost-log-error-'));
    fs.mkdirSync(path.join(root, 'server.log'));
    const server = net.createServer().listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    const port = server.address().port; await new Promise(resolve => server.close(resolve));
    const main = path.join(root, 'wait.mjs'); fs.writeFileSync(main, 'setInterval(()=>{},1000);');
    const backend = createComfyProcess({ sourceUrl: 'http://127.0.0.1:8188', port, python: process.execPath, main,
        modelPaths: path.join(root, 'models'), dataDirectory: root });
    try {
        await assert.rejects(backend.start(true), /시작에 실패/);
        assert.equal(backend.alive(), false); assert.match(backend.error(), /EISDIR/);
    } finally { await backend.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});
