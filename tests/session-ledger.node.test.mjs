import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLedgerMessages, ledgerRevision, applyLedgerPatch, applyLedgerReceipt, chooseImportantEvidence, additionalEvidenceRows, splitExperimentalResponse, ledgerAsSummary, checkEvidenceSummary, EVIDENCE_RESPONSE_SCHEMA } from '../src/endpoints/backends/session-ledger.js';
const seed = () => ({ version:2, anchor:'world:story:hash', fields:{'scene.time':'저녁','object.token.holder':'윤','knowledge.code.value':'청람','knowledge.code.knowers':'주인공·엘린만','task.compare.status':'completed','task.compare.participants':'주인공·엘린'} });
const sources = {u:{role:'user',text:'시간은 밤이다. 같은 대조는 완료했다.'}, request:{role:'user',text:'표식을 엘린에게 건네달라고 부탁했다.'}};
const patch = (state, changes=[]) => ({version:2,base_revision:ledgerRevision(state),changes});
const change = (id,value,source='u',quote='시간은 밤이다.') => ({id,value,source,quote,kind:'completed'});
test('empty and partial patches preserve secrets, holders, participants and completed records without mutating seed',()=>{
 const s=seed(),before=structuredClone(s);assert.deepEqual(applyLedgerPatch(s,patch(s),sources),s);
 const n=applyLedgerPatch(s,patch(s,[change('scene.time','밤')]),sources);assert.equal(n.fields['scene.time'],'밤');assert.equal(n.fields['object.token.holder'],'윤');assert.equal(n.fields['knowledge.code.value'],'청람');assert.equal(n.fields['knowledge.code.knowers'],'주인공·엘린만');assert.equal(n.fields['task.compare.status'],'completed');assert.equal(n.fields['task.compare.participants'],'주인공·엘린');assert.deepEqual(s,before);
});
test('stale anchor/revision, unknown IDs, invented evidence and conflicts fail atomically',()=>{
 const s=seed(),before=structuredClone(s);
 for(const p of [{...patch(s),base_revision:'stale'},patch(s,[change('unknown.id','x')]),patch(s,[change('scene.time','밤','missing')]),patch(s,[change('scene.time','밤','u','없는 문장')]),patch(s,[change('scene.time','밤'),change('scene.time','낮')])])assert.throws(()=>applyLedgerPatch(s,p,sources));
 const other={...s,anchor:'other-story'};assert.throws(()=>applyLedgerPatch(other,patch(s),sources));assert.deepEqual(s,before);
});
test('request cannot complete handover and completed task cannot reopen without explicit user evidence',()=>{
 const s=seed();assert.throws(()=>applyLedgerPatch(s,patch(s,[{...change('object.token.holder','엘린','request','표식을 엘린에게 건네달라고 부탁했다.'),kind:'request'}]),sources));
 assert.throws(()=>applyLedgerPatch(s,patch(s,[change('task.compare.status','open')]),sources));
 const next=applyLedgerPatch(s,patch(s,[change('task.compare.status','open','reopen','대조를 다시 시작하자.')]),{reopen:{role:'user',text:'대조를 다시 시작하자.'}});assert.equal(next.fields['task.compare.status'],'open');
});
test('same accepted receipt deduplicates only its own anchor and exact resulting state',()=>{
 const s=seed(),p=patch(s,[change('scene.time','밤')]);const a=applyLedgerReceipt(s,p,sources);const b=applyLedgerReceipt(a.state,p,sources,a.receipt);assert.equal(b.duplicate,true);assert.deepEqual(b.state,a.state);
 assert.throws(()=>applyLedgerReceipt({...a.state,anchor:'other'},p,sources,a.receipt));
});
test('a real quote can still misrepresent meaning: CPU check alone is not a semantic proof',()=>{
 const s=seed(),p=patch(s,[change('object.token.holder','엘린','request','표식을 엘린에게 건네달라고 부탁했다.')]);const n=applyLedgerPatch(s,p,sources);assert.equal(n.fields['object.token.holder'],'엘린'); // Deliberate false claim labeled completed. Must fail model semantic TC.
});
test('processed evidence leaves the prompt while pending and explicitly unresolved evidence remain',()=>{
 const rows=Array.from({length:30},(_,i)=>({id:'r'+i,role:i%2?'assistant':'user',text:'표식·비밀·열쇠'}));
 const r=chooseImportantEvidence(rows,{coveredCount:28,unresolvedIds:['r4'],historyIds:['r28','r29']});
 assert.equal(r.usable,true);assert.deepEqual(r.rows,[rows[4]]);
 const pending=chooseImportantEvidence(rows,{coveredCount:26});assert.deepEqual(pending.rows,rows.slice(26));
 const over=chooseImportantEvidence(rows,{coveredCount:0});assert.equal(over.usable,false);assert.equal(over.overflow,true);assert.match(over.reason,/checkpoint/);
 assert.equal(chooseImportantEvidence(rows,{coveredCount:28,maxChars:1}).usable,false);
 assert.throws(()=>chooseImportantEvidence(rows,{coveredCount:31}));assert.throws(()=>chooseImportantEvidence(rows,{unresolvedIds:['missing']}));
 assert.equal(additionalEvidenceRows(rows,rows).length,0);
});
test('planned task detail is allowed only for the same planned task, independent of patch order',()=>{
 const s={version:2,anchor:'task',fields:{'task.relay.status':'미확인','task.relay.agent':'미확인','task.relay.recipient':'미확인','object.token.holder':'윤'}};
 const e={r0:{role:'user',text:'윤에게 하준에게 전달을 부탁할 계획이다.'}};
 const c=(id,value)=>({id,value,source:'r0',quote:e.r0.text,kind:'request'});
 const changes=[c('task.relay.agent','윤'),c('task.relay.recipient','하준'),c('task.relay.status','planned')];
 for(const cs of [changes,[...changes].reverse()]) { const n=applyLedgerPatch(s,patch(s,cs),e);assert.equal(n.fields['task.relay.agent'],'윤');assert.equal(n.fields['task.relay.recipient'],'하준');assert.equal(n.fields['object.token.holder'],'윤'); }
 for(const cs of [[c('task.relay.agent','윤')],[c('object.token.holder','엘린')]])assert.throws(()=>applyLedgerPatch(s,patch(s,cs),e));
 const done={...s,fields:{...s.fields,'task.relay.status':'completed'}};const before=structuredClone(done);
 assert.throws(()=>applyLedgerPatch(done,patch(done,changes),e));assert.deepEqual(done,before);
});
test('user evidence must point to its source: wrong dialogue, combined IDs and stitched quotes reject without changing state', () => {
 const s=seed(),before=structuredClone(s),e={r2:{role:'user',text:'연락 암호는 해류이다. 비공개 번호는 은-17이다.'},d:{role:'assistant',text:'엘린은 고개를 끄덕인다.'}};
 const c=change('knowledge.code.value','해류','r2','연락 암호는 해류이다.');
 assert.equal(applyLedgerPatch(s,patch(s,[c]),e).fields['knowledge.code.value'],'해류');
 for(const bad of [{...c,source:'d'},{...c,source:'r2,d'},{...c,quote:'해류이다. 은-17이다.'}])assert.throws(()=>applyLedgerPatch(s,patch(s,[bad]),e),/Missing evidence/);
 assert.deepEqual(s,before);
});
test('patch JSON stays hidden at every split and visible dialogue survives truncated tail',()=>{
 const s=seed(),response=JSON.stringify({dialogue:'한국어 대사 "밤"',patch:patch(s,[change('scene.time','밤')])});
 for(let i=0;i<response.length;i++){const p=splitExperimentalResponse(response.slice(0,i));assert.ok(!p.text.includes('base_revision'));assert.ok(!p.text.includes('changes'));}
 const done=splitExperimentalResponse(response,{final:true});assert.equal(done.status,'complete');assert.equal(done.text,'한국어 대사 "밤"');
 const cut=splitExperimentalResponse(response.slice(0,-5),{final:true});assert.equal(cut.status,'failed');assert.equal(cut.text,done.text);
 assert.equal(splitExperimentalResponse(response.replace('"patch":','"patch":{},"patch":'),{final:true}).status,'failed');
});
test('normalization preserves all fields and rejects oversize state without silent truncation',()=>{
 const s=seed(),sum=ledgerAsSummary(s);assert.ok(sum.knowledge.join(' ').includes('청람'));assert.ok(sum.facts.join(' ').includes('task.compare.status=completed'));assert.ok(!sum.open_threads.join(' ').includes('task.compare.'));assert.ok(sum.facts.join(' ').includes('윤'));
 const many={...s,fields:Object.fromEntries(Array.from({length:65},(_,i)=>['field.'+i,'x']))};assert.throws(()=>ledgerAsSummary(many));
});

test('evidence quotes are checked independently and evidence schema does not change legacy summary version',()=>{
 const s={version:3,scene:'밤',facts:[],open_threads:[],knowledge:[],evidence:[{statement:'시간은 밤',source:'u',quote:'시간은 밤이다.',kind:'completed'}]};
 assert.equal(checkEvidenceSummary(s,sources).summary.version,1);
 assert.throws(()=>checkEvidenceSummary(s,{}));
 assert.equal(EVIDENCE_RESPONSE_SCHEMA.properties.summary.properties.version.const,3);
});

// Regression for the real completion case: a syntactically valid root object
// can still leak metadata copied inside its dialogue string.
test('embedded metadata stays hidden at every split and invalidates the tail', () => {
    for (const key of ['patch', 'summary']) {
        const dialogue = '엘린은 말한다. "확인은 끝났어요.", "' + key + '": {"version":2,"changes":[]}}';
        const content = JSON.stringify({ dialogue, patch: { version: 2, base_revision: 'x', changes: [] } });
        for (let n = 1; n <= content.length; n++) {
            const value = splitExperimentalResponse(content.slice(0, n));
            assert.ok(!value.text.includes('"' + key + '"'), 'metadata key leaked at split ' + n);
            assert.ok(!value.text.includes('changes'));
        }
        const result = splitExperimentalResponse(content, { final: true });
        assert.equal(result.status, 'failed');
        assert.match(result.error, /embedded/);
        assert.match(result.text, /확인은 끝났어요/);
        assert.ok(!result.text.includes('changes'));
    }
});

test('ledger turn ends in one current query, excludes checkpointed history and preserves CPU provenance',()=>{
 const rows=Array.from({length:31},(_,i)=>({id:'r'+i,role:i%2?'assistant':'user',text:'원문'+i}));
 const r=buildLedgerMessages({world:'세계',state:seed(),rows,coveredCount:30,instructions:'역할'});
 assert.equal(r.messages.at(-1).content,'원문30');assert.equal(r.messages.filter(x=>x.content==='원문30').length,1);assert.equal(r.messages.find(x=>x.role!=='system').role,'user');assert.deepEqual(r.extraIds,[]);assert.deepEqual(r.historyIds,['r30']);assert.ok(!JSON.stringify(r.messages).includes('원문0'));assert.equal(r.sources.r0.text,'원문0');
 const failed=buildLedgerMessages({world:'세계',state:seed(),rows,coveredCount:20});for(let i=20;i<31;i++)assert.ok(failed.messages.some(x=>x.content==='원문'+i));
 assert.throws(()=>buildLedgerMessages({world:'世界',state:seed(),rows,coveredCount:30,unresolvedIds:['r0','r1'],evidenceLimits:{maxRows:1}}),/Processed evidence/);
});

test('pending evidence budget includes rows already placed in history',()=>{
 const rows=Array.from({length:25},(_,i)=>({id:'r'+i,role:i%2?'assistant':'user',text:'x'.repeat(500)}));
 assert.throws(()=>buildLedgerMessages({world:'세계',state:seed(),rows,coveredCount:0,evidenceLimits:{maxRows:1,maxChars:1}}),/checkpoint/);
 assert.equal(chooseImportantEvidence(rows,{historyIds:rows.map(x=>x.id),maxRows:1}).usable,false);
 const within=buildLedgerMessages({world:'세계',state:seed(),rows,coveredCount:24});assert.equal(within.messages.at(-1).content,rows.at(-1).text);
});

test('unknown task placeholders are not open tasks and unread envelope state is retained',()=>{
 const s={version:2,anchor:'emptytask',fields:{'scene.place':'창고','task.compare.status':'미확인','task.compare.place':'미확인','object.envelope.content':'미확인'}};
 const n=ledgerAsSummary(s);assert.deepEqual(n.open_threads,[]);assert.ok(n.facts.join(' ').includes('object.envelope.content=미확인'));
});
