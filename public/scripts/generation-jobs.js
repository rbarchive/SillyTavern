import { ToolManager } from './tool-calling.js';
import { uuidv4 } from './utils.js';
import { characters, this_chid, chat, chat_metadata, getRequestHeaders, loadGenerationJobResult, eventSource, event_types, is_send_press, applyGenerationJobResult, stopGeneration } from '../script.js';
import { selected_group, groups } from './group-chats.js';
import { failureNotices, generationFailureMessage } from './generation-job-notifications.js';
import { correctKoreanDialogueDisplay } from './korean-dialogue-display.js';
import { generationProgressDisplay, visibleGenerationJobs } from './generation-progress-display.js';

const terminal = new Set(['completed', 'failed', 'conflict', 'cancelled', 'interrupted']);
const observed = new Set();
const waiting = new Set();
let recovering = false;
let knownJobs = [];
let foregroundGeneration = null;
const decidingTools = new Set();
let noticeStorage;
let previousNoticeStorage;
try { previousNoticeStorage = window.sessionStorage; } catch { /* Storage can be disabled. */ }
try { noticeStorage = window.localStorage; } catch { /* Fall back to tab-local receipts. */ }
const notifiedFailures = failureNotices(noticeStorage || previousNoticeStorage, previousNoticeStorage);

export function generationOrigin() {
    const file = selected_group ? groups.find(g => g.id === selected_group)?.chat_id : characters[this_chid]?.chat;
    return { avatar: characters[this_chid]?.avatar, file, group: selected_group || undefined, integrity: chat_metadata.integrity, expectedLength: chat.length + (selected_group ? 0 : 1) };
}
function sameOrigin(origin) {
    const current = generationOrigin();
    return current.file === origin?.file && current.avatar === origin?.avatar && current.group === origin?.group && current.integrity === origin?.integrity;
}
function showPreview(job) {
    if (!sameOrigin(job.origin) || !job.preview) return;
    const container = document.querySelector('#chat');
    const atBottom = container && container.scrollHeight - container.scrollTop - container.clientHeight < 150;
    let element = document.getElementById('generation_preview');
    if (!element) {
        element = document.createElement('div');
        element.id = 'generation_preview';
        element.style.cssText = 'white-space:pre-wrap;padding:1em;opacity:.9;';
        element.setAttribute('role', 'status');
        document.querySelector('#chat')?.append(element);
    }
    element.textContent = correctKoreanDialogueDisplay(job.preview, { streaming: !terminal.has(job.status) });
    if (atBottom) container.scrollTop = container.scrollHeight;
    return element;
}
async function resolvePendingTool(job, approved) {
    if (!sameOrigin(job.origin) || decidingTools.has(job.id)) return;
    decidingTools.add(job.id);
    const pending = job.toolPending;
    try {
        if (pending.mode === 'client') {
            const matchesScope = globalThis[Symbol.for('sillytavern.rpMemoryBackgroundScope')];
            if (typeof matchesScope !== 'function' || !matchesScope(pending.scope)) throw new Error('세계관 연결을 확인 중입니다. 원래 대화에서 다시 실행해 주세요.');
            await request(`/api/generation-jobs/${job.id}/tool-decision`, { method: 'POST', body: JSON.stringify({ token: pending.token, claim: true }) });
            if (!sameOrigin(job.origin) || !matchesScope(pending.scope)) throw new Error('원래 대화에서 도구 실행을 완료해 주세요.');
            const value = await ToolManager.invokeFunctionTools({ choices: [{ index: 0, message: { tool_calls: [{ id: pending.token, type: 'function', function: { name: pending.name, arguments: pending.arguments } }] } }] });
            const result = value.invocations?.[0]?.result || value.errors?.[0]?.message || '도구 실행 결과가 없습니다. 실행 완료로 간주하지 마세요.';
            await request(`/api/generation-jobs/${job.id}/tool-decision`, { method: 'POST', body: JSON.stringify({ token: pending.token, result: String(result) }) });
            await globalThis[Symbol.for('sillytavern.rpMemoryBackgroundNavigation')]?.();
        } else {
            await request(`/api/generation-jobs/${job.id}/tool-decision`, { method: 'POST', body: JSON.stringify({ token: pending.token, approved }) });
        }
    } catch (error) { toastr.error(error.message, '세계관 도구 처리'); }
    finally { decidingTools.delete(job.id); recoverGenerationJobs(); }
}
function clearPreview() { document.getElementById('generation_preview')?.remove(); }
function reportTiming(job, started, preparationMs) {
    console.info('Generation timing (milliseconds)', JSON.stringify({ id: job.id, server: job.timings, preparation: preparationMs, observer: Math.round(performance.now() - started) }));
}
const pause = (ms = 1000) => new Promise(resolve => setTimeout(resolve, ms));
async function request(url, options = {}) {
    const response = await fetch(url, { ...options, headers: getRequestHeaders() });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `Generation request HTTP ${response.status}`);
    return response.json();
}

/** Accept once; an observer's lost connection never cancels the server job. */
export async function runGenerationJob(payload, signal, onProgress = () => {}) {
    const started = performance.now();
    const id = uuidv4();
    const origin = payload.origin || generationOrigin();
    let job;
    let previewRecorded = false;
    let cancelRequested = false;
    const cancel = () => { cancelRequested = true; request(`/api/generation-jobs/${id}/cancel`, { method: 'POST' }).catch(() => {}); };
    signal?.addEventListener('abort', cancel, { once: true });
    waiting.add(id);
    try {
        while (!job) {
            try { job = await request('/api/generation-jobs', { method: 'POST', body: JSON.stringify({ ...payload, id, origin }) }); }
            catch (error) {
                if (!(error instanceof TypeError)) throw error;
                onProgress({ stage: 'reconnecting' });
                await pause();
            }
        }
        // Show the persistent progress/cancel row as soon as acceptance succeeds.
        await recoverGenerationJobs(job);
        if (signal?.aborted) { cancelRequested = true; job = await request(`/api/generation-jobs/${id}/cancel`, { method: 'POST' }); }
        while (!terminal.has(job.status) && !job.dialogueReady) {
            if (cancelRequested) await request(`/api/generation-jobs/${id}/cancel`, { method: 'POST' }).catch(() => {});
            onProgress(job);
            if (payload.kind === 'chat') {
                const element = showPreview(job);
                if (!previewRecorded && element?.isConnected && !document.hidden) {
                    previewRecorded = true;
                    console.info('Generation first preview DOM (milliseconds)', JSON.stringify({ id, observer: Math.round(performance.now() - started) }));
                    // Two animation frames indicate a render opportunity, not proof of physical paint.
                    if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
                        if (!document.hidden && element.isConnected && sameOrigin(origin)) console.info('Generation first preview render opportunity (milliseconds)', JSON.stringify({ id, observer: Math.round(performance.now() - started) }));
                    }));
                }
            }
            await pause(500);
            try {
                job = await request(`/api/generation-jobs/${id}`);
                await recoverGenerationJobs(job);
            }
            catch (error) {
                if (!(error instanceof TypeError)) throw error;
                onProgress({ stage: 'reconnecting' });
            }
        }
        if (job.status === 'cancelled') throw new DOMException('Stopped by user', 'AbortError');
        if (job.status !== 'completed' && !job.dialogueReady) {
            notifiedFailures.add(job.id);
            throw new Error(generationFailureMessage(job.error || '생성 결과를 원래 이야기에 저장하지 못했습니다.'));
        }
        if (sameOrigin(origin)) {
            clearPreview();
            if (await loadGenerationJobResult(job)) {
                console.info('Generation DOM ready (milliseconds)', JSON.stringify({ id, observer: Math.round(performance.now() - started) }));
                if (job.result?.path) {
                    const image = [...document.querySelectorAll('#chat img')].find(img => decodeURI(img.getAttribute('src') || '').endsWith(job.result.path));
                    const record = () => console.info('Generation image loaded (milliseconds)', JSON.stringify({ id, observer: Math.round(performance.now() - started), width: image.naturalWidth, height: image.naturalHeight }));
                    if (image?.complete && image.naturalWidth) record();
                    else image?.addEventListener('load', record, { once: true });
                }
                if (await applyGenerationJobResult(job, job.operation === 'append' ? 'normal' : job.operation)) observed.add(id);
            }
        }
        reportTiming(job, started, payload.clientPreparationMs);
        return job;
    } finally {
        clearPreview();
        waiting.delete(id);
        signal?.removeEventListener('abort', cancel);
    }
}

/** Discover even jobs whose acceptance response was lost when the page closed. */
async function recoverGenerationJobs(snapshot) {
    if (recovering || document.hidden) return;
    recovering = true;
    try {
        // Foreground observation already fetched this receipt; reuse it for progress UI.
        const jobs = snapshot?.id
            ? [...knownJobs.filter(job => job.id !== snapshot.id), snapshot]
            : await request('/api/generation-jobs');
        knownJobs = jobs;
        const relevant = jobs.filter(job => sameOrigin(job.origin));
        const active = relevant.filter(job => !terminal.has(job.status));
        const foreground = foregroundGeneration && sameOrigin(foregroundGeneration.origin) ? foregroundGeneration : null;
        const visible = active.length ? visibleGenerationJobs(relevant) : foreground ? [foreground] : visibleGenerationJobs(relevant);
        let status = document.querySelector('#background_generation_status');
        if (visible.length && !status) {
            status = document.createElement('div');
            status.id = 'background_generation_status';
            status.style.cssText = 'order:24;flex-basis:100%;width:100%;font-size:.85em;padding:.4em;';
            status.setAttribute('role', 'status');
            status.setAttribute('aria-live', 'polite');
            document.querySelector('#send_form')?.prepend(status);
        }
        if (status) {
            const displays = visible.map(job => ({ job, text: generationProgressDisplay(job) }));
            const signature = JSON.stringify(displays.map(({ job, text }) => [job.id, job.status, text, job.toolPending]));
            // Leave a terminal receipt in place, so polling does not announce the same failure again.
            if (status.dataset.displaySignature !== signature) {
                status.textContent = '';
                for (const { job, text } of displays) {
                    const row = document.createElement('div');
                    row.textContent = text;
                    if (terminal.has(job.status)) { status.append(row); continue; }
                    if (!job.foregroundOnly) row.append(document.createTextNode(' · 다른 화면에서도 계속 처리됩니다 '));
                    const stop = document.createElement('button');
                    stop.className = 'menu_button';
                    stop.textContent = '중지';
                    stop.onclick = job.foregroundOnly ? () => stopGeneration() : () => request(`/api/generation-jobs/${job.id}/cancel`, { method: 'POST' }).then(recoverGenerationJobs);
                    row.append(stop);
                    if (job.toolPending) {
                        const detail = document.createElement('pre');
                        detail.style.cssText = 'white-space:pre-wrap;max-height:16em;overflow:auto;';
                        detail.textContent = `대상: ${job.toolPending.scope?.world || ''}${job.toolPending.scope?.branch ? ' / ' + job.toolPending.scope.branch.id : ''}${job.toolPending.scope?.characterId ? ' / ' + job.toolPending.scope.characterId : ''}\n${ToolManager.getDisplayName(job.toolPending.name) || job.toolPending.name}\n${job.toolPending.arguments}`;
                        row.append(detail);
                        const action = document.createElement('button');
                        action.className = 'menu_button';
                        action.textContent = job.toolPending.mode === 'client' ? '요청한 화면 작업 실행' : '위 내용 저장 승인';
                        action.disabled = Boolean(job.toolPending.claimed);
                        action.onclick = () => resolvePendingTool(job, true);
                        row.append(action);
                        if (job.toolPending.mode !== 'client') {
                            const reject = document.createElement('button');
                            reject.className = 'menu_button'; reject.textContent = '저장하지 않음';
                            reject.onclick = () => resolvePendingTool(job, false); row.append(reject);
                        } else if (job.toolPending.claimed) row.append(document.createTextNode(' 화면 작업을 이미 시작했습니다. 재실행하지 않습니다.'));
                    }
                    status.append(row);
                }
                status.dataset.displaySignature = signature;
            }
            status.hidden = !visible.length;
        }
        const orphan = active.find(job => !waiting.has(job.id) && job.progress?.phase === 'dialogue');
        if (orphan) showPreview(await request(`/api/generation-jobs/${orphan.id}`));
        if (!active.length) clearPreview();
        let refreshed = false;
        for (const job of relevant) {
            if (!sameOrigin(job.origin)) break;
            if ((!terminal.has(job.status) && !job.dialogueReady) || observed.has(job.id) || waiting.has(job.id)) continue;
            if (job.status === 'completed' || job.dialogueReady) {
                if (is_send_press) continue;
                if (!chat.some(message => message.extra?.generation_job === job.id) && !refreshed) {
                    if (!await loadGenerationJobResult(job)) continue;
                    refreshed = true;
                }
                if (!await applyGenerationJobResult(job, job.operation === 'append' ? 'normal' : job.operation)) continue;
            } else if (job.status !== 'cancelled' && !notifiedFailures.has(job.id)) {
                toastr.error(generationFailureMessage(job.error), '저장된 생성 작업 오류');
                notifiedFailures.add(job.id);
            }
            observed.add(job.id);
        }
    } catch (error) { console.debug('Background generation recovery deferred:', error); }
    finally { recovering = false; }
}
export function initializeGenerationJobs() {
    eventSource.on(event_types.GENERATION_STARTED, (type, _options, dryRun) => {
        if (dryRun || type === 'quiet') return;
        if (!foregroundGeneration || !sameOrigin(foregroundGeneration.origin)) foregroundGeneration = {
            id: 'foreground', foregroundOnly: true, status: 'running', createdAt: new Date().toISOString(), origin: generationOrigin(),
        };
        recoverGenerationJobs();
    });
    for (const event of [event_types.GENERATION_ENDED, event_types.GENERATION_STOPPED]) {
        eventSource.on(event, () => { foregroundGeneration = null; recoverGenerationJobs(); });
    }
    eventSource.on(event_types.APP_READY, recoverGenerationJobs);
    eventSource.on(event_types.CHAT_CHANGED, () => { foregroundGeneration = null; clearPreview(); recoverGenerationJobs(); });
    document.addEventListener('visibilitychange', recoverGenerationJobs);
    window.addEventListener('online', recoverGenerationJobs);
    setInterval(() => { if (!waiting.size) recoverGenerationJobs(); }, 1000);
}
