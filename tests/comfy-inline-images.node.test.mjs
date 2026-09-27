import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareInlineComfyImages } from '../src/comfy-inline-images.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const workflow = () => JSON.stringify({ prompt: { 10: { class_type: 'ETN_LoadImageBase64', inputs: { image: png.toString('base64') } },
    12: { class_type: 'VAEEncode', inputs: { pixels: ['10', 0] } }, 3: { class_type: 'KSampler', inputs: { latent_image: ['12', 0], denoise: 0.35 } } } });

test('native adapter uploads exact pixels to chosen runtime and retains graph connections and strength', async () => {
    const calls = [];
    const result = JSON.parse(await prepareInlineComfyImages(workflow(), 'http://127.0.0.1:8191', undefined, async (url,options) => {
        calls.push({url,options});
        assert.deepEqual(Buffer.from(await options.body.get('image').arrayBuffer()), png);
        assert.equal(options.body.get('type'),'input');
        assert.equal(options.body.get('overwrite'),'false');
        assert.match(options.body.get('image').name,/^st-reference-[a-f0-9]{64}\.png$/);
        return {ok:true,json:async()=>({name:options.body.get('image').name,subfolder:'',type:'input'})};
    }));
    assert.equal(calls[0].url.toString(), 'http://127.0.0.1:8191/upload/image');
    assert.equal(result.prompt['10'].class_type,'LoadImage');
    assert.deepEqual(result.prompt['12'].inputs.pixels,['10',0]);
    assert.deepEqual(result.prompt['3'].inputs.latent_image,['12',0]);
    assert.equal(result.prompt['3'].inputs.denoise,0.35);
    assert.ok(!JSON.stringify(result).includes(png.toString('base64')));
});

test('ordinary workflow passes byte-for-byte with no upload', async () => {
    const input='{"prompt":{"1":{"class_type":"EmptyLatentImage","inputs":{}}}}';
    assert.equal(await prepareInlineComfyImages(input,'http://127.0.0.1:8191',undefined,()=>{throw Error('unexpected fetch')}),input);
});

test('invalid bytes, upload failure and unsafe returned names fail rather than using another image', async () => {
    const broken=JSON.parse(workflow());broken.prompt['10'].inputs.image='bm90YW5pbWFnZQ==';
    await assert.rejects(prepareInlineComfyImages(JSON.stringify(broken),'http://127.0.0.1:8191'),/supported image/);
    await assert.rejects(prepareInlineComfyImages(workflow(),'http://127.0.0.1:8191',undefined,async()=>({ok:false,status:503})),/503/);
    for(const result of [{name:'../secret.png',type:'input'},{name:'good.png',subfolder:'../bad',type:'input'},{name:'good.png',type:'output'}]) {
        await assert.rejects(prepareInlineComfyImages(workflow(),'http://127.0.0.1:8191',undefined,async()=>({ok:true,json:async()=>result})),/unsafe/);
    }
});

test('abort before upload has no side effects; duplicate pixel nodes upload once', async () => {
    const controller=new AbortController();controller.abort();let calls=0;
    await assert.rejects(prepareInlineComfyImages(workflow(),'http://127.0.0.1:8191',controller.signal,async()=>{calls++}),/abort/i);
    assert.equal(calls,0);
    const repeated=JSON.parse(workflow());repeated.prompt['11']=structuredClone(repeated.prompt['10']);
    const result=JSON.parse(await prepareInlineComfyImages(JSON.stringify(repeated),'http://127.0.0.1:8191',undefined,async()=>{calls++;return{ok:true,json:async()=>({name:'own.png',type:'input'})}}));
    assert.equal(calls,1);assert.deepEqual(result.prompt['10'].inputs,result.prompt['11'].inputs);
});
