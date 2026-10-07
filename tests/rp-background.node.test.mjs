import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareRpBackground } from '../src/endpoints/backends/rp-background.js';
const source = {chat_completion_source:'custom', rp_memory_prefix_world:'WORLD'};
const body = () => ({model:'qwen3.8-27b-uncensored-mlx', messages:[{role:'system',content:'rules\nWORLD\nroles'},{role:'user',content:'real input'}], tools:[{type:'function'}], max_tokens:9000, max_completion_tokens:null, stream:true,n:4});
test('foreground retains all content and history but creates a stable world boundary',()=>{
 const b=body();prepareRpBackground(b,source);
 assert.deepEqual(b.messages.map(x=>x.content),['rules\nWORLD','\nroles','real input']);
 assert.equal(b.max_tokens,9000);assert.equal(b.stream,true);
});
test('warm overrides YAML-like conflicts, retains tools, emits only stable prefix and one token',()=>{
 const b=body();prepareRpBackground(b,{...source,rp_memory_background:'warm'});
 assert.deepEqual(b.messages.map(x=>x.content),['rules\nWORLD','\nroles','Continue.']);
 assert.equal(b.max_tokens,1);assert.equal(b.max_completion_tokens,1);assert.equal(b.n,1);assert.equal(b.stream,false);
 assert.deepEqual(b.tools,[{type:'function'}]);assert.equal(b.chat_template_kwargs.enable_thinking,false);
});
test('ambiguous warm cannot silently run a different prefix',()=>{
 const b=body();b.messages[0].content='WORLD WORLD';
 assert.throws(()=>prepareRpBackground(b,{...source,rp_memory_background:'warm'}));
});
test('curator final request ignores body overrides and has no tool output',()=>{
 const b=body();const messages=[{role:'system',content:'curator'},{role:'user',content:'transcript'}];
 prepareRpBackground(b,{...source,rp_memory_background:'curator',messages});
 assert.deepEqual(b.messages,messages);assert.equal(b.max_tokens,1600);assert.equal(b.max_completion_tokens,1600);assert.equal(b.tools,undefined);
});

test('final YAML model changes fail closed for background only',()=>{
 const b=body();b.model='another-model';assert.throws(()=>prepareRpBackground(b,{...source,rp_memory_background:'warm'}));assert.doesNotThrow(()=>prepareRpBackground(b,source));
});
test('warm rejects a world outside the leading system prefix',()=>{
 const b=body();b.messages=[{role:'system',content:'rules'},{role:'user',content:'input'},{role:'system',content:'WORLD'}];
 assert.throws(()=>prepareRpBackground(b,{...source,rp_memory_background:'warm'}));
});
