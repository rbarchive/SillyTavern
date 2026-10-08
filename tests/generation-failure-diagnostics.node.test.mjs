import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { persistFailureDiagnostic, failureDiagnosticDirectory, listFailureDiagnostics } from '../src/generation-failure-diagnostics.js';
import { acceptJob, getJob } from '../src/generation-jobs.js';
import { setConfigFilePath } from '../src/util.js';
setConfigFilePath(path.resolve('default/config.yaml'));
const { router } = await import('../src/endpoints/generation-jobs.js');
const secret = 'PRIVATE_CHAT_WORLD_MEMORY';
const failed = { id: secret, status: 'completed', createdAt: '2026-10-08T00:00:00.000Z', updatedAt: '2026-10-08T00:01:00.000Z', dialogueReady: true,
    message: { mes: secret }, result: { text: secret }, origin: { file: secret },
    sessionSummary: { status: 'failed', errorCode: 'COMPACT_TURN_MISMATCH', error: secret, keepRaw: true, memoryOutcome: { latestStateStatus: 'complete', episodicStatus: 'failed', keepRaw: true } },
    memoryMetrics: { latestStateMs: 20, episodicMs: 30, status: 'failed', errorCode: 'COMPACT_TURN_MISMATCH' } };

test('terminal memory failure writes one private content-free file, success and cancellation do not', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-failure-store-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    assert.deepEqual(await listFailureDiagnostics(root), { failures: [], unreadableRecords: 0 }); assert.equal(fs.existsSync(failureDiagnosticDirectory(root)), false);
    for (const status of ['running', 'cancelled']) assert.equal(persistFailureDiagnostic(root, { ...failed, status }), false);
    assert.equal(persistFailureDiagnostic(root, { id: 'success', status: 'completed' }), false);
    assert.equal(persistFailureDiagnostic(root, failed), true); assert.equal(persistFailureDiagnostic(root, failed), true);
    const dir = failureDiagnosticDirectory(root), files = fs.readdirSync(dir); assert.equal(files.length, 1);
    assert.match(files[0], /^[a-f0-9]{24}\.json$/); const file = path.join(dir, files[0]); assert.ok(!fs.readFileSync(file, 'utf8').includes(secret));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const rows = await listFailureDiagnostics(root); assert.equal(rows.failures.length, 1); assert.deepEqual(rows.failures[0].failureKinds, ['episodic']);
    assert.equal(rows.failures[0].diagnostic.summary.errorCode, 'COMPACT_TURN_MISMATCH'); assert.equal(rows.failures[0].diagnostic.memory.episodicMs, 30);
    const stored = JSON.parse(fs.readFileSync(file)); stored.diagnostic.origin = { file: secret }; stored.diagnostic.errorCode = secret; stored.diagnostic.phaseStats = { episodic: { content: secret, durationMs: 10 } };
    fs.writeFileSync(file, JSON.stringify(stored)); assert.ok(!JSON.stringify(await listFailureDiagnostics(root)).includes(secret));
    fs.writeFileSync(path.join(dir, 'a'.repeat(24) + '.json'), '{'); assert.equal((await listFailureDiagnostics(root)).unreadableRecords, 1);
});

test('real failed job is exported automatically; analysis HTTP uses only separate files', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-failure-http-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const user = { directories: { root, chats: path.join(root, 'chats'), groupChats: path.join(root, 'groups') } };
    const chat = path.join(root, 'chats', 'card', 'chat.jsonl'); fs.mkdirSync(path.dirname(chat), { recursive: true });
    fs.writeFileSync(chat, [{ chat_metadata: { integrity: 'fixture' } }, { mes: secret, is_user: true }].map(JSON.stringify).join('\n'));
    await acceptJob(user, { id: 'own-failure', origin: { avatar: 'card.png', file: 'chat', integrity: 'fixture' }, operation: 'append', message: { mes: '', is_user: false } }, async () => { throw new Error(secret); });
    let job; for (let i = 0; i < 100; i++) { job = await getJob(user, 'own-failure'); if (job.status === 'failed') break; await new Promise(resolve => setTimeout(resolve, 5)); }
    assert.equal(job.status, 'failed'); assert.equal((await listFailureDiagnostics(root)).failures.length, 1);
    fs.rmSync(path.join(root, 'generation-jobs'), { recursive: true }); fs.rmSync(path.join(root, 'chats'), { recursive: true });
    const app = express(); app.use(express.json()); app.use((req, res, next) => { req.user = user; next(); }); app.use('/jobs', router);
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    try {
        fs.mkdirSync(path.join(root, 'generation-jobs'));
        const originalFile = path.join(root, 'generation-jobs', 'own-failure.json'); fs.writeFileSync(originalFile, JSON.stringify(job));
        const originalBytes = fs.readFileSync(originalFile); fs.rmSync(failureDiagnosticDirectory(root), { recursive: true });
        for (let n = 0; n < 2; n++) {
            const exported = await fetch(`http://127.0.0.1:${server.address().port}/jobs/diagnostics/failures/export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ limit: 100 }) });
            assert.equal(exported.status, 200); assert.deepEqual(await exported.json(), { schemaVersion: 1, written: 1, skipped: 0, writeFailures: 0 });
        }
        assert.deepEqual(fs.readFileSync(originalFile), originalBytes); assert.equal(fs.readdirSync(failureDiagnosticDirectory(root)).length, 1);
        fs.rmSync(path.join(root, 'generation-jobs'), { recursive: true });
        const response = await fetch(`http://127.0.0.1:${server.address().port}/jobs/diagnostics/failures`); assert.equal(response.status, 200);
        const body = await response.text(); assert.ok(!body.includes(secret)); assert.equal(JSON.parse(body).failures[0].diagnostic.errorCode, 'ERROR_UNCLASSIFIED');
        assert.equal(fs.existsSync(path.join(root, 'generation-jobs')), false, 'analysis does not access original job store');
        assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/jobs/diagnostics/failures?limit=0`)).status, 400);
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('state-only failure is retained, diagnostic write failure cannot change job outcome', async t => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'st-failure-isolation-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 assert.equal(persistFailureDiagnostic(root,{id:'state-only',status:'completed',sessionSummary:{status:'skipped',memoryOutcome:{latestStateStatus:'failed',episodicStatus:'skipped',keepRaw:true}}}),true);
 assert.deepEqual((await listFailureDiagnostics(root)).failures[0].failureKinds,['latest-state']);
 const other=path.join(root,'blocked');fs.mkdirSync(other);fs.writeFileSync(path.join(other,'diagnostics'),'not-directory');
 const user={directories:{root:other,chats:path.join(other,'chats')}};
 fs.mkdirSync(path.join(other,'chats','card'),{recursive:true});fs.writeFileSync(path.join(other,'chats','card','chat.jsonl'),JSON.stringify({chat_metadata:{integrity:'fixture'}})+'\n'+JSON.stringify({is_user:true,mes:'fixture'}));
 const errors=[];const original=console.error;console.error=(...args)=>errors.push(args);
 try {
  await acceptJob(user,{id:'write-failed',origin:{avatar:'card.png',file:'chat',integrity:'fixture'},operation:'append',message:{mes:'',is_user:false}},async()=>{throw new Error(secret);});
  let job;for(let i=0;i<100;i++){job=await getJob(user,'write-failed');if(job.status==='failed')break;await new Promise(resolve=>setTimeout(resolve,5));}
  assert.equal(job.status,'failed');assert.ok(errors.some(args=>args[0]==='FAILURE_DIAGNOSTIC_WRITE_FAILED'));assert.ok(!JSON.stringify(errors).includes(secret));
 }finally{console.error=original;}
});
