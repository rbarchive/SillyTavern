import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {buildDeltaRequest,mergeMemoryDelta,nativeSession,sourcesFor} from '../src/endpoints/backends/context-memory.js';
import {emptyCategorizedMemory} from '../src/endpoints/backends/categorized-session-memory.js';
import {decodeCompactDelta} from '../src/endpoints/backends/compact-memory-delta.js';
import {runContextMemoryTurn} from '../src/endpoints/backends/context-memory-runner.js';
const scope={world:'synthetic',story:'existing',branch:'main'};
function fixture(){
 const memory=emptyCategorizedMemory(scope);memory.through_turn=8;
 const messages=Array.from({length:26},(_,i)=>({id:`t${Math.floor(i/2)+1}${i%2?'a':'u'}`,turn:Math.floor(i/2)+1,role:i%2?'assistant':'user',content:`기록 ${i}`}));
 memory.events=[{id:'prior',text:'이전 사건',sources:['t1u','t8a']}];
 const prepared=buildDeltaRequest({}, {fixedContext:'세계',memory,messages:messages.slice(16),wireFormat:'compact-v2'});
 return {memory,prepared,sources:sourcesFor(messages,13)};
}
test('server binds a t-free writer result to its immutable requested boundary, retaining existing memory',()=>{
 const {memory,prepared,sources}=fixture(),before=structuredClone(memory);
 assert.equal(prepared.throughTurn,13);assert.equal(prepared.serverOwnedThroughTurn,true);
 const input=JSON.parse(prepared.request.messages[2].content);assert.deepEqual(input.requested_output,{v:4});
 assert.equal(input.new_completed_prefix[0].turn,9);assert.equal(input.new_completed_prefix.at(-1).source,9);
 const next=mergeMemoryDelta('{"v":4,"e":[["new","최신 사건",[8,9]]]}',prepared,memory,sources);
 assert.equal(next.through_turn,13);assert.deepEqual(next.events[0],memory.events[0]);assert.deepEqual(next.events[1].sources,['t13u','t13a']);assert.deepEqual(memory,before);
 // A previous response is not relabelled; only a new server-bound contract is accepted.
 for(const payload of [{v:2,t:9},{v:4,t:9},{v:4,through_turn:13},{v:4,e:[['new','내용',[99]]]},{v:4,e:[['prior','내용',[0]]],x:[['e','prior']]}])assert.throws(()=>mergeMemoryDelta(JSON.stringify(payload),prepared,memory,sources));
 for(const throughTurn of [8,7,13.5,-1,NaN])assert.throws(()=>mergeMemoryDelta('{"v":4}',{...prepared,throughTurn},memory,sources),/boundary/);
 const legacy={...prepared};delete legacy.serverOwnedThroughTurn;
 assert.equal(decodeCompactDelta({v:2,t:13},legacy,memory).through_turn,13);
 assert.throws(()=>decodeCompactDelta({v:2,t:9},legacy,memory),e=>e.code==='COMPACT_TURN_MISMATCH');
 assert.throws(()=>mergeMemoryDelta('{"v":4}',prepared,{...memory,overview:'동시 갱신'},sources),/Stale/);
 assert.deepEqual(memory,before);
});
for(const latestStateEnabled of [false,true])test(`existing failed backlog retries from old checkpoint and progresses in chunks (latest=${latestStateEnabled})`,async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'boundary-recovery-'));
 try{
  const rows=[{chat_metadata:{}},...Array.from({length:40},(_,i)=>({is_user:i%2===0,mes:`가상 기록${i}`})),{is_user:true,mes:'다음 질문'}];
  let memory=emptyCategorizedMemory(scope);memory.through_turn=8;memory.events=[{id:'prior',text:'옛 약속',sources:['t1u','t8a']}];
  const before=structuredClone(rows), original=structuredClone(memory);let attempt=0;
  const ranges=[];
  for(const invalid of [true,false,false]){
   let calls=0;const result=await runContextMemoryTurn({latestStateEnabled,latestStateStorageRoot:root,scope,previous:{summary:memory},session:nativeSession(rows),fixedContext:'가상 세계',rawBudget:2000,consolidationTokenBudget:1200,memoryWireFormat:'compact-v2',request:{messages:[{role:'user',content:rows.at(-1).mes}]},countMessages:async xs=>xs.length*200,readSession:()=>nativeSession(rows),update:()=>{},saveDialogue:async r=>rows.push({is_user:false,mes:r.text}),generate:async (_r,_signal,_progress,params,phase)=>{
    calls++;if(!params||phase==='dialogue')return {text:'가상 답변'};
    if(phase==='latest-state')return {text:'- 현재: 가상 장면',finishReason:'stop'};
    const input=JSON.parse(params.messages[2].content);ranges.push([input.previous_memory.t,input.new_completed_prefix[0].turn,input.through_turn]);
    return {text:JSON.stringify({v:4,e:[[`new${++attempt}`,'가상 변화',invalid?[999]:[0,1]]]}),finishReason:'stop'};
   }});
   assert.equal(calls,latestStateEnabled?3:2);assert.deepEqual(rows.slice(0,before.length),before);
   if(invalid){assert.equal(result.sessionSummary.status,'failed');assert.equal(result.sessionSummary.keepRaw,true);assert.equal(result.sessionSummary.summary,undefined);assert.deepEqual(memory,original);}
   else{assert.equal(result.sessionSummary.status,'complete');const next=result.sessionSummary.summary;assert.equal(next.through_turn,memory.through_turn+3);assert.deepEqual(next.events[0],original.events[0]);memory=next;}
   rows.push({is_user:true,mes:'계속'});
  }
  assert.deepEqual(ranges,[[8,9,11],[8,9,11],[11,12,14]]);assert.equal(memory.through_turn,14);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
