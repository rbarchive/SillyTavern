import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { diagnosticJob, diagnosticErrorCode, recordPhaseDiagnostics, finishPhaseDiagnostics } from '../src/generation-job-diagnostics.js';
import { decodeCompactDelta } from '../src/endpoints/backends/compact-memory-delta.js';
import { setConfigFilePath } from '../src/util.js';
setConfigFilePath(path.resolve('default/config.yaml'));
const { router } = await import('../src/endpoints/generation-jobs.js');
const secret = 'PRIVATE_DIALOGUE_WORLD_MEMORY';
test('strict diagnostic projection excludes hostile nested content and invalid types', () => {
    const job = { id: secret, status: 'completed', createdAt: '2026-10-08T00:00:00.000Z', updatedAt: secret, dialogueReady: true,
        origin: { file: secret }, result: { text: secret }, preview: secret, error: secret,
        modelStats: { inputTokens: 42, outputTokens: '12', reasoningTokens: -1, cachedTokens: NaN, finishReason: secret },
        progress: { workPhase: 'episodic', inputProgress: { totalTokens: 12, private: secret } },
        memoryMetrics: { totalMs: 100, status: 'failed', error: secret, latestState: { status: 'complete', card: secret }, modelStats: { inputTokens: 99, text: secret }, provider: { content: secret } },
        sessionSummary: { status: 'failed', error: secret, summary: secret, keepRaw: true },
        phaseDiagnostics: { episodic: { durationMs: 100, text: secret, modelStats: { outputTokens: 20, content: secret } } } };
    const result = diagnosticJob(job);
    assert.ok(!JSON.stringify(result).includes(secret)); assert.equal(result.memory.totalMs, 100);
    assert.equal(result.memory.latestState.status, 'complete'); assert.equal(result.modelStats.inputTokens, 42);
    assert.equal(result.modelStats.outputTokens, undefined); assert.equal(result.summary.errorCode, 'ERROR_UNCLASSIFIED');
    assert.equal(result.phaseStats.episodic.durationMs, 100); assert.ok(!Object.hasOwn(result, 'origin'));
    assert.equal(diagnosticErrorCode(new SyntaxError(secret)), 'MEMORY_JSON_INVALID');
});
test('phase timing separates actor and background without payload capture', () => {
    const job = { createdAt: new Date(1000).toISOString(), progress: {} };
    recordPhaseDiagnostics(job, { workPhase: 'dialogue', inputProgress: { totalTokens: 100, cachedTokens: 80 } }, 1100);
    job.progress.workPhase = 'dialogue'; recordPhaseDiagnostics(job, { modelStats: { outputTokens: 5 }, event: 'firstContent', preview: secret }, 1200);
    recordPhaseDiagnostics(job, { workPhase: 'latest-state' }, 1400); job.progress.workPhase = 'latest-state';
    recordPhaseDiagnostics(job, { workPhase: 'episodic' }, 1500); finishPhaseDiagnostics(job, 1800);
    assert.equal(job.phaseDiagnostics.dialogue.durationMs, 300); assert.equal(job.phaseDiagnostics.dialogue.firstContentMs, 100);
    assert.equal(job.phaseDiagnostics['latest-state'].durationMs, 100); assert.equal(job.phaseDiagnostics.episodic.durationMs, 300);
    assert.ok(!JSON.stringify(job.phaseDiagnostics).includes(secret));
});
test('compact top-level failure codes distinguish causes without output content', () => {
    const prepared = { throughTurn: 5, sourceTable: ['m1'] }, memory = { overview: '' };
    for (const [value, code] of [[null, 'COMPACT_NOT_OBJECT'], [[], 'COMPACT_NOT_OBJECT'], [{ t: 5 }, 'COMPACT_VERSION_MISSING'], [{ v: 1, t: 5 }, 'COMPACT_VERSION_MISMATCH'], [{ v: 2 }, 'COMPACT_TURN_MISSING'], [{ v: 2, t: 4 }, 'COMPACT_TURN_MISMATCH'], [{ v: 2, t: 5, [secret]: true }, 'COMPACT_UNKNOWN_FIELDS']]) {
        assert.throws(() => decodeCompactDelta(value, prepared, memory), error => { assert.equal(error.code, code); assert.equal(error.message, 'Invalid compact delta'); assert.ok(!JSON.stringify(error).includes(secret)); return true; });
    }
    assert.throws(() => decodeCompactDelta({ v: 2, t: 5 }, { ...prepared, sourceTable: ['m1', 'm1'] }, memory), error => error.code === 'COMPACT_SOURCE_TABLE_INVALID');
    assert.equal(decodeCompactDelta({ v: 2, t: 5 }, prepared, memory).through_turn, 5);
});
test('HTTP diagnostics are scoped, read-only, content-free and route correctly', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-safe-diagnostics-'));
    const own = path.join(root, 'own'), other = path.join(root, 'other');
    function make(dir, id) { fs.mkdirSync(path.join(dir, 'generation-jobs'), { recursive: true }); const file = path.join(dir, 'generation-jobs', id + '.json'); fs.writeFileSync(file, JSON.stringify({ id, status: 'running', createdAt: '2026-10-08T00:00:00.000Z', origin: { file: secret }, message: { mes: secret }, sessionSummary: { status: 'failed', error: 'Invalid compact delta', summary: secret, keepRaw: true }, memoryMetrics: { latestStateMs: 12, episodicMs: 20, errorCode: 'COMPACT_TURN_MISMATCH' } })); return file; }
    const file = make(own, 'own-job'); make(other, 'other-job'); const before = fs.readFileSync(file);
    const broken = path.join(root, 'broken'); fs.mkdirSync(broken); fs.writeFileSync(path.join(broken, 'generation-jobs'), secret);
    const app = express(); app.use((req, res, next) => { const user = req.headers['x-test-user']; if (user !== 'none') req.user = { directories: { root: user === 'other' ? other : user === 'broken' ? broken : own } }; next(); }); app.use('/jobs', router);
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/jobs/diagnostics`;
    try {
        const response = await fetch(base); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
        const body = await response.text(); for (const forbidden of [secret, 'own-job', 'other-job']) assert.ok(!body.includes(forbidden));
        const parsed = JSON.parse(body); assert.equal(parsed.jobs.length, 1); assert.equal(parsed.jobs[0].status, 'running');
        assert.equal(parsed.jobs[0].memory.episodicMs, 20); assert.equal(parsed.jobs[0].memory.errorCode, 'COMPACT_TURN_MISMATCH');
        assert.deepEqual(fs.readFileSync(file), before);
        const { listJobSummaries } = await import('../src/generation-jobs.js');
        assert.equal((await listJobSummaries({ directories: { root: own } }))[0].status, 'interrupted', 'diagnostics must not suppress normal crash recovery');
        const scoped = await (await fetch(base, { headers: { 'x-test-user': 'other' } })).json(); assert.notEqual(scoped.jobs[0].jobRef, parsed.jobs[0].jobRef);
        assert.equal((await fetch(base + '?limit=101')).status, 400); assert.equal((await fetch(base, { headers: { 'x-test-user': 'none' } })).status, 401);
        const failed = await fetch(base, { headers: { 'x-test-user': 'broken' } }); assert.equal(failed.status, 500); assert.deepEqual(await failed.json(), { errorCode: 'DIAGNOSTICS_UNAVAILABLE' });
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); }
});

test('missing diagnostics storage is not created by read-only listing', async () => {
    const { listJobSummaries } = await import('../src/generation-jobs.js');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-empty-diagnostics-'));
    try { assert.deepEqual(await listJobSummaries({ directories: { root } }, { recover: false }), []); assert.equal(fs.existsSync(path.join(root, 'generation-jobs')), false); }
    finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('turn failure records numeric boundary and type without raw content or validation repair', () => {
    const prepared = { throughTurn: 13, sourceTable: ['m1'] }, memory = { overview: '' };
    for (const [returned, expected] of [[2, { expectedTurn: 13, returnedType: 'number', returnedTurn: 2 }], ['13', { expectedTurn: 13, returnedType: 'string', numericStringTurn: 13 }], [secret, { expectedTurn: 13, returnedType: 'string' }], [{ text: secret }, { expectedTurn: 13, returnedType: 'object' }], [null, { expectedTurn: 13, returnedType: 'null' }], [13.5, { expectedTurn: 13, returnedType: 'number', returnedTurn: 13.5 }]]) {
        assert.throws(() => decodeCompactDelta({ v: 2, t: returned }, prepared, memory), error => {
            assert.equal(error.code, 'COMPACT_TURN_MISMATCH'); assert.deepEqual(error.turnDiagnostic, expected);
            const diagnostic = diagnosticJob({ sessionSummary: { status: 'failed', turnDiagnostic: { ...error.turnDiagnostic, raw: secret } }, memoryMetrics: { turnDiagnostic: error.turnDiagnostic } });
            assert.deepEqual(diagnostic.summary.turnDiagnostic, expected); assert.deepEqual(diagnostic.memory.turnDiagnostic, expected);
            assert.ok(!JSON.stringify(diagnostic).includes(secret)); assert.ok(!JSON.stringify(error).includes(secret)); return true;
        });
    }
    assert.throws(() => decodeCompactDelta({ v: 2 }, prepared, memory), error => { assert.deepEqual(error.turnDiagnostic, { expectedTurn: 13, returnedType: 'missing' }); return true; });
    assert.equal(decodeCompactDelta({ v: 2, t: 13 }, prepared, memory).through_turn, 13);
});
