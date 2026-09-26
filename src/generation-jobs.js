/** Durable, user-scoped generation jobs. Providers are never replayed after restart. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const active = new Map();
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
function scope(user) {
    if (!user?.directories?.root) fail('Authenticated user directories required.', 'invalid_request');
    const root = path.resolve(user.directories.root);
    const directory = path.join(root, 'generation-jobs');
    fs.mkdirSync(directory, { recursive: true });
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
    atomic(file, JSON.stringify(job));
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
        save(file, job);
    }
    return job;
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

/** Accept once, persist before launching, and run independently of the HTTP connection.
 * runner({signal, update}) returns {message, result}; update accepts JSON progress.
 * message is the full final chat message. result is provider output for retrieval.
 */
export async function acceptJob(user, { id, origin, operation = 'append', message }, runner) {
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
    const job = { id, origin: copy(origin), operation, status: 'queued', createdAt: new Date().toISOString(), integrity,
        anchor: snapshot.map(hash), targetIndex: snapshot.length - 1, relativeChat: path.relative(scope(user).root, target) };
    save(file, job);
    const controller = new AbortController();
    active.set(file, controller);
    // Trim only old successful records: failures/conflicts retain recoverable output.
    const prune = jobs.filter(item => item.status === 'completed').reverse().slice(0, Math.max(0, jobs.length - MAX_RECORDS + 1));
    for (const item of prune) fs.unlinkSync(recordPath(user, item.id));
    void (async () => {
        try {
            job.status = 'running';
            save(file, job);
            const output = await runner({ signal: controller.signal, update: progress => {
                if (!controller.signal.aborted && !terminal.has(job.status)) {
                    // Restrict persisted progress to harmless structural state.
                    job.progress = { phase: String(progress?.phase ?? '').slice(0, 80), received: Number(progress?.received) || 0 };
                    if (typeof progress?.promptId === 'string' && /^[a-zA-Z0-9_-]{1,200}$/u.test(progress.promptId)) job.progress.promptId = progress.promptId;
                    save(file, job);
                }
            } });
            if (controller.signal.aborted) return;
            job.result = output?.result ?? null;
            job.message = copy(output?.message ?? message);
            if (!job.message || typeof job.message !== 'object' || Array.isArray(job.message)) fail('Runner did not return a chat message.', 'invalid_result');
            job.message.extra = { ...job.message.extra, generation_job: id };
            delete job.message.extra.generation_job_processed;
            delete job.message.extra.generation_job_previous;
            save(file, job); // Retain provider output before the chat commit/crash window.
            const current = readChat(target);
            if (current.some(row => row.extra?.generation_job === id)) {
                job.status = 'completed';
            } else {
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
                job.status = 'completed';
            }
            save(file, job);
        } catch (error) {
            if (!controller.signal.aborted) {
                job.status = job.message ? 'conflict' : 'failed';
                job.error = String(error.message || error);
                save(file, job);
            }
        } finally {
            active.delete(file);
        }
    })().catch(error => console.error('Could not persist generation job status:', error));
    return copy(job);
}

export async function cancelJob(user, id) {
    const file = recordPath(user, id);
    const job = load(file);
    if (!job || terminal.has(job.status)) return job;
    active.get(file)?.abort();
    job.status = 'cancelled';
    save(file, job);
    return job;
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
