import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acceptJob, getJob, cancelJob, protectJobResults } from '../src/generation-jobs.js';

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'generation-job-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const user = { directories: { root, chats: path.join(root, 'chats'), groupChats: path.join(root, 'group chats') } };
    const file = path.join(root, 'chats', 'card', 'chat.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const rows = [{ chat_metadata: { integrity: 'identity' } }, { mes: 'question', is_user: true }];
    const write = value => fs.writeFileSync(file, value.map(row => JSON.stringify(row)).join('\n'));
    write(rows);
    return { user, file, rows, write, origin: { avatar: 'card.png', file: 'chat', integrity: 'identity' } };
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function finished(user, id) {
    for (let n = 0; n < 100; n++) {
        const job = await getJob(user, id);
        if (['completed', 'conflict', 'cancelled', 'failed'].includes(job.status)) return job;
        await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('job did not finish');
}
const output = { message: { mes: 'answer', is_user: false }, result: { text: 'answer' } };

test('accepted work survives requester departure, deduplicates and protects stale saves', async t => {
    const f = fixture(t); const gate = deferred(); let calls = 0;
    const request = { id: 'once', origin: f.origin };
    const runner = async () => { calls++; await gate.promise; return output; };
    await Promise.all([acceptJob(f.user, request, runner), acceptJob(f.user, request, runner)]);
    assert.equal(calls, 1);
    gate.resolve();
    assert.equal((await finished(f.user, 'once')).status, 'completed');
    const merged = protectJobResults(f.file, f.rows);
    assert.equal(merged.length, 3);
    assert.equal(merged[2].extra.generation_job, 'once');
    assert.equal(protectJobResults(f.file, merged).length, 3);
    assert.equal(protectJobResults(f.file, f.rows, true).length, 2);
    const other = fixture(t);
    assert.equal(await getJob(other.user, 'once'), null);
    await assert.rejects(acceptJob(f.user, { ...request, origin: { ...f.origin, file: 'else' } }, runner), { code: 'idempotency_conflict' });
});

test('changed original retains generated result without writing another chat', async t => {
    const f = fixture(t); const gate = deferred();
    await acceptJob(f.user, { id: 'conflict', origin: f.origin }, async () => { await gate.promise; return output; });
    f.write([{ chat_metadata: { integrity: 'replacement' } }, { mes: 'different' }]);
    gate.resolve();
    const job = await finished(f.user, 'conflict');
    assert.equal(job.status, 'conflict');
    assert.equal(job.result.text, 'answer');
    assert.equal(fs.readFileSync(f.file, 'utf8').includes('answer'), false);
});

test('explicit cancellation suppresses late provider result', async t => {
    const f = fixture(t); const gate = deferred(); let signal;
    await acceptJob(f.user, { id: 'cancel', origin: f.origin }, async args => { signal = args.signal; await gate.promise; return output; });
    assert.equal((await cancelJob(f.user, 'cancel')).status, 'cancelled');
    assert.equal(signal.aborted, true);
    gate.resolve(); await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal((await getJob(f.user, 'cancel')).status, 'cancelled');
    assert.equal(fs.readFileSync(f.file, 'utf8').includes('answer'), false);
});

test('swipe result replaces original target and stale edit conflicts', async t => {
    const f = fixture(t); f.rows.push({ mes: 'old', is_user: false }); f.write(f.rows);
    await acceptJob(f.user, { id: 'swipe', origin: f.origin, operation: 'swipe' }, async () => output);
    const job = await finished(f.user, 'swipe');
    assert.equal(job.status, 'completed');
    const merged = protectJobResults(f.file, f.rows);
    assert.deepEqual(merged[2].swipes, ['old', 'answer']);
    const edited = structuredClone(f.rows); edited[2].mes = 'edited';
    assert.throws(() => protectJobResults(f.file, edited), { code: 'conflict' });
});

test('concurrent append jobs preserve each result exactly once', async t => {
    const f = fixture(t); const gate = deferred();
    await acceptJob(f.user, { id: 'first', origin: f.origin }, async () => { await gate.promise; return output; });
    await acceptJob(f.user, { id: 'second', origin: f.origin }, async () => { await gate.promise; return output; });
    gate.resolve();
    assert.equal((await finished(f.user, 'first')).status, 'completed');
    assert.equal((await finished(f.user, 'second')).status, 'completed');
    assert.equal(protectJobResults(f.file, f.rows).length, 4);
});

test('path traversal and missing original identity are rejected', async t => {
    const f = fixture(t);
    await assert.rejects(acceptJob(f.user, { id: 'bad', origin: { ...f.origin, file: '../else' } }, async () => output), { code: 'invalid_request' });
    f.write([{ chat_metadata: {} }]);
    await assert.rejects(acceptJob(f.user, { id: 'legacy', origin: f.origin }, async () => output), { code: 'origin_conflict' });
});

test('server restart marks unfinished durable work interrupted without provider retry', async t => {
    const f = fixture(t);
    fs.mkdirSync(path.join(f.user.directories.root, 'generation-jobs'));
    fs.writeFileSync(path.join(f.user.directories.root, 'generation-jobs', 'restart.json'), JSON.stringify({ id: 'restart', status: 'running', origin: f.origin, operation: 'append' }));
    const job = await getJob(f.user, 'restart');
    assert.equal(job.status, 'interrupted');
    let calls = 0;
    await acceptJob(f.user, { id: 'restart', origin: f.origin }, async () => { calls++; return output; });
    assert.equal(calls, 0);
});

test('group snapshot binds result to original content and file', async t => {
    const f = fixture(t);
    fs.mkdirSync(f.user.directories.groupChats);
    const groupFile = path.join(f.user.directories.groupChats, 'group.jsonl');
    fs.writeFileSync(groupFile, JSON.stringify({ mes: 'group question', is_user: true }));
    await acceptJob(f.user, { id: 'group', origin: { group: true, file: 'group' } }, async () => output);
    assert.equal((await finished(f.user, 'group')).status, 'completed');
    assert.equal(protectJobResults(groupFile, [{ mes: 'group question', is_user: true }]).length, 2);
    assert.equal(fs.readFileSync(f.file, 'utf8').includes('answer'), false);
});

test('observed completion can be edited, deleted and regenerated; stale revision cannot erase it', async t => {
    const f = fixture(t);
    await acceptJob(f.user, { id: 'revision', origin: f.origin }, async () => output);
    await finished(f.user, 'revision');
    const loaded = fs.readFileSync(f.file, 'utf8').split('\n').map(JSON.parse);
    const edited = structuredClone(loaded); edited.at(-1).mes = 'intentional edit';
    assert.equal(protectJobResults(f.file, edited).at(-1).mes, 'intentional edit');
    const deleted = loaded.slice(0, -1);
    assert.equal(protectJobResults(f.file, deleted).length, 2);
    f.write(deleted);
    await acceptJob(f.user, { id: 'replacement', origin: f.origin }, async () => ({ message: { mes: 'replacement', extra: { generation_job_processed: true } }, result: { text: 'replacement' } }));
    await finished(f.user, 'replacement');
    const replaced = fs.readFileSync(f.file, 'utf8').split('\n').map(JSON.parse);
    assert.equal(replaced.length, 3); assert.equal(replaced.at(-1).mes, 'replacement');
    assert.equal(replaced.at(-1).extra.generation_job_processed, undefined);
    assert.equal(protectJobResults(f.file, deleted).at(-1).mes, 'replacement');
});
