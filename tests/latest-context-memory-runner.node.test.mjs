import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runContextMemoryTurn } from '../src/endpoints/backends/context-memory-runner.js';
import { nativeSession } from '../src/endpoints/backends/context-memory.js';
import { latestStateJournalPath } from '../src/endpoints/backends/latest-state-overlay.js';
for (const fail of [false, true]) test(`latest state ${fail ? 'failure' : 'success'} is independent of skipped consolidation`, async () => {
 const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-latest-'));
 try {
  const scope = { world: 'test', story: 'test', branch: 'main' };
  const rows = [{chat_metadata:{integrity:'test'}},{is_user:false,mes:'인사'},{is_user:true,mes:'같이 가자'}];
  const events=[]; const phases=[]; let committed=false;
  const result=await runContextMemoryTurn({latestStateEnabled:true, latestStateStorageRoot:root,request:{model:'qwen',messages:[{role:'system',content:'고정 설정'},{role:'user',content:'같이 가자'}]},session:nativeSession(rows),scope,fixedContext:'고정 설정',rawBudget:4096,countMessages:async()=>100,readSession:()=>nativeSession(rows),signal:new AbortController().signal,update:x=>events.push(x),saveDialogue:async reply=>{committed=true;rows.push({is_user:false,mes:reply.text});},generate:async (_r,_s,progress,params,phase)=>{
   phases.push(phase);assert.equal(params.max_tokens,8192);assert.equal(params.response_format,undefined);
   if(phase==='dialogue'){assert.equal(committed,false);return {text:'같이 가겠다고 답했다'};}
   assert.equal(committed,true);progress({preview:'internal',event:'firstToken',inputProgress:{fraction:0.5},reading:true});
   if(fail)throw Error('writer failed');return {text:'- 현재: 동행하기로 합의했다',finishReason:'stop'};
  }});
  assert.deepEqual(phases,['dialogue','latest-state']);assert.equal(result.sessionSummary.status,'skipped');assert.equal(result.sessionSummary.keepRaw,true);
  assert.equal(result.sessionSummary.memoryOutcome.latestStateStatus,fail?'failed':'complete');
  assert.ok(events.every(x=>x.preview===undefined&&x.event!=='firstToken'));
  if(!fail){const journal=JSON.parse(fs.readFileSync(latestStateJournalPath(scope,root),'utf8'));assert.equal(journal.card.asOfTurn,1);assert.equal(journal.messages,undefined);assert.equal(journal.reply,undefined);assert.ok(journal.actorPrefixRevision);}
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('real background runner forwards only content-free phase stats and coded failure', async () => {
 const { recordPhaseDiagnostics, diagnosticJob, finishPhaseDiagnostics } = await import('../src/generation-job-diagnostics.js');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'rp-diagnostic-runner-'));
 try {
  const scope={world:'fixture',story:'fixture',branch:'main'};
  const rows=[{chat_metadata:{}},...Array.from({length:7},(_,i)=>({is_user:i%2===0,mes:'가'.repeat(800)}))];
  const job={createdAt:new Date().toISOString(),progress:{}}; const events=[];
  const result=await runContextMemoryTurn({latestStateEnabled:true,latestStateStorageRoot:root,request:{model:'qwen',messages:[{role:'user',content:rows.at(-1).mes}]},session:nativeSession(rows),scope,fixedContext:'세계',rawBudget:4096,consolidationTokenBudget:2000,memoryWireFormat:'compact-v2',countMessages:async xs=>xs.reduce((n,x)=>n+x.content.length,0),readSession:()=>nativeSession(rows),update:x=>{events.push(x);recordPhaseDiagnostics(job,x);if(x.workPhase)job.progress.workPhase=x.workPhase;},saveDialogue:async r=>rows.push({is_user:false,mes:r.text}),generate:async (_r,_s,progress,_params,phase)=>{
   if(phase==='dialogue')return{text:'답'.repeat(800)};
   progress({event:'firstContent',receivedAt:Date.now(),preview:'PRIVATE_WRITER_OUTPUT',modelStats:{inputTokens:42,outputTokens:12,finishReason:'stop'}});
   return{text:phase==='latest-state'?'- 현재 상태: 이동 준비중':'{"v":2,"t":999}',finishReason:'stop'};
  }});
  finishPhaseDiagnostics(job);
  assert.equal(result.sessionSummary.errorCode,'COMPACT_TURN_MISMATCH');
  assert.equal(result.sessionSummary.turnDiagnostic.returnedTurn,999);
  assert.ok(Number.isSafeInteger(result.sessionSummary.turnDiagnostic.expectedTurn));
  for(const phase of ['latest-state','episodic']){assert.equal(job.phaseDiagnostics[phase].modelStats.inputTokens,42);assert.ok(Number.isFinite(job.phaseDiagnostics[phase].firstContentMs));}
  assert.ok(!JSON.stringify(events).includes('PRIVATE_WRITER_OUTPUT'));
  assert.ok(!JSON.stringify(diagnosticJob(job)).includes('PRIVATE_WRITER_OUTPUT'));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
