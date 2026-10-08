import test from 'node:test';import assert from 'node:assert/strict';
import {buildDeltaRequest,mergeMemoryDelta}from '../src/endpoints/backends/context-memory.js';
import {emptyCategorizedMemory}from '../src/endpoints/backends/categorized-session-memory.js';
const scope={world:'w',story:'s',branch:'b'};const messages=[{id:'t2u',turn:2,role:'user',content:'진료소에 도착해 전달을 완료했다. 동행 약속은 다음에도 유지한다.'},{id:'t2a',turn:2,role:'assistant',content:'현재 진료소. 이번 전달은 끝났다.'}];
const sources={t1u:{turn:1,role:'user',text:'창고에서 출발 전이며 전달이 남았다.'},t1a:{turn:1,role:'assistant',text:'다음 위험한 이동에도 동행하기로 약속했다.'},...Object.fromEntries(messages.map(m=>[m.id,{turn:m.turn,role:m.role,text:m.content}]))};
function fixture(overview=''){
 const memory=emptyCategorizedMemory(scope);memory.through_turn=1;memory.overview=overview;
 memory.current_state=[{id:'s1',text:'창고 안.',sources:['t1u']},{id:'s2',text:'이번 전달은 미완료.',sources:['t1u']},{id:'s3',text:'다음 위험한 이동에도 동행 약속은 유효.',sources:['t1a']}];
 memory.events=[{id:'e1',text:'다음 위험한 이동에는 함께 가기로 약속했다.',sources:['t1a']}];memory.knowledge=[{id:'k1',text:'전달이 남았다고 말했다.',sources:['t1u'],holder:'서윤',basis:'claim'}];
 const prepared=buildDeltaRequest({model:'qwen'},{fixedContext:'세계',memory,messages,wireFormat:'state-snapshot-v3'});const row=r=>[r.id,r.text,r.sources.map(id=>prepared.sourceTable.indexOf(id))];return{memory,prepared,row};
}
test('snapshot computes disjoint state changes, preserves unaffected state and full old history',()=>{
 const {memory,prepared,row}=fixture();const before=structuredClone(memory);const value={v:3,t:2,current_state_snapshot:[['s1','진료소 안.',[0,1]],row(memory.current_state[2])],e:[['e2','이번 전달 완료.',[0,1]]]};
 const next=mergeMemoryDelta(JSON.stringify(value),prepared,memory,sources);assert.deepEqual(memory,before);assert.deepEqual(next.current_state.map(x=>x.id),['s1','s3']);assert.equal(next.current_state[0].text,'진료소 안.');assert.deepEqual(next.current_state[1],memory.current_state[2]);assert.deepEqual(next.events[0],memory.events[0]);assert.deepEqual(next.knowledge,memory.knowledge);assert.equal(next.through_turn,2);
});
test('identical complete snapshot retains overview without inventing an overview change',()=>{
 const {memory,prepared,row}=fixture('전달 대기.');const next=mergeMemoryDelta(JSON.stringify({v:3,t:2,current_state_snapshot:memory.current_state.map(row)}),prepared,memory,sources);assert.deepEqual(next.current_state,memory.current_state);assert.equal(next.overview,memory.overview);
});
test('state-only change requires explicit overview handling; failure does not advance checkpoint',()=>{
 const {memory,prepared}=fixture('전달 대기.');const before=structuredClone(memory);const value={v:3,t:2,current_state_snapshot:[['s1','진료소 안.',[0,1]]]};assert.throws(()=>mergeMemoryDelta(JSON.stringify(value),prepared,memory,sources),/overview/);assert.deepEqual(memory,before);const next=mergeMemoryDelta(JSON.stringify({...value,o:''}),prepared,memory,sources);assert.equal(next.overview,'');assert.equal(next.current_state.length,1);
});
test('missing snapshot is rejected; explicit empty snapshot clears only active states',()=>{
 const {memory,prepared}=fixture();assert.throws(()=>mergeMemoryDelta('{"v":3,"t":2}',prepared,memory,sources),/snapshot/);const next=mergeMemoryDelta('{"v":3,"t":2,"current_state_snapshot":[]}',prepared,memory,sources);assert.deepEqual(next.current_state,[]);assert.deepEqual(next.events,memory.events);assert.deepEqual(next.knowledge,memory.knowledge);
});
test('invalid snapshot, legacy state operations and duplicate IDs are never repaired',()=>{
 const {memory,prepared,row}=fixture();const valid={v:3,t:2,current_state_snapshot:memory.current_state.map(row)},before=structuredClone(memory);
 for(const value of [{...valid,s:[]},{...valid,x:[['s','s1']]},{...valid,current_state_snapshot:null},{...valid,current_state_snapshot:[['s1','장면',[999]]]},{...valid,current_state_snapshot:[row(memory.current_state[0]),row(memory.current_state[0])]},{...valid,t:3},{...valid,unknown:true}]){assert.throws(()=>mergeMemoryDelta(JSON.stringify(value),prepared,memory,sources));assert.deepEqual(memory,before);}
 assert.throws(()=>mergeMemoryDelta('{"v":3,"t":2,"current_state_snapshot":[],"current_state_snapshot":[]}',prepared,memory,sources),/Duplicate/);
});
test('valid snapshot plus invalid event or knowledge cannot partially apply state changes',()=>{
 const {memory,prepared}=fixture(),before=structuredClone(memory),valid={v:3,t:2,current_state_snapshot:[['s1','진료소 안.',[0,1]]]};for(const delta of [{e:[['e2','bad',[999]]]},{k:[['k2','bad',[0],'서윤','fact']]},{e:[['e1','new',[0]]],x:[['e','e1']]}]){assert.throws(()=>mergeMemoryDelta(JSON.stringify({...valid,...delta}),prepared,memory,sources));assert.deepEqual(memory,before);}
});
test('opt-in builder preserves all previous active states and keeps server-owned compact and legacy-default contracts separate',()=>{
 const {memory,prepared,row}=fixture();const input=JSON.parse(prepared.request.messages[2].content);assert.deepEqual(input.previous_memory.current_state_snapshot,memory.current_state.map(row));assert.equal(Object.hasOwn(input.previous_memory,"s"),false);assert.deepEqual(input.requested_output,{v:3,t:prepared.throughTurn});assert.equal(prepared.request.response_format,undefined);assert.equal(prepared.request.max_tokens,8192);
 const options={fixedContext:'세계',memory,messages};const legacy=buildDeltaRequest({model:'qwen'},options),compact=buildDeltaRequest({model:'qwen'},{...options,wireFormat:'compact-v2'});assert.equal(legacy.wireFormat,'legacy-v1');assert.equal(compact.wireFormat,'compact-v2');assert.match(compact.request.messages[1].content,/v:4/);assert.throws(()=>mergeMemoryDelta('{"v":3,"t":2,"current_state_snapshot":[]}',compact,memory,sources));
});

test('snapshot input preserves prior boundary and sources while naming only the requested output target',()=>{
 const {memory,prepared}=fixture();const before=structuredClone(memory);const args={fixedContext:'세계',memory,messages};
 const compact=buildDeltaRequest({model:'qwen'},{...args,wireFormat:'compact-v2'});
 const prior=JSON.parse(compact.request.messages[2].content),aligned=JSON.parse(prepared.request.messages[2].content);
 assert.notEqual(aligned.previous_memory.t,aligned.requested_output.t);assert.equal(aligned.requested_output.t,aligned.through_turn);
 assert.deepEqual(prior.requested_output,{v:4});assert.equal(Object.hasOwn(prior.previous_memory,'current_state_snapshot'),false);
 aligned.previous_memory.s=aligned.previous_memory.current_state_snapshot;delete aligned.previous_memory.current_state_snapshot;delete aligned.requested_output;delete prior.requested_output;
 assert.deepEqual(aligned,prior);assert.deepEqual(prepared.sourceTable,compact.sourceTable);assert.deepEqual(memory,before);
});
test('event rows have three fields; an extra basis or numeric field rejects the entire snapshot',()=>{
 const {memory,prepared,row}=fixture();const before=structuredClone(memory);
 const value={v:3,t:prepared.throughTurn,current_state_snapshot:memory.current_state.map(row),e:[['e2','이번 전달 완료.',[0,1]]]};
 assert.equal(mergeMemoryDelta(JSON.stringify(value),prepared,memory,sources).events.at(-1).id,'e2');
 for(const extra of ['observed',1]){
  const invalid=structuredClone(value);invalid.e[0].push(extra);
  assert.throws(()=>mergeMemoryDelta(JSON.stringify(invalid),prepared,memory,sources),/compact row/);assert.deepEqual(memory,before);
 }
});
