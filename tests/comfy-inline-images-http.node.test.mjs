import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';
import express from 'express';
import { setConfigFilePath } from '../src/util.js';
setConfigFilePath(path.resolve('default/config.yaml'));
const { router } = await import('../src/endpoints/stable-diffusion.js');
const { closeLocalImageRuntime } = await import('../src/endpoints/local-image-runtime.js');

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=','base64');
const workflow=()=>JSON.stringify({prompt:{10:{class_type:'ETN_LoadImageBase64',inputs:{image:png.toString('base64')}},12:{class_type:'VAEEncode',inputs:{pixels:['10',0]}},3:{class_type:'KSampler',inputs:{latent_image:['12',0],denoise:0.35}}}});

// Both a fake owned process and an unmanaged HTTP fixture run this real multipart handler.
function comfyHandler(req,res,record,faults={}){
    const chunks=[];
    req.on('data',chunk=>chunks.push(chunk));
    req.on('end',()=>{
        const body=Buffer.concat(chunks);
        res.setHeader('Content-Type','application/json');
        if(req.url==='/system_stats')return res.end('{}');
        if(req.url==='/interrupt'){record({event:'interrupt'});return res.end('{}');}
        if(req.url==='/queue')return res.end('{"queue_running":[],"queue_pending":[]}');
        if(req.url==='/upload/image'){
            if(faults.uploadFail){record({event:'upload-failed'});res.statusCode=503;return res.end('{}');}
            const boundary=req.headers['content-type'].split('boundary=')[1];
            const parts=body.toString('latin1').split('--'+boundary);
            const file=parts.find(part=>part.includes('name="image"'));
            const filename=file.match(/filename="([^"]+)"/)[1];
            const bytes=Buffer.from(file.slice(file.indexOf('\r\n\r\n')+4,-2),'latin1');
            const overwrite=parts.find(part=>part.includes('name="overwrite"')).split('\r\n\r\n')[1].trim();
            record({event:'upload',port:req.socket.localPort,filename,bytes:bytes.toString('base64'),overwrite});
            const reply=()=>res.end(JSON.stringify({name:faults.unsafeName?'../bad.png':filename,type:'input',subfolder:''}));
            if(faults.delayUpload)return setTimeout(reply,150);
            return reply();
        }
        if(req.url==='/prompt'){
            record({event:'prompt',port:req.socket.localPort,graph:JSON.parse(body).prompt});
            return res.end('{"prompt_id":"own-synthetic"}');
        }
        if(req.url==='/history/own-synthetic')return res.end(JSON.stringify({'own-synthetic':{status:{status_str:'success'},outputs:{9:{images:[{filename:'own.png',subfolder:'',type:'output'}]}}}}));
        if(req.url.startsWith('/view'))return res.end('synthetic pixel');
        res.statusCode=404;res.end('{}');
    });
}

async function freePort(){const server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}

test('actual HTTP generation uploads selected pixels to the same managed or direct Comfy server',async()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'st-inline-http-'));
    const port=await freePort();
    const eventsFile=path.join(root,'events.jsonl');
    const main=path.join(root,'fake-comfy.mjs');
    fs.writeFileSync(main,`import http from 'node:http';import fs from 'node:fs';const port=${port};const record=value=>fs.appendFileSync(${JSON.stringify(eventsFile)},JSON.stringify(value)+'\\n');${comfyHandler.toString()};http.createServer((req,res)=>comfyHandler(req,res,record)).listen(port,'127.0.0.1',()=>console.log('To see the GUI go to: http://127.0.0.1:'+port));process.on('SIGTERM',()=>process.exit(0));`);
    process.env.SILLYTAVERN_LOCALIMAGERUNTIME=JSON.stringify({enabled:true,sourceUrl:'http://127.0.0.1:6550',port,python:process.execPath,main,modelPaths:path.join(root,'models.yaml'),dataDirectory:path.join(root,'managed')});
    const app=express();app.use(express.json({limit:'2mb'}));app.use('/sd',router);
    const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
    const base=`http://127.0.0.1:${server.address().port}/sd/comfy/generate`;
    const directEvents=[],faults={};const direct=http.createServer((req,res)=>comfyHandler(req,res,item=>directEvents.push(item),faults));await new Promise(resolve=>direct.listen(0,'127.0.0.1',resolve));
    const request=(url,prompt=workflow())=>fetch(base,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url,boost:true,prompt})});
    try{
        const managed=await request('http://127.0.0.1:6550');assert.equal(managed.status,200);assert.equal((await managed.json()).format,'png');
        const managedEvents=fs.readFileSync(eventsFile,'utf8').trim().split('\n').map(JSON.parse);
        assert.deepEqual(managedEvents.map(item=>item.event),['upload','prompt']);
        assert.ok(managedEvents.every(item=>item.port===port));
        const response=await request(`http://127.0.0.1:${direct.address().port}`);assert.equal(response.status,200);
        assert.deepEqual(directEvents.map(item=>item.event),['upload','prompt']);
        for(const events of [managedEvents,directEvents]){
            assert.equal(events[0].bytes,png.toString('base64'));assert.equal(events[0].overwrite,'false');
            assert.equal(events[1].graph['10'].class_type,'LoadImage');assert.equal(events[1].graph['10'].inputs.image,events[0].filename);
            assert.deepEqual(events[1].graph['12'].inputs.pixels,['10',0]);assert.equal(events[1].graph['3'].inputs.denoise,0.35);
        }
        const directUrl=`http://127.0.0.1:${direct.address().port}`;
        directEvents.length=0;
        const ordinary=await request(directUrl,JSON.stringify({prompt:{3:{class_type:'EmptyLatentImage',inputs:{}}}}));assert.equal(ordinary.status,200);
        assert.deepEqual(directEvents.map(item=>item.event),['prompt']);
        for(const fault of ['uploadFail','unsafeName']){
            directEvents.length=0;faults[fault]=true;
            const failed=await request(directUrl);assert.equal(failed.status,500);
            assert.ok(!directEvents.some(item=>item.event==='prompt'));
            delete faults[fault];
        }
        directEvents.length=0;
        const invalid=JSON.parse(workflow());invalid.prompt['10'].inputs.image=['another-node',0];
        const failed=await request(directUrl,JSON.stringify(invalid));assert.equal(failed.status,500);assert.equal(directEvents.length,0);
        faults.delayUpload=true;directEvents.length=0;
        const cancelled=new AbortController();
        const pending=fetch(base,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:directUrl,boost:true,prompt:workflow()}),signal:cancelled.signal}).catch(error=>error);
        while(!directEvents.some(item=>item.event==='upload'))await new Promise(resolve=>setTimeout(resolve,5));
        cancelled.abort();assert.equal((await pending).name,'AbortError');
        await new Promise(resolve=>setTimeout(resolve,200));
        assert.deepEqual(directEvents.map(item=>item.event),['upload']);

    }finally{await closeLocalImageRuntime();await new Promise(resolve=>server.close(resolve));await new Promise(resolve=>direct.close(resolve));fs.rmSync(root,{recursive:true,force:true});delete process.env.SILLYTAVERN_LOCALIMAGERUNTIME;}
});
