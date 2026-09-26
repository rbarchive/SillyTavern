import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { router } from '../src/endpoints/image-description.js';

test('real HTTP catalog, actual inference test, generation and invalid input stay image-only', async () => {
 const calls=[]; const upstream=express(); upstream.use(express.json());
 upstream.get('/api/v1/models',(req,res)=>res.json({models:[{key:'gemma',type:'llm',loaded_instances:[{id:'gemma',config:{context_length:8192}}]},{key:'embedding',type:'embedding'}]}));
 upstream.post('/v1/chat/completions',(req,res)=>{calls.push(req.body);res.json({model:'gemma',choices:[{finish_reason:'stop',message:{content:'Adult visitor wearing a gray coat, brown hair, white stone office.'}}]});});
 const provider=upstream.listen(0,'127.0.0.1');await new Promise(r=>provider.once('listening',r));
 const app=express();app.use(express.json());app.use('/image',router);const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const settings={mode:'dedicated',url:`http://127.0.0.1:${provider.address().port}/v1`,model:'gemma',context_length:8192,max_tokens:512};
 const request=async(route,body)=>fetch(`http://127.0.0.1:${server.address().port}/image/${route}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 try {
  assert.deepEqual((await (await request('models',{settings})).json()).models.map(m=>m.key),['gemma']);assert.equal(calls.length,0);
  const checked=await (await request('test',{settings})).json();assert.equal(checked.model,'gemma');assert.equal(calls.length,1);assert.ok(checked.totalMs>=0);
  const result=await (await request('generate',{settings,messages:[{role:'user',content:'Brown hair. Gray coat.'}],model:'main',custom_url:'http://wrong'})).json();assert.equal(result.model,'gemma');assert.match(result.text,/gray coat/);assert.equal(calls.length,2);
  assert.equal(calls[1].model,'gemma');assert.equal(calls[1].max_tokens,512);assert.equal(calls[1].reasoning_effort,'none');
  assert.equal((await request('generate',{settings:{...settings,url:'http://bad/api'},messages:[{role:'user',content:'portrait'}]})).status,400);assert.equal(calls.length,2);
 } finally {server.closeAllConnections();provider.closeAllConnections();await Promise.all([new Promise(r=>server.close(r)),new Promise(r=>provider.close(r))]);}
});
