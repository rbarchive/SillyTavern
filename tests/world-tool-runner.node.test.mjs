import test from 'node:test';
import assert from 'node:assert/strict';
import { runWorldToolTurn, decideWorldTool } from '../src/endpoints/backends/world-tool-runner.js';
import { readGenerationResponse } from '../src/endpoints/backends/generation-stream.js';
const call = (name = 'Read') => ({ id: 'c1', type: 'function', function: { name, arguments: '{}' } });
const answer = calls => ({ choices: [{ message: calls ? { tool_calls: calls } : { content: '완료.' } }] });
function fixture(mode = 'server') {
 const events = []; let writes = 0, valid = true, round = 0;
 const controller = new AbortController();
 return { user: { directories: { root: '/tmp/owner' } }, id: 'unit', scope: {}, signal: controller.signal, controller, events,
 input: { model: 'm', messages: [{ role: 'user', content: '요청' }], tools: [{ function: { name: 'Read' } }] },
 adapter: { validate() { if (!valid) throw Error('changed'); }, mode: () => mode, async invoke() { writes++; return '기록'; } },
 update: async e => { events.push(e); }, generate: async () => ++round === 1 ? answer([call()]) : answer(),
 get writes() { return writes; }, invalidate() { valid = false; } };
}
async function pending(f) { while (!f.events.some(e => e.toolPending)) await new Promise(r => setImmediate(r)); return f.events.find(e => e.toolPending).toolPending.token; }
test('server tool round continues without a browser and uses result for reply', async () => {
 const f = fixture(); let n = 0; f.generate = async input => { if (++n === 1) return answer([call()]); assert.equal(input.messages.at(-1).content, '기록'); return answer(); };
 const out = await runWorldToolTurn(f); assert.equal(out.text,'완료.'); assert.equal(f.writes,1); assert.equal(out.toolReceipts.length,1);
});
test('approval is scoped to owner/token, waits, then accepts exactly once', async () => {
 const f = fixture('approval'), p = runWorldToolTurn(f), token = await pending(f);
 assert.equal(f.writes,0); assert.throws(() => decideWorldTool({directories:{root:'/other'}},f.id,{token,approved:true}));
 assert.throws(() => decideWorldTool(f.user,f.id,{token:'bad',approved:true}));
 decideWorldTool(f.user,f.id,{token,approved:true}); assert.throws(() => decideWorldTool(f.user,f.id,{token,approved:true})); await p; assert.equal(f.writes,1);
});
test('denial, scope change and cancellation never write', async () => {
 for (const action of ['deny','changed','cancel']) {
  const f = fixture('approval'), p = runWorldToolTurn(f), token = await pending(f);
  if (action === 'changed') f.invalidate();
  if (action === 'changed') { assert.throws(() => decideWorldTool(f.user,f.id,{token,approved:true})); f.controller.abort(); }
  else if (action === 'cancel') f.controller.abort(); else decideWorldTool(f.user,f.id,{token,approved:action !== 'deny'});
  if (action === 'deny') await p; else await assert.rejects(p);
  assert.equal(f.writes,0); assert.throws(() => decideWorldTool(f.user,f.id,{token,approved:true}));
 }
});
test('unknown, malformed and repeated call IDs fail without replay', async () => {
 for (const action of ['unknown','malformed','repeated']) {
  const f = fixture(); f.generate = async () => { const c = call(action === 'unknown' ? 'Foreign' : 'Read'); if (action === 'malformed') c.function.arguments = '{'; return answer([c]); };
  await assert.rejects(runWorldToolTurn(f)); assert.equal(f.writes,action === 'repeated' ? 1 : 0);
 }
});
test('browser action is claimed once before result', async () => {
 const f = fixture('client'), p = runWorldToolTurn(f), token = await pending(f);
 assert.throws(() => decideWorldTool(f.user,f.id,{token,result:'done'}));
 decideWorldTool(f.user,f.id,{token,claim:true}); assert.throws(() => decideWorldTool(f.user,f.id,{token,claim:true}));
 decideWorldTool(f.user,f.id,{token,result:'done'}); await p; assert.equal(f.writes,0);
});
test('fragmented streamed tool arguments assembled; ordinary stream rejects tools', async () => {
 const frames = [{index:0,id:'abc',type:'function',function:{name:'Read',arguments:'{"x":'}},{index:0,id:'abc',function:{name:'Read',arguments:'1}'}}];
 const response = () => ({ headers:{get:()=> 'text/event-stream'}, body:(async function*(){for(const c of frames) yield Buffer.from('data: '+JSON.stringify({choices:[{delta:{tool_calls:[c]}}]})+'\n\n');yield Buffer.from('data: [DONE]\n\n');})() });
 const data = await readGenerationResponse(response(),()=>{},{allowToolCalls:true});
 assert.deepEqual(data.choices[0].message.tool_calls,[{id:'abc',type:'function',function:{name:'Read',arguments:'{"x":1}'}}]);
 await assert.rejects(readGenerationResponse(response()),/does not support/);
});
