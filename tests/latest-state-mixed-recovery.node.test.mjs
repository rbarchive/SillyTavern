import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nativeSession } from '../src/endpoints/backends/context-memory.js';
import { prepareLatestActor, updateLatestState, readLatestState } from '../src/endpoints/backends/latest-state-overlay.js';
test('obsolete source card is not consumed and can be safely rebuilt; in-flight edits still reject',async t=>{
 const storageRoot=fs.mkdtempSync(path.join(os.tmpdir(),'rp-mixed-state-'));t.after(()=>fs.rmSync(storageRoot,{recursive:true,force:true}));
 const scope={world:'fixture',story:'mixed',branch:'main'};const rows=[{chat_metadata:{}},{is_user:true,mes:'문을 열게'},{is_user:false,mes:'문을 열었다'}];
 const base={messages:[{role:'system',content:'world'},{role:'user',content:'다음'}]};
 const run=async(edit=false)=>{
  const session=nativeSession(rows);const actor=prepareLatestActor(base,{session,scope,storageRoot});
  const result=await updateLatestState({actor,reply:{text:'응답'},session,scope,storageRoot,readSession:()=>nativeSession(rows),generate:async()=>{if(edit)rows[1].mes='도중 편집';return{text:'- 위치: 기록관\n- 원본은 기록관에 있다.'};}});return {actor,result};
 };
 assert.equal((await run()).result.status,'complete');assert.ok(readLatestState({scope,session:nativeSession(rows),storageRoot}));
 rows[1].mes='원본은 기록관에 둬';assert.equal(readLatestState({scope,session:nativeSession(rows),storageRoot}),null);
 const rebuilt=await run();assert.equal(rebuilt.result.status,'complete');assert.doesNotMatch(rebuilt.actor.params.messages[1].content,/이전 턴 종료 상태/);
 assert.ok(readLatestState({scope,session:nativeSession(rows),storageRoot}));
 assert.equal((await run(true)).result.status,'conflict');
});

test('source edit after actor preparation is rejected before rebuilding a stale card',async t=>{
 const storageRoot=fs.mkdtempSync(path.join(os.tmpdir(),'rp-mixed-race-'));t.after(()=>fs.rmSync(storageRoot,{recursive:true,force:true}));
 const scope={world:'fixture',story:'race',branch:'main'};const rows=[{chat_metadata:{}},{is_user:true,mes:'계획'}];
 const actor=prepareLatestActor({messages:[{role:'user',content:'계획'}]},{scope,storageRoot,session:nativeSession(rows)});
 rows[1].mes='실행은 취소';rows.push({is_user:false,mes:'취소했다'});let calls=0;
 const result=await updateLatestState({actor,reply:{text:'취소했다'},session:nativeSession(rows),readSession:()=>nativeSession(rows),scope,storageRoot,generate:async()=>{calls++;return {text:'- 위치: 기록관'};}});
 assert.equal(result.status,'conflict');assert.equal(calls,0);
});
