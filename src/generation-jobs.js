import { persistFailureDiagnostic } from './generation-failure-diagnostics.js';
import { diagnosticJob, recordPhaseDiagnostics, finishPhaseDiagnostics } from './generation-job-diagnostics.js';
/** Durable, user-scoped generation jobs. Providers are never replayed after restart. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { nativeRowHash, nativeProviderCoverage, nativePrefixBoundary } from './endpoints/backends/native-history.js';
import { nativeSession, sourcesFor, revision } from './endpoints/backends/context-memory.js';

const active = new Map();
const previews = new Map();
const summaryCache = new Map();
const MAX_RUNNING = 4;
const MAX_RECORDS = 200;
const hash = value => {
    // Completion revisions do not change the original chat identity/anchor.
    if (value?.chat_metadata) {
        value = structuredClone(value);
        delete value.chat_metadata.generation_revision;
    }
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
};
const copy = value => structuredClone(value);
const terminal = new Set(['completed', 'conflict', 'cancelled', 'failed', 'interrupted']);
// Ignore UI bookkeeping, but invalidate summaries on meaningful story edits.
const storyHash = nativeRowHash;

function fail(message, code = 'conflict') {
    const error = new Error(message);
    error.code = code;
    throw error;
}
function component(value, label) {
    if (typeof value !== 'string' || !value || value === '.' || value === '..' || /[\\/\x00-\x1f]/u.test(value) || value.length > 240) {
        fail(`Invalid ${label}.`, 'invalid_request');
    }
    return value;
}
function scope(user, { create = true } = {}) {
    if (!user?.directories?.root) fail('Authenticated user directories required.', 'invalid_request');
    const root = path.resolve(user.directories.root);
    const directory = path.join(root, 'generation-jobs');
    if (create) fs.mkdirSync(directory, { recursive: true });
    return { root, directory };
}
function recordPath(user, id) {
    component(id, 'job ID');
    if (!/^[a-zA-Z0-9_-]{1,100}$/u.test(id)) fail('Invalid job ID.', 'invalid_request');
    return path.join(scope(user).directory, `${id}.json`);
}
function atomic(file, value) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
        fs.writeFileSync(temporary, value, { mode: 0o600 });
        fs.renameSync(temporary, file);
    } finally {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
}
function save(file, job) {
    job.updatedAt = new Date().toISOString();
    const persisted = { ...job };
    delete persisted.preview;
    atomic(file, JSON.stringify(persisted));
    summaryCache.delete(file);
    try { persistFailureDiagnostic(path.dirname(path.dirname(file)), job); }
    catch { console.error('FAILURE_DIAGNOSTIC_WRITE_FAILED'); }
}
function readChat(file) {
    return fs.readFileSync(file, 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
}
function chatPath(user, origin) {
    const { root } = scope(user);
    const file = component(origin?.file, 'chat filename').replace(/\.jsonl$/u, '');
    component(file, 'chat filename');
    const base = origin.group ? user.directories.groupChats : user.directories.chats;
    if (!base) fail('Chat directory unavailable.', 'invalid_request');
    const avatar = origin.group ? '' : component(origin.avatar, 'avatar').replace(/\.png$/u, '');
    const resolved = path.resolve(base, avatar, `${file}.jsonl`);
    if (!resolved.startsWith(`${root}${path.sep}`)) fail('Chat must belong to authenticated user.', 'invalid_request');
    const physical = fs.realpathSync(resolved);
    if (!physical.startsWith(`${fs.realpathSync(root)}${path.sep}`)) fail('Chat must belong to authenticated user.', 'invalid_request');
    return resolved;
}
function load(file) {
    if (!fs.existsSync(file)) return null;
    const job = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!terminal.has(job.status) && !active.has(file)) {
        const root = path.dirname(path.dirname(file));
        const target = job.relativeChat ? path.resolve(root, job.relativeChat) : null;
        let persisted;
        if (target?.startsWith(`${root}${path.sep}`) && fs.existsSync(target)) {
            persisted = readChat(target).find(row => row.extra?.generation_job === job.id);
        }
        job.status = persisted ? 'completed' : 'interrupted';
        if (persisted) job.message = persisted;
        else job.error = 'Server restarted before generation finished. Retry with a new job ID.';
        if (job.sessionSummary?.status === 'pending') job.sessionSummary = { status: 'interrupted', ...(job.progress?.workPhase ? { keepRaw: true, memoryOutcome: { ...job.memoryOutcome, episodicStatus: 'interrupted', keepRaw: true } } : {}) };
        save(file, job);
    }
    return previews.has(file) ? { ...job, preview: previews.get(file) } : job;
}

/** Returns a persisted job, or null. Never starts a provider request. */
export async function getJob(user, id) {
    return load(recordPath(user, id));
}
export async function listJobs(user) {
    const { directory } = scope(user);
    return fs.readdirSync(directory).filter(name => /^[a-zA-Z0-9_-]+\.json$/u.test(name))
        .map(name => load(path.join(directory, name))).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Poll lightweight receipts without synchronously rereading every frozen prompt/result. */
export async function listJobSummaries(user, { recover = true } = {}) {
    const { directory } = scope(user, { create: recover });
    let entries;
    try { entries = await fs.promises.readdir(directory); } catch (error) { if (!recover && error.code === 'ENOENT') return []; throw error; }
    const names = entries.filter(name => /^[a-zA-Z0-9_-]+\.json$/u.test(name));
    const summaries = [];
    for (const name of names) {
        const file = path.join(directory, name);
        try {
            const stat = await fs.promises.stat(file);
            const stamp = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
            let receipt = recover ? summaryCache.get(file) : undefined;
            if (!receipt || receipt.stamp !== stamp) {
                let job = JSON.parse(await fs.promises.readFile(file, 'utf8'));
                // Preserve crash recovery; listing never starts a provider request.
                if (recover && !terminal.has(job.status) && !active.has(file)) job = load(file);
                const { id, origin, operation, status, createdAt, updatedAt, progress, timings, modelStats, error, result, dialogueReady, sessionSummary, memoryOutcome, toolPending, toolReceipts } = job;
                receipt = { stamp, summary: { id, origin, operation, status, createdAt, updatedAt, progress, timings, modelStats, error, dialogueReady, toolPending, toolReceipts: toolReceipts?.map(({ id, name, writeApplied, warning }) => ({ id, name, writeApplied, warning })),
                    diagnostics: diagnosticJob(job),
                    memoryOutcome: sessionSummary?.memoryOutcome ?? memoryOutcome,
                    sessionSummary: sessionSummary ? { status: sessionSummary.status, error: sessionSummary.error, keepRaw: sessionSummary.keepRaw } : undefined,
                    result: result?.path ? { path: result.path } : undefined } };
                if (recover && summaryCache.size >= 2000) summaryCache.delete(summaryCache.keys().next().value);
                if (recover) summaryCache.set(file, receipt);
            }
            summaries.push(copy(receipt.summary));
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            if (recover) summaryCache.delete(file); // A concurrent acceptance may prune an old receipt.
        }
    }
    return summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Accept once, persist before launching, and run independently of the HTTP connection.
 * runner({signal, update}) returns {message, result}; update accepts JSON progress.
 * message is the full final chat message. result is provider output for retrieval.
 */
export async function acceptJob(user, { id, origin, operation = 'append', message, imageBoost }, runner) {
    const file = recordPath(user, id);
    const existing = load(file);
    if (existing) {
        if (hash(existing.origin) !== hash(origin) || existing.operation !== operation) fail('Job ID already belongs to a different origin or operation.', 'idempotency_conflict');
        return existing;
    }
    if (typeof runner !== 'function') fail('Generation runner required.', 'invalid_request');
    if (!['append', 'swipe', 'continue', 'regenerate'].includes(operation)) fail('Unsupported generation operation.', 'invalid_request');
    const jobs = await listJobs(user);
    if (jobs.filter(job => !terminal.has(job.status)).length >= MAX_RUNNING) fail('Too many active generation jobs.', 'capacity');
    // Await above can race another accept: check again before the synchronous claim.
    const claimed = load(file);
    if (claimed) {
        if (hash(claimed.origin) !== hash(origin) || claimed.operation !== operation) fail('Job ID already belongs to a different origin or operation.', 'idempotency_conflict');
        return claimed;
    }
    const running = [...active.keys()].filter(key => path.dirname(key) === path.dirname(file)).length;
    if (running >= MAX_RUNNING) fail('Too many active generation jobs.', 'capacity');
    if (jobs.length >= MAX_RECORDS && !jobs.some(item => item.status === 'completed')) fail('Job storage is full; resolve retained jobs before generating.', 'capacity');
    const target = chatPath(user, origin);
    const snapshot = readChat(target);
    if (origin.expectedLength !== undefined && origin.expectedLength !== snapshot.length) fail('The original chat was not saved or changed. Reload and try again.', 'origin_conflict');
    const integrity = snapshot[0]?.chat_metadata?.integrity;
    if (!origin.group && !integrity) fail('Save the original chat with integrity metadata before generating.', 'origin_conflict');
    if (origin.integrity && origin.integrity !== integrity) fail('Original chat identity changed.', 'origin_conflict');
    if (!snapshot.length || (operation !== 'append' && snapshot.length < (origin.group ? 1 : 2))) fail('Original message is unavailable.', 'origin_conflict');
    const job = { id, origin: copy(origin), operation, ...(typeof imageBoost === 'boolean' ? { imageBoost } : {}), status: 'queued', createdAt: new Date().toISOString(), integrity,
        anchor: snapshot.map(hash), targetIndex: snapshot.length - 1, relativeChat: path.relative(scope(user).root, target) };
    save(file, job);
    const controller = new AbortController();
    active.set(file, controller);
    const commitOutput = output => {
        job.result = output?.result ?? null;
        job.message = copy(output?.message ?? message);
        if (!job.message || typeof job.message !== 'object' || Array.isArray(job.message)) fail('Runner did not return a chat message.', 'invalid_result');
        job.message.extra = { ...job.message.extra, generation_job: id };
        delete job.message.extra.generation_job_processed;
        delete job.message.extra.generation_job_previous;
        save(file, job);
        const current = readChat(target);
        if (!current.some(row => row.extra?.generation_job === id)) {
            if (!origin.group && current[0]?.chat_metadata?.integrity !== integrity) fail('Original chat identity changed; generated result is retained in this job.');
            if (current.length < job.anchor.length || current.slice(0, job.anchor.length).some((row, index) => hash(row) !== job.anchor[index]) || (current.length > job.anchor.length && (operation !== 'append' || current.slice(job.anchor.length).some(row => !row.extra?.generation_job)))) fail('Original chat was edited while generating; generated result is retained in this job.');
            if (operation === 'append') current.push(job.message);
            else {
                job.message.extra.generation_job_previous = job.anchor[job.targetIndex];
                if (operation === 'swipe') {
                    const previous = current[job.targetIndex];
                    job.message.swipes = [...(previous.swipes ?? [previous.mes]), job.message.mes];
                    job.message.swipe_id = job.message.swipes.length - 1;
                    job.message.swipe_info = [...(previous.swipe_info ?? []), ...(job.message.swipe_info?.slice(-1) ?? [])];
                }
                current[job.targetIndex] = job.message;
            }
            if (!origin.group) current[0].chat_metadata.generation_revision = id;
            atomic(target, current.map(row => JSON.stringify(row)).join('\n'));
        }
        job.summaryAnchor = current.map(storyHash);
        // A concurrent append can be committed by the ordinary durable path,
        // but this model never read that other result. Do not claim its coverage.
        job.summaryCoverageValid = operation === 'append' && current.length === snapshot.length + 1 &&
            snapshot.every((row, index) => storyHash(row) === storyHash(current[index]));
        job.timings = { ...job.timings, committed: Date.now() - Date.parse(job.createdAt) };
        save(file, job);
    };
    // Trim only old successful records: failures/conflicts retain recoverable output.
    const prune = jobs.filter(item => item.status === 'completed').reverse().slice(0, Math.max(0, jobs.length - MAX_RECORDS + 1));
    for (const item of prune) fs.unlinkSync(recordPath(user, item.id));
    void (async () => {
        try {
            job.status = 'running';
            save(file, job);
            const output = await runner({ signal: controller.signal, update: progress => {
                if (progress?.toolReceipts && controller.signal.aborted) {
                    const cancelled = load(file);
                    cancelled.toolReceipts = copy(progress.toolReceipts);
                    save(file, cancelled);
                    return;
                }
                if (!controller.signal.aborted && !terminal.has(job.status)) {
                    recordPhaseDiagnostics(job, progress);
                    // Preview stays in memory; never persist partial dialogue or write per token.
                    if (typeof progress?.preview === 'string') previews.set(file, progress.preview.slice(-32000));
                    job.progress = { ...job.progress, phase: String(progress?.phase ?? job.progress?.phase ?? '').slice(0, 80), received: Number(progress?.received) || job.progress?.received || 0 };
                    if (['dialogue', 'latest-state', 'episodic'].includes(progress?.workPhase)) {
                        if (job.progress.workPhase !== progress.workPhase) { delete job.progress.inputProgress; job.progress.reading = false; job.progress.phaseStartedAt = Date.now(); }
                        job.progress.workPhase = progress.workPhase;
                    }
                    if (typeof progress?.reading === 'boolean') job.progress.reading = progress.reading;
                    if (typeof progress?.longReadPossible === 'boolean') job.progress.longReadPossible = progress.longReadPossible;
                    if (progress?.inputProgress) job.progress.inputProgress = Object.fromEntries(Object.entries(progress.inputProgress).filter(([key, value]) => key === 'fraction' ? Number.isFinite(value) && value >= 0 && value <= 1 : ['cachedTokens', 'totalTokens', 'processedTokens'].includes(key) && Number.isSafeInteger(value) && value >= 0));
                    if (progress?.memoryOutcome) job.memoryOutcome = copy(progress.memoryOutcome);
                    if ('toolPending' in (progress || {})) job.toolPending = copy(progress.toolPending);
                    if (progress?.toolReceipts) job.toolReceipts = copy(progress.toolReceipts);
                    if (typeof progress?.promptId === 'string' && /^[a-zA-Z0-9_-]{1,200}$/u.test(progress.promptId)) job.progress.promptId = progress.promptId;
                    if (progress?.contextSummary) job.contextSummary = copy(progress.contextSummary);
                    if (progress?.memoryMetrics) job.memoryMetrics = copy(progress.memoryMetrics);
                    if (Number.isSafeInteger(progress?.lastVisibleAt)) {
                        job.timings ??= {};
                        job.timings.lastVisible = progress.lastVisibleAt - Date.parse(job.createdAt);
                    }
                    if (['firstContent', 'firstReasoning', 'serverFirstVisible'].includes(progress?.event) && Number.isSafeInteger(progress.receivedAt)) {
                        job.timings ??= {};
                        job.timings[progress.event] ??= progress.receivedAt - Date.parse(job.createdAt);
                    }
                    if (progress?.streamMetrics) {
                        job.timings ??= {};
                        const metrics = progress.streamMetrics;
                        for (const key of ['requestedAt', 'responseReceivedAt', 'firstContentAt', 'firstReasoningAt', 'serverFirstVisibleAt', 'completedAt']) {
                            if (Number.isSafeInteger(metrics[key])) job.timings[`provider_${key}`] = metrics[key] - Date.parse(job.createdAt);
                        }
                    }
                    if (['modelPreparation', 'modelRequest', 'firstToken', 'firstVisible', 'modelComplete', 'dialogueComplete', 'summaryComplete', 'drawing', 'comfySubmitted', 'imageReceived', 'imageSaved'].includes(progress?.event)) {
                        job.timings ??= {};
                        job.timings[progress.event] ??= Date.now() - Date.parse(job.createdAt);
                    }
                    if (progress?.modelStats) {
                        job.modelStats = Object.fromEntries(['inputTokens', 'outputTokens', 'reasoningTokens', 'cachedTokens'].filter(key => Number.isSafeInteger(progress.modelStats[key]) && progress.modelStats[key] >= 0).map(key => [key, progress.modelStats[key]]));
                        if (['stop', 'length', 'tool_calls', 'content_filter', 'function_call'].includes(progress.modelStats.finishReason)) job.modelStats.finishReason = progress.modelStats.finishReason;
                    }
                    if (progress?.dialogueOutput && !job.dialogueReady) {
                        commitOutput(progress.dialogueOutput);
                        job.dialogueReady = true;
                        job.sessionSummary = { status: 'pending' };
                        save(file, job);
                    }
                    if (progress?.event || progress?.phase || progress?.promptId || Date.now() - (job.progressPersistedAt || 0) >= 1000) { job.progressPersistedAt = Date.now(); save(file, job); }
                }
            } });
            if (controller.signal.aborted) return;
            finishPhaseDiagnostics(job);
            if (job.dialogueReady) {
                // The browser can edit/save the committed dialogue while the hidden
                // tail runs. Store the summary in this job, never rewrite the chat.
                job.sessionSummary = output.sessionSummary ?? { status: 'failed', error: 'Missing summary result' };
                if (job.sessionSummary?.mode === 'context-v1') validatePrefixResult(user, target, job);
                else if (!job.summaryCoverageValid) job.sessionSummary.usable = false;
                job.status = 'completed';
                job.timings = { ...job.timings, summaryPersisted: Date.now() - Date.parse(job.createdAt) };
                save(file, job);
                return;
            }
            commitOutput(output);
            if (output?.sessionSummary) job.sessionSummary = copy(output.sessionSummary);
            if (job.sessionSummary && !job.summaryCoverageValid) job.sessionSummary.usable = false;
            job.status = 'completed';
            save(file, job);
        } catch (error) {
            if (!controller.signal.aborted) {
                job.status = job.dialogueReady ? 'completed' : job.message ? 'conflict' : 'failed';
                finishPhaseDiagnostics(job);
                if (job.dialogueReady) job.sessionSummary = { status: 'failed', error: String(error.message || error) };
                else job.error = String(error.message || error);
                save(file, job);
            }
        } finally {
            active.delete(file);
            previews.delete(file);
        }
    })().catch(error => console.error('Could not persist generation job status:', error));
    return copy(job);
}

export async function cancelJob(user, id) {
    const file = recordPath(user, id);
    const job = load(file);
    if (!job || terminal.has(job.status)) return job;
    active.get(file)?.abort();
    job.status = job.dialogueReady ? 'completed' : 'cancelled';
    finishPhaseDiagnostics(job);
    if (job.dialogueReady) job.sessionSummary = { status: 'cancelled', ...(job.progress?.workPhase ? { keepRaw: true, memoryOutcome: { ...job.memoryOutcome, episodicStatus: 'cancelled', keepRaw: true } } : {}) };
    save(file, job);
    return job;
}

/** Cancel only already-saved hidden tails; foreground provider work is untouched. */
export async function stopPendingSessionSummaries(user, origin) {
    for (const job of await listJobs(user)) {
        if ((!origin || (job.origin.file === origin.file && job.origin.avatar === origin.avatar && job.origin.group === origin.group)) && job.dialogueReady && job.sessionSummary?.status === 'pending' && !terminal.has(job.status)) await cancelJob(user, job.id);
    }
}

/** A summary covers an exact semantic prefix; later unprocessed rows stay raw. */
export async function latestSessionSummary(user, origin, contextKey) {
    const current = readChat(chatPath(user, origin));
    for (const job of await listJobs(user)) {
        if (job.origin.file !== origin.file || job.origin.avatar !== origin.avatar || job.origin.group !== origin.group || job.integrity !== current[0]?.chat_metadata?.integrity) continue;
        if (job.sessionSummary?.status !== 'complete') continue;
        const anchor = job.sessionSummary.mode === 'context-v1' ? job.prefixAnchor : job.summaryAnchor;
        if (!anchor?.length) continue;
        if (job.sessionSummary.usable === false) continue;
        if (job.sessionSummary.mode !== 'context-v1' && job.summaryCoverageValid === false) continue;
        if (contextKey !== undefined && job.sessionSummary.contextKey !== contextKey) continue;
        if (current.length < anchor.length || current.slice(0, anchor.length).some((row, index) => storyHash(row) !== anchor[index])) continue;
        return { summary: job.sessionSummary.summary, coveredRows: anchor.length, pendingRows: current.length - anchor.length,
            coveredTurns: job.sessionSummary.mode === 'context-v1' ? job.sessionSummary.summary.through_turn : current.slice(1, anchor.length).filter(row => row.is_user).length };
    }
    return null;
}

/** Prove provider dialogue is an exact text-only suffix of the chat.
 * Filtering, merged turns, examples and ST truncation cannot masquerade as full
 * coverage. A partial suffix is safe only with an earlier valid checkpoint.
 */
export function contextMemorySourceCoverage(user, origin, messages) {
    if (origin.group) return null;
    return nativeProviderCoverage(readChat(chatPath(user, origin)), messages);
}

export function sessionSummarySourceCoverage(user, origin, messages, { allowSynthetic = false } = {}) {
    const current = readChat(chatPath(user, origin));
    if (!Array.isArray(messages) || origin.group) return null;
    if (messages.some(row => !['system', 'user', 'assistant'].includes(row.role) || typeof row.content !== 'string' || row.tool_calls || row.tool_call_id || row.function_call)) return null;
    // ST inserts role/extension instructions after the last user message. These
    // are fresh instructions, not chat rows, and must survive compaction.
    const transcript = messages.filter(row => row.role !== 'system');
    if (allowSynthetic && transcript[0]?.role === 'user' && transcript[0].content === '[Start a new chat]' && transcript[1]?.role === 'assistant' && current[1]?.is_user === false && transcript[1].content.trim() === current[1].mes.trim()) transcript.shift();
    if (allowSynthetic && transcript.at(-1)?.role === 'assistant' && /^\s*(?:<think>\s*)?<\/think>\s*$/u.test(transcript.at(-1)?.content)) transcript.pop();
    if (!transcript.length) return null;
    const start = current.length - transcript.length;
    if (start < 1) return null;
    const matches = current.slice(start).every((row, index) => !row.is_system && typeof row.mes === 'string' &&
        !row.extra?.media?.length && transcript[index].role === (row.is_user ? 'user' : 'assistant') && transcript[index].content.trim() === row.mes.trim());
    return matches ? { firstRow: start, rows: current.length } : null;
}

/** Keep instructions before history and end with the current query.
 * Coverage is a processed prefix, not proof of semantic completeness.
 */
export function compactSessionMessages(messages, summaryContent, pendingCount) {
    const instructions = messages.filter(row => row.role === 'system');
    const dialogue = messages.filter(row => row.role !== 'system');
    if (!Number.isInteger(pendingCount) || pendingCount < 0 || pendingCount > dialogue.length) throw new Error('Invalid unprocessed dialogue range');
    const pending = dialogue.slice(dialogue.length - pendingCount);
    // A completed checkpoint ends after an assistant reply, never mid-turn.
    if (pending.length && pending[0].role !== 'user') throw new Error('Checkpoint splits a dialogue turn');
    return [...instructions, { role: 'system', content: summaryContent }, ...pending];
}

/** Synchronous guard: call immediately before ordinary atomic chat save.
 * Returns merged chat rows; force explicitly permits deleting generated messages.
 * Changed positional targets raise an actionable conflict rather than overwrite edits.
 */
export function protectJobResults(filePath, chatData, force = false) {
    if (force || !fs.existsSync(filePath)) return chatData;
    const current = readChat(filePath);
    const generated = current.map((message, index) => ({ message, index })).filter(({ message }) => message.extra?.generation_job);
    if (!generated.length) return chatData;
    if (current[0]?.chat_metadata?.integrity && current[0].chat_metadata.integrity !== chatData[0]?.chat_metadata?.integrity) fail('Chat identity changed; reload before saving.', 'origin_conflict');
    // A browser that loaded this completion can intentionally edit/delete it.
    // Older snapshots cannot overwrite or delete a completion they never observed.
    const revision = current[0]?.chat_metadata?.generation_revision;
    if (revision && chatData[0]?.chat_metadata?.generation_revision === revision) return chatData;
    const merged = copy(chatData);
    if (revision && merged[0]?.chat_metadata) merged[0].chat_metadata.generation_revision = revision;
    for (const { message, index } of generated) {
        const known = merged.findIndex(row => row.extra?.generation_job === message.extra.generation_job);
        if (known >= 0) {
            if (hash(merged[known]) !== hash(message)) fail('The story changed during generation. Reload before applying this edit.');
            continue;
        }
        const previous = message.extra.generation_job_previous;
        if (previous) {
            if (!merged[index] || hash(merged[index]) !== previous) fail('Generated message conflicts with a stale edit; reload the original chat or explicitly force save.');
            merged[index] = copy(message);
        } else merged.push(copy(message));
    }
    return merged;
}

/** Native source is authoritative; ST's already truncated suffix is not an archive. */
export function readNativeSession(user, origin) {
    return nativeSession(readChat(chatPath(user, origin)));
}

function validatePrefixResult(user, target, job) {
    if (job.sessionSummary.status !== 'complete') return;
    const current = readChat(target);
    const session = nativeSession(current);
    const through = job.sessionSummary.summary.through_turn;
    const catalog = sourcesFor(session.messages, through);
    if (!Array.isArray(job.sessionSummary.targetAnchor) || current.length < job.sessionSummary.targetAnchor.length || current.slice(0, job.sessionSummary.targetAnchor.length).some((row, index) => storyHash(row) !== job.sessionSummary.targetAnchor[index]) || revision(catalog) !== job.sessionSummary.sourceRevision || current[0]?.chat_metadata?.integrity !== job.integrity) {
        job.sessionSummary = { ...job.sessionSummary, status: 'failed', usable: false, keepRaw: true, memoryOutcome: { ...job.sessionSummary.memoryOutcome, episodicStatus: 'failed', keepRaw: true }, error: 'Consolidated source was edited' };
        return;
    }
    // Compare completed checkpoints synchronously immediately before atomic journal save.
    const newer = fs.readdirSync(scope(user).directory).filter(name => name.endsWith('.json')).map(name => load(path.join(scope(user).directory, name)))
        .some(other => other.id !== job.id && other.sessionSummary?.mode === 'context-v1' && other.sessionSummary.status === 'complete'
            && other.sessionSummary.usable !== false && other.sessionSummary.contextKey === job.sessionSummary.contextKey
            && other.integrity === job.integrity && other.origin.file === job.origin.file && other.origin.avatar === job.origin.avatar
            && other.prefixAnchor?.length && current.length >= other.prefixAnchor.length
            && current.slice(0, other.prefixAnchor.length).every((row, index) => storyHash(row) === other.prefixAnchor[index])
            && other.sessionSummary.summary.through_turn > job.sessionSummary.previousThrough);
    if (newer) { job.sessionSummary = { ...job.sessionSummary, status: 'failed', usable: false, keepRaw: true, memoryOutcome: { ...job.sessionSummary.memoryOutcome, episodicStatus: 'failed', keepRaw: true }, error: 'Checkpoint advanced during consolidation' }; return; }
    job.prefixAnchor = current.slice(0, nativePrefixBoundary(session, through)).map(storyHash);
    job.sessionSummary.usable = true;
}
