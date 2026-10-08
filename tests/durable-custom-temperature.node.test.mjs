import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../src/endpoints/backends/durable-custom.js',import.meta.url),'utf8');
const fn=source.slice(source.indexOf('export async function runCustomGeneration(')).replace('export async function','async function');
for(const native of [true,false])for(const [phase,temperature,expected] of [['dialogue',0.7,0.7],['dialogue',0,0],['latest-state',0.7,0],['episodic',0.7,0],[undefined,0.9,0.9]])test(`${native?'native':'HTTP'} ${phase??'ordinary'} generation uses expected temperature ${expected}`,async()=>{
 let seen,calls=0;
 const data={model:'qwen3.8-27b-uncensored-mlx',usage:{prompt_tokens:10,completion_tokens:2},choices:[{finish_reason:'stop',message:{content:'합성 응답'}}]};
 const context={splitStructuredSessionResponse:()=>{},getConfigValue:()=>false,structuredClone,AbortController,setTimeout,clearTimeout,Date,URL,
  readSecret:()=>'',SECRET_KEYS:{CUSTOM:'CUSTOM'},mergeObjectWithYaml:()=>{},excludeKeysByYaml:()=>{},embedOpenRouterMedia:()=>{},ensureQwenUserQuery:rows=>rows,prepareLocalDialogueParams:x=>x,
  generateLocalWithProgress:async params=>{seen=params;calls++;return data;},
  fetch:async (_url,options)=>{seen=JSON.parse(options.body);calls++;return {ok:true};},urlJoin:(a,b)=>a+b,readGenerationResponse:async()=>data,extractGenerationReply:()=>({text:'합성 응답'}),getConfigValue:()=>false};
 const run=vm.runInNewContext(fn+'\nrunCustomGeneration',context);
 const input={chat_completion_source:'custom',custom_url:'http://127.0.0.1:9998/v1',model:data.model,messages:[{role:'user',content:'합성 질문'}],temperature,top_p:0.8};const before=structuredClone(input);
 await run(input,{directories:{}},undefined,()=>{},{workPhase:phase,nativeOptions:native?{}:undefined});
 assert.equal(seen.temperature,expected);assert.equal(calls,1);assert.deepEqual(input,before);
});
test('writer temperature override is applied after prepared request selection',async()=>{
 let seen;
 const data={usage:{},choices:[{finish_reason:'stop',message:{content:'합성 기록'}}]};
 const context={splitStructuredSessionResponse:()=>{},getConfigValue:()=>false,structuredClone,AbortController,setTimeout,clearTimeout,Date,readSecret:()=>'',SECRET_KEYS:{CUSTOM:''},mergeObjectWithYaml:()=>{},excludeKeysByYaml:()=>{},embedOpenRouterMedia:()=>{},ensureQwenUserQuery:x=>x,prepareLocalDialogueParams:x=>x,generateLocalWithProgress:async params=>{seen=params;return data;},extractGenerationReply:()=>({text:'합성 기록'})};
 const run=vm.runInNewContext(fn+'\nrunCustomGeneration',context);
 const base={chat_completion_source:'custom',model:'qwen3.8-27b-uncensored-mlx',messages:[{role:'user',content:'합성'}],temperature:0.8};
 await run(base,{directories:{}},undefined,()=>{},{workPhase:'episodic',nativeOptions:{},preparedParams:{model:base.model,messages:base.messages,temperature:0.6}});
 assert.equal(seen.temperature,0);assert.equal(base.temperature,0.8);
});
