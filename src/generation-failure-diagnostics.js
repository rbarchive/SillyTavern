import fs from 'node:fs';
import path from 'node:path';
import { sync as writeAtomic } from 'write-file-atomic';
import { diagnosticJob, diagnosticCodes } from './generation-job-diagnostics.js';

const terminal = ['completed', 'failed', 'conflict', 'interrupted'];
const failures = ['failed', 'conflict', 'interrupted'];
const reference = /^[a-f0-9]{24}$/u;
export const failureDiagnosticDirectory = root => path.join(root, 'diagnostics', 'generation-failures');
function kinds(snapshot) {
    const result = [];
    if (failures.includes(snapshot.status)) result.push('generation');
    if (failures.includes(snapshot.outcome?.latestStateStatus) || failures.includes(snapshot.memory?.latestState?.status)) result.push('latest-state');
    if (failures.includes(snapshot.outcome?.episodicStatus)) result.push('episodic');
    if (failures.includes(snapshot.summary?.status) && !result.includes('episodic') && !result.includes('latest-state')) result.push('memory');
    return result;
}
/** Terminal failures only; one atomic content-free snapshot per job. */
export function persistFailureDiagnostic(root, job) {
    if (!terminal.includes(job.status)) return false;
    return persistFailureSnapshot(root, diagnosticJob(job));
}
/** Explicit export of existing safe snapshots; never move original jobs. */
export function persistFailureSnapshot(root, diagnostic) {
    const record = validateSnapshot({ schemaVersion: 1, diagnostic });
    if (!record) return false;
    const directory = failureDiagnosticDirectory(root);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeAtomic(path.join(directory, `${record.diagnostic.jobRef}.json`), JSON.stringify(record), { mode: 0o600 });
    return true;
}

// Revalidate stored snapshots too: manual edits or unknown future fields must
// never turn this endpoint into a route for exporting content.
function validateSnapshot(value) {
    const row = value?.diagnostic;
    if (value?.schemaVersion !== 1 || !row || !reference.test(row.jobRef ?? '')) return null;
    const diagnostic = diagnosticJob({ status: row.status, createdAt: row.createdAt, updatedAt: row.updatedAt, dialogueReady: row.dialogueReady,
        progress: { workPhase: row.workPhase, inputProgress: row.inputProgress }, timings: row.timingsMs,
        phaseDiagnostics: row.phaseStats, modelStats: row.modelStats, memoryMetrics: row.memoryMetricsAvailable === true ? row.memory : undefined,
        sessionSummary: row.summary, memoryOutcome: row.outcome });
    diagnostic.jobRef = row.jobRef;
    // diagnosticJob's raw-error fallback must not interpret stored strings.
    // Only fixed codes from the current contract survive.
    diagnostic.errorCode = diagnosticCodes.includes(row.errorCode) ? row.errorCode : undefined;
    const failureKinds = kinds(diagnostic);
    return terminal.includes(diagnostic.status) && failureKinds.length ? { schemaVersion: 1, failureKinds, diagnostic } : null;
}
/** Reads only the separate diagnostic store, never original jobs or chats. */
export async function listFailureDiagnostics(root, limit = 20) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid diagnostics limit');
    const directory = failureDiagnosticDirectory(root);
    let names;
    try { names = await fs.promises.readdir(directory); } catch (error) { if (error.code === 'ENOENT') return { failures: [], unreadableRecords: 0 }; throw error; }
    const records = []; let unreadableRecords = 0;
    for (const name of names.filter(name => /^[a-f0-9]{24}\.json$/u.test(name))) {
        try {
            const file = path.join(directory, name);
            const stat = await fs.promises.lstat(file);
            if (!stat.isFile() || stat.isSymbolicLink()) { unreadableRecords++; continue; }
            const record = validateSnapshot(JSON.parse(await fs.promises.readFile(file, 'utf8')));
            if (record) records.push(record); else unreadableRecords++;
        } catch (error) { if (error.code !== 'ENOENT') unreadableRecords++; }
    }
    records.sort((a, b) => (b.diagnostic.updatedAt ?? '').localeCompare(a.diagnostic.updatedAt ?? ''));
    return { failures: records.slice(0, limit), unreadableRecords };
}
