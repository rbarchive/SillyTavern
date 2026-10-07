import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeNativeHistory, nativePrefixBoundary, nativeProviderCoverage, nativeRowHash } from '../src/endpoints/backends/native-history.js';
import { nativeSession, assembleContextMessages, sourcesFor } from '../src/endpoints/backends/context-memory.js';
import { emptyCategorizedMemory } from '../src/endpoints/backends/categorized-session-memory.js';
const scope={world:'fixture',story:'mixed',branch:'main'};
const fixture=()=>[
 {chat_metadata:{integrity:'fixture'}},{is_user:false,mes:''},
 {is_user:false,is_system:true,mes:'image prompt: 왕관을 씀',extra:{media:[{source:'generated',type:'image'}]}},
 {is_user:false,mes:'인사'},
 {is_user:true,mes:'창고로 가자',extra:{rp_memory:{role:'director',intent:'scene'}}},
 {is_user:false,mes:''},
 {is_user:true,mes:'열쇠는 내가 가지고 있어',extra:{rp_memory:{role:'protagonist'}}},
 {is_user:false,mes:'창고로 이동했다'},
 {is_user:false,mes:'문은 아직 잠겼다'},
 {is_user:false,is_system:true,mes:'이미지: 왕관',extra:{media:[{source:'generated',generation_type:1,type:'image'}]}},
 {is_user:true,mes:'문을 열게'},
];
test('mixed archive preserves every actual text and provenance, without media prompt becoming story',()=>{
 const rows=fixture(),before=structuredClone(rows),s=normalizeNativeHistory(rows);
 assert.deepEqual(rows,before);assert.equal(s.messages.length,3);assert.deepEqual(s.messages[0].source_rows,[4,6]);
 assert.match(s.messages[0].content,/director/);assert.match(s.messages[0].content,/protagonist/);assert.match(s.messages[0].content,/창고로 가자/);assert.match(s.messages[0].content,/열쇠는 내가/);
 assert.deepEqual(s.messages[1].source_rows,[7,8]);assert.doesNotMatch(JSON.stringify(s.messages),/왕관/);
 assert.equal(nativePrefixBoundary(s,1),10);assert.equal(s.anchors.length,rows.length);assert.equal(s.completedThrough,1);
 assert.equal(s.opening[0].content,'인사');assert.deepEqual(s.auxiliary.map(r=>r.source_row),[1,2,5,9]);
});
test('checkpoint boundary drops exactly normalized covered units, retains unprocessed input',()=>{
 const rows=fixture(),session=nativeSession(rows);const memory={...emptyCategorizedMemory(scope),through_turn:1};
 const result=assembleContextMessages([{role:'system',content:'world'}],session,{summary:memory},scope,'world');
 const body=result.messages.filter(x=>x.role!=='system').map(x=>x.content).join('\n');
 assert.match(body,/문을 열게/);assert.doesNotMatch(body,/창고로 가자|열쇠는 내가|문은 아직 잠겼다|왕관/);
 assert.deepEqual(Object.keys(sourcesFor(session.messages,1)),['t1u','t1a']);
});
test('provider coverage allows exact ST same-role joins and text blocks, rejects missing/reordered/forged input',()=>{
 const rows=fixture();const messages=[{role:'system',content:'rules'},{role:'user',content:'[Start a new chat]'},{role:'assistant',content:'인사'},
 {role:'user',content:'창고로 가자\n\n열쇠는 내가 가지고 있어'}, {role:'assistant',content:'창고로 이동했다\n\n문은 아직 잠겼다'},
 {role:'user',content:[{type:'text',text:'문을 열게'}]},{role:'assistant',content:'</think>\n\n'}];
 assert.deepEqual(nativeProviderCoverage(rows,messages),{firstRow:3,rows:11});
 assert.deepEqual(nativeProviderCoverage(rows,[{role:'user',content:'문을 열게'}]),{firstRow:10,rows:11});
 for(const bad of [messages.map((r,i)=>i===3?{...r,content:'열쇠는 내가 가지고 있어\n\n창고로 가자'}:r),[...messages.slice(0,-1),{role:'user',content:'문을 열게'}],[{role:'user',content:'날조'}],[{role:'user',content:'문을 열게',tool_calls:[]}],messages.filter((_,i)=>i!==4)]) assert.equal(nativeProviderCoverage(rows,bad),null);
});
test('skipped and media-only edits invalidate exact archive anchors; metadata changes also invalidate',()=>{
 const rows=fixture();for(const i of [1,2,5,9]){const before=nativeRowHash(rows[i]);const changed=structuredClone(rows[i]);changed.mes+='수정';assert.notEqual(nativeRowHash(changed),before);}
 const img=structuredClone(rows[9]);img.extra.media[0].source='uploaded';assert.notEqual(nativeRowHash(img),nativeRowHash(rows[9]));
 const changed=structuredClone(rows[6]);changed.extra.rp_memory.role='administrator';assert.notEqual(nativeRowHash(changed),nativeRowHash(rows[6]));
});
test('user image attachment text remains actual user input',()=>{
 const s=normalizeNativeHistory([{chat_metadata:{}},{is_user:true,mes:'이 장소로 가자',extra:{media:[{type:'image',source:'uploaded'}]}}]);assert.equal(s.messages[0].content,'이 장소로 가자');
});

import { runContextMemoryTurn } from '../src/endpoints/backends/context-memory-runner.js';
test('mixed archive writer succeeds with source-row boundary and raw recovery on failure',async()=>{
 for (const fail of [false,true]) {
  const rows=fixture();rows[4].mes+='가'.repeat(650);rows[7].mes+='나'.repeat(650);
  rows.push({is_user:false,mes:'문을 열었다'},{is_user:true,mes:'창고 안을 보자'});
  const before=structuredClone(rows);let calls=0;
  const result=await runContextMemoryTurn({request:{messages:[{role:'system',content:'world'}]},session:nativeSession(rows),scope,fixedContext:'world',rawBudget:30,consolidationTokenBudget:4096,
   countMessages:async x=>x.reduce((n,r)=>n+r.content.length,0),readSession:()=>nativeSession(rows),update:()=>{},
   saveDialogue:async reply=>rows.push({is_user:false,mes:reply.text}),generate:async(...args)=>{
    calls++;if(calls===1)return{text:'창고 안을 관찰했다'};if(fail)throw new Error('writer failure');
    const p=JSON.parse(args[3].messages[2].content);
    return{text:JSON.stringify({version:1,through_turn:p.through_turn,overview:'창고로 이동했다.',current_state:{upsert:[],remove:[]},events:{upsert:[{id:'move',text:'창고로 이동했다.',sources:['t1a']}],remove:[]},knowledge:{upsert:[],remove:[]}})};
   }});
  assert.equal(calls,2);assert.deepEqual(rows.slice(0,before.length),before);
  assert.equal(result.sessionSummary.status,fail?'failed':'complete');
  if(fail)assert.equal(result.sessionSummary.keepRaw,true);
  else assert.equal(result.sessionSummary.targetAnchor.length,nativePrefixBoundary(nativeSession(rows),result.sessionSummary.summary.through_turn));
 }
});

test('image attached to existing assistant preserves actual scene text',()=>{
 const rows=[{chat_metadata:{}},{is_user:true,mes:'문을 열게'},{is_user:false,mes:'문을 열었다',extra:{media:[{source:'generated',generation_type:1,type:'image'}]}},{is_user:true,mes:'들어가자'}];
 const s=normalizeNativeHistory(rows);assert.equal(s.messages[1].content,'문을 열었다');assert.equal(s.messages.length,3);
 assert.ok(nativeProviderCoverage(rows,[{role:'assistant',content:'문을 열었다'},{role:'user',content:'들어가자'}]));
});

test('visible standalone image prompt is auxiliary; changing classification invalidates anchor',()=>{
 const image={is_user:false,is_system:false,mes:'그림 프롬프트',extra:{image_generation_prompt:'그림 프롬프트',media:[{source:'generated',type:'image'}]}};
 const rows=[{chat_metadata:{}},{is_user:true,mes:'출발하자'},{is_user:false,mes:'출발했다'},image,{is_user:true,mes:'계속'}];
 const session=normalizeNativeHistory(rows);assert.equal(session.messages.length,3);assert.doesNotMatch(JSON.stringify(session.messages),/그림 프롬프트/);assert.equal(nativePrefixBoundary(session,1),4);
 const attached={...image,mes:'출발했다'};assert.equal(normalizeNativeHistory([{chat_metadata:{}},{is_user:true,mes:'출발'},attached]).messages[1].content,'출발했다');
 assert.notEqual(nativeRowHash(attached),nativeRowHash(image));
 const changed=structuredClone(image);changed.extra.image_generation_prompt='다른 그림';assert.notEqual(nativeRowHash(changed),nativeRowHash(image));
});
