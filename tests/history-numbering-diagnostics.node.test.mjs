import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeNativeHistory } from '../src/endpoints/backends/native-history.js';
import { buildDeltaRequest } from '../src/endpoints/backends/context-memory.js';
import { emptyCategorizedMemory } from '../src/endpoints/backends/categorized-session-memory.js';
import { buildNumberingDiagnostic, diagnosticJob } from '../src/generation-job-diagnostics.js';
import { persistFailureDiagnostic, listFailureDiagnostics } from '../src/generation-failure-diagnostics.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const secret='PRIVATE_HISTORICAL_TEXT';
function fixture() {
 const rows=[{chat_metadata:{}},{is_user:false,mes:secret}];
 for(let turn=1;turn<=15;turn++){
  rows.push({is_user:true,mes:secret});
  if(turn===2)rows.push({is_user:false,is_system:true,mes:secret,extra:{media:[{source:'generated'}]}});
  if(turn===4)rows.push({is_user:false,mes:''},{is_user:true,mes:secret});
  rows.push({is_user:false,mes:secret});
  if(turn===7)rows.push({is_user:false,mes:secret});
 }
 const session=normalizeNativeHistory(rows),memory=emptyCategorizedMemory({world:'test',story:'test',branch:'main'});memory.through_turn=9;
 const selected=session.messages.filter(row=>row.turn>=10&&row.turn<=13);
 const prepared=buildDeltaRequest({}, {fixedContext:'',memory,messages:selected,wireFormat:'compact-v2'});
 return {session,memory,selected,prepared};
}
test('historical image, empty/interrupted and same-role rows preserve one logical numbering system',()=>{
 const {session,memory,selected,prepared}=fixture();
 const diag=buildNumberingDiagnostic(prepared,selected,memory,session);
 assert.equal(session.completedThrough,15);assert.equal(diag.previousThroughTurn,9);assert.equal(diag.requestedThroughTurn,13);assert.equal(diag.payloadThroughTurn,13);assert.equal(diag.payloadPreviousThroughTurn,9);assert.equal(diag.requestMatchesPayload,true);
 assert.deepEqual(diag.selectedRows.map(row=>row.turn),[10,10,11,11,12,12,13,13]);
 assert.deepEqual(diag.payloadRows.map(row=>row.turn),diag.selectedRows.map(row=>row.turn));
 assert.ok(diag.selectedRows[0].nativeRows[0]>20,'native row positions diverge from logical turn numbers');
 assert.deepEqual(diag.auxiliaryRows.map(row=>row.kind),['media-artifact','empty']);
 assert.ok(!JSON.stringify(diag).includes(secret));
 assert.ok(!JSON.stringify(diag).includes('t10u'));assert.ok(!JSON.stringify(diag).includes('protagonist'));
});
test('numbering diagnostics detect a payload/request disagreement without content',()=>{
 const {session,memory,selected,prepared}=fixture();
 const user=prepared.request.messages.find(row=>row.role==='user'),payload=JSON.parse(user.content);payload.through_turn=9;user.content=JSON.stringify(payload);
 const diag=buildNumberingDiagnostic(prepared,selected,memory,session);assert.equal(diag.requestMatchesPayload,false);assert.equal(diag.requestedThroughTurn,13);assert.equal(diag.payloadThroughTurn,9);
 payload.through_turn=13;payload.new_completed_prefix[0].source=99;user.content=JSON.stringify(payload);assert.equal(buildNumberingDiagnostic(prepared,selected,memory,session).requestMatchesPayload,false);
});
test('numbering coordinates survive safe failure archive and unknown fields are removed',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'st-numbering-diagnostic-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const f=fixture(),numberingDiagnostic=buildNumberingDiagnostic(f.prepared,f.selected,f.memory,f.session);
 const job={id:'test',status:'completed',sessionSummary:{status:'failed',errorCode:'COMPACT_TURN_MISMATCH',numberingDiagnostic:{...numberingDiagnostic,content:secret},keepRaw:true}};
 assert.ok(!JSON.stringify(diagnosticJob(job)).includes(secret));assert.equal(persistFailureDiagnostic(root,job),true);
 const read=await listFailureDiagnostics(root);assert.equal(read.failures[0].diagnostic.summary.numberingDiagnostic.requestMatchesPayload,true);assert.equal(read.failures[0].diagnostic.summary.numberingDiagnostic.previousThroughTurn,9);assert.ok(!JSON.stringify(read).includes(secret));
});

test('historical reconstruction distinguishes previous boundary from target and blocks edited history',async t=>{
 const { latestFailedNumbering }=await import('../src/generation-jobs.js');
 const { nativePrefixBoundary }=await import('../src/endpoints/backends/native-history.js');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'st-numbering-history-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const rows=[{chat_metadata:{integrity:'fixture'}},{is_user:false,mes:secret}];
 for(let turn=1;turn<=15;turn++){
  rows.push({is_user:true,mes:secret});if(turn===2)rows.push({is_user:false,is_system:true,mes:secret,extra:{media:[{source:'generated'}]}});
  if(turn===4)rows.push({is_user:false,mes:''},{is_user:true,mes:secret});rows.push({is_user:false,mes:secret});
 }
 const session=normalizeNativeHistory(rows),memory=emptyCategorizedMemory({world:'test',story:'test',branch:'main'});memory.through_turn=9;
 const user={directories:{root,chats:path.join(root,'chats')}};const chat=path.join(root,'chats/card/chat.jsonl');fs.mkdirSync(path.dirname(chat),{recursive:true});
 fs.writeFileSync(chat,rows.map(JSON.stringify).join('\n'));fs.mkdirSync(path.join(root,'generation-jobs'));
 const origin={avatar:'card.png',file:'chat',integrity:'fixture'};
 const previous={id:'previous',origin,status:'completed',createdAt:'2026-10-08T00:00:00.000Z',updatedAt:'2026-10-08T00:01:00.000Z',prefixAnchor:session.anchors.slice(0,nativePrefixBoundary(session,9)),sessionSummary:{status:'complete',mode:'context-v1',contextKey:'scope',usable:true,summary:memory}};
 const failed={id:'failure',origin,status:'completed',createdAt:'2026-10-08T00:02:00.000Z',updatedAt:'2026-10-08T00:03:00.000Z',summaryAnchor:session.anchors,sessionSummary:{status:'failed',mode:'context-v1',contextKey:'scope',errorCode:'COMPACT_TURN_MISMATCH',turnDiagnostic:{expectedTurn:13,returnedType:'number',returnedTurn:9}}};
 for(const job of [previous,failed])fs.writeFileSync(path.join(root,'generation-jobs',job.id+'.json'),JSON.stringify(job));
 const result=await latestFailedNumbering(user);assert.equal(result.available,true);assert.equal(result.historyUnchanged,true);assert.equal(result.exactPayloadObserved,false);assert.equal(result.numbering.previousThroughTurn,9);assert.equal(result.numbering.requestedThroughTurn,13);assert.equal(result.returnedMatchesPrevious,true);assert.equal(result.returnedMatchesSelectedTurn,false);assert.notDeepEqual(result.returnedNativeRows,result.requestedNativeRows);assert.ok(!JSON.stringify(result).includes(secret));
 rows.push({is_user:true,mes:secret});fs.writeFileSync(chat,rows.map(JSON.stringify).join('\n'));assert.equal((await latestFailedNumbering(user)).available,true);
 rows[3].mes='edited';fs.writeFileSync(chat,rows.map(JSON.stringify).join('\n'));assert.deepEqual(await latestFailedNumbering(user),{available:false,reason:'HISTORICAL_SOURCE_CHANGED'});
});
