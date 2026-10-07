import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acceptJob, cancelJob, getJob, latestSessionSummary, sessionSummarySourceCoverage, compactSessionMessages } from '../src/generation-jobs.js';

const summary = { version: 1, scene: '역의 대합실', facts: ['문이 잠겼다'], open_threads: ['열쇠를 찾는다'], knowledge: ['민수는 소문을 들었다'] };
const output = { message: { mes: '보이는 답변', is_user: false }, result: { text: '보이는 답변' } };

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inline-summary-job-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const user = { directories: { root, chats: path.join(root, 'chats'), groupChats: path.join(root, 'group chats') } };
    const file = path.join(user.directories.chats, 'card', 'chat.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const rows = [{ chat_metadata: { integrity: 'identity' } }, { mes: '질문', is_user: true }];
    const write = value => fs.writeFileSync(file, value.map(row => JSON.stringify(row)).join('\n'));
    write(rows);
    return { user, file, write, origin: { avatar: 'card.png', file: 'chat', integrity: 'identity' } };
}

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function waitFor(user, id, predicate) {
    for (let n = 0; n < 100; n++) {
        const job = await getJob(user, id);
        if (predicate(job)) return job;
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error(`job ${id} did not reach expected state`);
}

test('persists exact observed provider timestamps and only available sanitized usage', async t => {
    const f = fixture(t);
    await acceptJob(f.user, { id: 'observed-metrics', origin: f.origin }, async ({ update }) => {
        const epoch = Date.now() - 1000;
        update({ event: 'firstContent', receivedAt: epoch + 10 });
        update({ event: 'streamMetrics', streamMetrics: { requestedAt: epoch, firstContentAt: epoch + 10, serverFirstVisibleAt: epoch + 15, completedAt: epoch + 20, secret: 'not saved' } });
        update({ event: 'modelComplete', modelStats: { inputTokens: 20, outputTokens: 5, cachedTokens: 12, finishReason: 'stop', privateField: 'not saved' } });
        return output;
    });
    const job = await waitFor(f.user, 'observed-metrics', job => job.status === 'completed');
    assert.equal(job.timings.provider_firstContentAt - job.timings.provider_requestedAt, 10);
    assert.equal(job.timings.provider_serverFirstVisibleAt - job.timings.provider_requestedAt, 15);
    assert.equal(job.timings.firstContent, job.timings.provider_firstContentAt);
    assert.equal(Object.hasOwn(job.timings, 'provider_firstReasoningAt'), false);
    assert.equal(Object.hasOwn(job.timings, 'provider_secret'), false);
    assert.deepEqual(job.modelStats, { inputTokens: 20, outputTokens: 5, cachedTokens: 12, finishReason: 'stop' });
});

test('persists visible dialogue before the delayed summary and resolves coverage', async t => {
    const f = fixture(t); const gate = deferred();
    await acceptJob(f.user, { id: 'two-phase', origin: f.origin }, async ({ update }) => {
        update({ dialogueOutput: output, event: 'dialogueComplete' });
        await gate.promise;
        return { sessionSummary: { status: 'complete', summary } };
    });
    const running = await waitFor(f.user, 'two-phase', job => job.dialogueReady === true);
    assert.equal(running.status, 'running');
    assert.deepEqual(running.sessionSummary, { status: 'pending' });
    let rows = fs.readFileSync(f.file, 'utf8').split('\n').map(JSON.parse);
    assert.equal(rows.length, 3);
    assert.equal(rows.at(-1).mes, output.message.mes);

    rows.at(-1).extra.generation_job_processed = true;
    f.write(rows);
    rows.push({ mes: '사용자 후속 질문', is_user: true });
    f.write(rows);
    gate.resolve();
    const done = await waitFor(f.user, 'two-phase', job => job.status === 'completed');
    assert.deepEqual(done.sessionSummary, { status: 'complete', summary });
    const saved = fs.readFileSync(f.file, 'utf8').split('\n').map(JSON.parse);
    assert.equal(saved.at(-2).mes, output.message.mes);
    assert.equal(saved.at(-2).extra.generation_job_processed, true);
    assert.equal(saved.at(-1).mes, '사용자 후속 질문');
    const latest = await latestSessionSummary(f.user, f.origin);
    assert.deepEqual(latest.summary, summary);
    assert.equal(latest.coveredRows, 3);
    assert.equal(latest.pendingRows, 1);

    saved[1].mes = '오래된 질문을 수정함';
    f.write(saved);
    assert.equal(await latestSessionSummary(f.user, f.origin), null);
});

test('cancellation after visible dialogue keeps the chat and suppresses the late tail', async t => {
    const f = fixture(t); const gate = deferred();
    await acceptJob(f.user, { id: 'cancel-tail', origin: f.origin }, async ({ update }) => {
        update({ dialogueOutput: output, event: 'dialogueComplete' });
        await gate.promise;
        return { sessionSummary: { status: 'complete', summary } };
    });
    await waitFor(f.user, 'cancel-tail', job => job.dialogueReady === true);
    const cancelled = await cancelJob(f.user, 'cancel-tail');
    assert.equal(cancelled.status, 'completed');
    assert.deepEqual(cancelled.sessionSummary, { status: 'cancelled' });
    gate.resolve();
    const final = await waitFor(f.user, 'cancel-tail', job => job.sessionSummary?.status === 'cancelled');
    assert.deepEqual(final.sessionSummary, { status: 'cancelled' });
    assert.equal(fs.readFileSync(f.file, 'utf8').includes('보이는 답변'), true);
});

test('provider failure after visible dialogue keeps the chat and marks the summary failed', async t => {
    const f = fixture(t); const gate = deferred();
    await acceptJob(f.user, { id: 'failed-tail', origin: f.origin }, async ({ update }) => {
        update({ dialogueOutput: output, event: 'dialogueComplete' });
        await gate.promise;
        throw new Error('summary provider failed');
    });
    await waitFor(f.user, 'failed-tail', job => job.dialogueReady === true);
    gate.resolve();
    const final = await waitFor(f.user, 'failed-tail', job => job.status === 'completed');
    assert.equal(final.status, 'completed');
    assert.equal(final.sessionSummary.status, 'failed');
    assert.match(final.sessionSummary.error, /summary provider failed/);
    assert.equal(fs.readFileSync(f.file, 'utf8').includes('보이는 답변'), true);
});

test('restart recovery marks a pending summary interrupted without treating it as success', async t => {
    const f = fixture(t);
    const directory = path.join(f.user.directories.root, 'generation-jobs');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'restart-summary.json'), JSON.stringify({
        id: 'restart-summary', status: 'running', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
        origin: f.origin, operation: 'append', dialogueReady: true, sessionSummary: { status: 'pending' },
    }));
    const job = await getJob(f.user, 'restart-summary');
    assert.equal(job.status, 'interrupted');
    assert.deepEqual(job.sessionSummary, { status: 'interrupted' });
    assert.notEqual(job.sessionSummary.status, 'complete');
});

test('simultaneous append jobs never let the later job claim the earlier job coverage', async t => {
    const f = fixture(t); const a = deferred(); const b = deferred(); const start = deferred();
    const run = (mes, gate) => async ({ update }) => {
        await start.promise;
        update({ dialogueOutput: { message: { mes, is_user: false }, result: { text: mes } }, event: 'dialogueComplete' });
        await gate.promise;
        return { sessionSummary: { status: 'complete', summary: { ...summary, scene: mes } } };
    };
    await acceptJob(f.user, { id: 'job-a', origin: f.origin }, run('A 답변', a));
    await acceptJob(f.user, { id: 'job-b', origin: f.origin }, run('B 답변', b));
    start.resolve();
    a.resolve();
    await waitFor(f.user, 'job-a', job => job.status === 'completed');
    b.resolve();
    const [jobA, jobB] = await Promise.all([
        waitFor(f.user, 'job-a', job => job.status === 'completed'),
        waitFor(f.user, 'job-b', job => job.status === 'completed'),
    ]);
    assert.equal(jobB.summaryCoverageValid, false);
    assert.equal(jobB.sessionSummary.usable, false);
    const rows = fs.readFileSync(f.file, 'utf8').split('\n').map(JSON.parse);
    assert.deepEqual(rows.slice(-2).map(row => row.mes), ['A 답변', 'B 답변']);
    const latest = await latestSessionSummary(f.user, f.origin);
    assert.equal(latest.coveredRows, 3);
    assert.equal(latest.pendingRows, 1);
    assert.equal(latest.summary.scene, 'A 답변');
});

test('simultaneous normal completions preserve only the first snapshot summary', async t => {
    const f = fixture(t); const gateA = deferred(); const gateB = deferred(); const start = deferred();
    const run = (mes, gate) => async () => {
        await start.promise;
        await gate.promise;
        return { message: { mes, is_user: false }, result: { text: mes }, sessionSummary: { status: 'complete', summary: { ...summary, scene: mes } } };
    };
    await acceptJob(f.user, { id: 'normal-a', origin: f.origin }, run('정상 A', gateA));
    await acceptJob(f.user, { id: 'normal-b', origin: f.origin }, run('정상 B', gateB));
    start.resolve();
    gateA.resolve();
    const first = await waitFor(f.user, 'normal-a', job => job.status === 'completed');
    gateB.resolve();
    const second = await waitFor(f.user, 'normal-b', job => job.status === 'completed');
    assert.equal(first.summaryCoverageValid, true);
    assert.equal(second.summaryCoverageValid, false);
    assert.equal(second.sessionSummary.usable, false);
    const rows = fs.readFileSync(f.file, 'utf8').split('\n').map(JSON.parse);
    assert.deepEqual(rows.slice(-2).map(row => row.mes), ['정상 A', '정상 B']);
    const latest = await latestSessionSummary(f.user, f.origin);
    assert.equal(latest.summary.scene, '정상 A');
    assert.equal(latest.coveredRows, 3);
    assert.equal(latest.pendingRows, 1);
});

test('session summary source coverage requires an exact text-only suffix', async t => {
    const f = fixture(t);
    const leadingSystem = [{ role: 'system', content: '고정 규칙' }, { role: 'user', content: ' 질문 ' }];
    assert.deepEqual(sessionSummarySourceCoverage(f.user, f.origin, leadingSystem), { firstRow: 1, rows: 2 });
    assert.deepEqual(sessionSummarySourceCoverage(f.user, f.origin, [...leadingSystem, { role: 'system', content: '주인공 역할 지침' }]), { firstRow: 1, rows: 2 });
    assert.equal(sessionSummarySourceCoverage(f.user, f.origin, [...leadingSystem, { role: 'assistant', content: '', tool_calls: [] }]), null);

    const withAnswer = [{ chat_metadata: { integrity: 'identity' } }, { mes: '질문', is_user: true }, { mes: '답변', is_user: false }];
    f.write(withAnswer);
    assert.deepEqual(sessionSummarySourceCoverage(f.user, f.origin, [{ role: 'assistant', content: '답변' }]), { firstRow: 2, rows: 3 });
    assert.equal(sessionSummarySourceCoverage(f.user, f.origin, [{ role: 'user', content: '질문' }, { role: 'system', content: '중간 시스템' }]), null);
    assert.equal(sessionSummarySourceCoverage(f.user, f.origin, [{ role: 'user', content: '질문\n답변' }]), null);
    assert.equal(sessionSummarySourceCoverage(f.user, f.origin, [{ role: 'user', content: '질문' }, { role: 'assistant', content: '예시 답변' }]), null);
    assert.equal(sessionSummarySourceCoverage(f.user, f.origin, [{ role: 'user', content: [{ type: 'text', text: '질문' }] }]), null);
    assert.deepEqual(sessionSummarySourceCoverage(f.user, f.origin, [{ role: 'user', content: ' 질문 ' }, { role: 'assistant', content: '답변' }]), { firstRow: 1, rows: 3 });

    f.write([{ chat_metadata: { integrity: 'identity' } }, { mes: '질문', is_user: true, extra: { media: ['image.png'] } }]);
    assert.equal(sessionSummarySourceCoverage(f.user, f.origin, [{ role: 'user', content: '질문' }]), null);
});

test('compaction retains fresh system instructions and dialogue in relative order', () => {
    const rows = [
        { role: 'system', content: 'world' }, { role: 'system', content: 'character' },
        { role: 'user', content: 'old' }, { role: 'system', content: 'interleaved' },
        { role: 'assistant', content: 'recent' }, { role: 'user', content: 'new' },
        { role: 'system', content: 'role instructions' },
    ];
    assert.deepEqual(compactSessionMessages(rows, 'summary', 1), [rows[0], rows[1],
        rows[3], rows[6], { role: 'system', content: 'summary' }, rows[5]]);
    assert.throws(()=>compactSessionMessages(rows,'summary',2),/splits/);
    assert.equal(rows.length, 7);
});

test('compaction drops processed rows but preserves every unprocessed row and the latest query once',()=>{
 const rows=[{role:'system',content:'world'},...Array.from({length:21},(_,i)=>({role:i%2?'assistant':'user',content:'row'+i})),{role:'system',content:'fresh instructions'}];
 const n=compactSessionMessages(rows,'checkpoint',7);assert.equal(n.at(-1).content,'row20');assert.equal(n.filter(x=>x.content==='row20').length,1);assert.equal(n.filter(x=>x.role!=='system')[0].role,'user');assert.ok(!n.some(x=>x.content==='row0'));assert.ok(n.slice(0,3).every(x=>x.role==='system'));
 const pending=compactSessionMessages(rows,'checkpoint',13);for(let i=8;i<=20;i++)assert.ok(pending.some(x=>x.content==='row'+i));
 const initial=compactSessionMessages(rows,'checkpoint',21);assert.equal(initial.filter(x=>x.role!=='system').length,21);
});

test('checkpointed turn raw is entirely absent and a failed summary retains its pending turn',()=>{
 const rows=[{role:'system',content:'world'},{role:'user',content:'B owned it'},{role:'assistant',content:'now A owns it'},{role:'user',content:'who owns it?'}];
 const done=compactSessionMessages(rows,'summary A',1);assert.deepEqual(done.filter(x=>x.role!=='system'),[rows[3]]);assert.ok(!JSON.stringify(done).includes('B owned it'));assert.ok(!JSON.stringify(done).includes('now A owns it'));
 const failed=compactSessionMessages(rows,'previous summary',3);assert.deepEqual(failed.filter(x=>x.role!=='system'),rows.slice(1));
 assert.throws(()=>compactSessionMessages(rows,'summary',4),/Invalid/);
});

test('context prefix checkpoint excludes protected tail, accepts append and invalidates prefix edits', async t => {
    const { nativeSession, sourcesFor, revision } = await import('../src/endpoints/backends/context-memory.js');
    const { emptyCategorizedMemory } = await import('../src/endpoints/backends/categorized-session-memory.js');
    const f = fixture(t), gate = deferred();
    const before = [{ chat_metadata: { integrity: 'identity' } }, { mes: '첫 질문', is_user: true }, { mes: '첫 답', is_user: false }, { mes: '둘째 질문', is_user: true }];
    f.write(before);
    const scope = { world: 'w', story: 's', branch: 'b' };
    const memory = { ...emptyCategorizedMemory(scope), through_turn: 1 };
    const sourceRevision = revision(sourcesFor(nativeSession(before).messages, 1));
    await acceptJob(f.user, { id: 'prefix', origin: f.origin }, async ({ update }) => {
        update({ dialogueOutput: output, event: 'dialogueComplete' });
        await gate.promise;
        return { sessionSummary: { mode: 'context-v1', status: 'complete', summary: memory, sourceRevision, previousThrough: 0, contextKey: 'context', targetAnchor: nativeSession(before).anchors.slice(0, 3) } };
    });
    await waitFor(f.user, 'prefix', job => job.dialogueReady);
    const current = fs.readFileSync(f.file, 'utf8').split('\n').map(JSON.parse);
    current.push({ mes: '셋째 질문', is_user: true }); f.write(current);
    gate.resolve();
    const done = await waitFor(f.user, 'prefix', job => job.status === 'completed');
    assert.equal(done.sessionSummary.status, 'complete'); assert.equal(done.prefixAnchor.length, 3);
    const checkpoint = await latestSessionSummary(f.user, f.origin, 'context');
    assert.equal(checkpoint.coveredRows, 3); assert.equal(checkpoint.pendingRows, 3); assert.equal(checkpoint.coveredTurns, 1);
    current[1].mes = '첫 질문 변경'; f.write(current);
    assert.equal(await latestSessionSummary(f.user, f.origin, 'context'), null);
});

test('context coverage recognizes exact ST start/greeting and prefill without accepting unknown synthetic input', t => {
    const f = fixture(t);
    f.write([{ chat_metadata: { integrity: 'identity' } }, { mes: '처음 장면', is_user: false }, { mes: '새 질문', is_user: true }]);
    const messages = [{ role: 'system', content: 'core' }, { role: 'user', content: '[Start a new chat]' }, { role: 'assistant', content: '처음 장면' }, { role: 'user', content: '새 질문' }, { role: 'assistant', content: '</think>\n\n' }];
    assert.equal(sessionSummarySourceCoverage(f.user, f.origin, messages), null);
    assert.deepEqual(sessionSummarySourceCoverage(f.user, f.origin, messages, { allowSynthetic: true }), { firstRow: 1, rows: 3 });
    messages[1].content = '다른 예시 입력';
    assert.equal(sessionSummarySourceCoverage(f.user, f.origin, messages, { allowSynthetic: true }), null);
});

test('writer-start semantic anchor rejects role edits even when dialogue text stays unchanged', async t => {
    const { nativeSession, sourcesFor, revision } = await import('../src/endpoints/backends/context-memory.js');
    const { emptyCategorizedMemory } = await import('../src/endpoints/backends/categorized-session-memory.js');
    const f = fixture(t), gate = deferred();
    const before = [{ chat_metadata: { integrity: 'identity' } }, { mes: '첫 질문', is_user: true, extra: { rp_memory: { role: 'director' } } }, { mes: '첫 답', is_user: false }, { mes: '둘째 질문', is_user: true }];
    f.write(before);
    const session = nativeSession(before), memory = { ...emptyCategorizedMemory({ world:'w',story:'s',branch:'b' }), through_turn:1 };
    await acceptJob(f.user, { id:'metadata-edit',origin:f.origin }, async ({update}) => {
        update({dialogueOutput:output,event:'dialogueComplete'}); await gate.promise;
        return {sessionSummary:{mode:'context-v1',status:'complete',summary:memory,sourceRevision:revision(sourcesFor(session.messages,1)),previousThrough:0,contextKey:'semantic',targetAnchor:session.anchors.slice(0,3)}};
    });
    await waitFor(f.user,'metadata-edit',j=>j.dialogueReady);
    const current=fs.readFileSync(f.file,'utf8').split('\n').map(JSON.parse);
    current[1].extra.rp_memory.role='protagonist';f.write(current);gate.resolve();
    const done=await waitFor(f.user,'metadata-edit',j=>j.status==='completed');
    assert.equal(done.sessionSummary.status,'failed');assert.equal(done.sessionSummary.usable,false);
    assert.equal(await latestSessionSummary(f.user,f.origin,'semantic'),null);
});

test('an edited obsolete checkpoint cannot permanently block a new valid prefix', async t => {
    const { nativeSession, sourcesFor, revision } = await import('../src/endpoints/backends/context-memory.js');
    const { emptyCategorizedMemory } = await import('../src/endpoints/backends/categorized-session-memory.js');
    const f=fixture(t), core=emptyCategorizedMemory({world:'w',story:'s',branch:'b'});
    f.write([{chat_metadata:{integrity:'identity'}},{mes:'최초 질문',is_user:true},{mes:'첫 답',is_user:false},{mes:'둘째 질문',is_user:true}]);
    const run = id => acceptJob(f.user,{id,origin:f.origin},async({update})=>{
        const session=nativeSession(fs.readFileSync(f.file,'utf8').split('\n').map(JSON.parse));
        update({dialogueOutput:output,event:'dialogueComplete'});
        return {sessionSummary:{mode:'context-v1',status:'complete',summary:{...core,through_turn:1},sourceRevision:revision(sourcesFor(session.messages,1)),previousThrough:0,contextKey:'rebuild',targetAnchor:session.anchors.slice(0,3)}};
    });
    await run('old-prefix');await waitFor(f.user,'old-prefix',j=>j.status==='completed');
    const current=fs.readFileSync(f.file,'utf8').split('\n').map(JSON.parse);current[1].mes='편집된 최초 질문';current.push({mes:'셋째 질문',is_user:true});f.write(current);
    assert.equal(await latestSessionSummary(f.user,f.origin,'rebuild'),null);
    await run('new-prefix');const done=await waitFor(f.user,'new-prefix',j=>j.status==='completed');
    assert.equal(done.sessionSummary.status,'complete');assert.equal(done.sessionSummary.usable,true);
    assert.equal((await latestSessionSummary(f.user,f.origin,'rebuild')).coveredTurns,1);
});
