import { uuidv4 } from './utils.js';
import { characters, this_chid, chat, chat_metadata, getRequestHeaders, getCurrentChatId, reloadCurrentChat, eventSource, event_types, is_send_press, applyGenerationJobResult } from '../script.js';
import { selected_group, groups } from './group-chats.js';

const terminal = new Set(['completed', 'failed', 'conflict', 'cancelled', 'interrupted']);
const observed = new Set();
const waiting = new Set();
let recovering = false;

export function generationOrigin() {
    const file = selected_group ? groups.find(g => g.id === selected_group)?.chat_id : characters[this_chid]?.chat;
    return { avatar: characters[this_chid]?.avatar, file, group: selected_group || undefined, integrity: chat_metadata.integrity, expectedLength: chat.length + (selected_group ? 0 : 1) };
}
function sameOrigin(origin) {
    const current = generationOrigin();
    return current.file === origin?.file && current.avatar === origin?.avatar && current.group === origin?.group;
}
const pause = () => new Promise(resolve => setTimeout(resolve, 1000));
async function request(url, options = {}) {
    const response = await fetch(url, { ...options, headers: getRequestHeaders() });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `Generation request HTTP ${response.status}`);
    return response.json();
}

/** Accept once; an observer's lost connection never cancels the server job. */
export async function runGenerationJob(payload, signal, onProgress = () => {}) {
    const id = uuidv4();
    const origin = payload.origin || generationOrigin();
    let job;
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
        if (signal?.aborted) { cancelRequested = true; job = await request(`/api/generation-jobs/${id}/cancel`, { method: 'POST' }); }
        while (!terminal.has(job.status)) {
            if (cancelRequested) await request(`/api/generation-jobs/${id}/cancel`, { method: 'POST' }).catch(() => {});
            onProgress(job);
            await pause();
            try { job = await request(`/api/generation-jobs/${id}`); }
            catch (error) {
                if (!(error instanceof TypeError)) throw error;
                onProgress({ stage: 'reconnecting' });
            }
        }
        observed.add(id);
        if (job.status === 'cancelled') throw new DOMException('Stopped by user', 'AbortError');
        if (job.status !== 'completed') throw new Error(job.error || '생성 결과를 원래 이야기에 저장하지 못했습니다.');
        if (sameOrigin(origin)) {
            await reloadCurrentChat();
            await applyGenerationJobResult(job, job.operation === 'append' ? 'normal' : job.operation);
        }
        return job;
    } finally {
        waiting.delete(id);
        signal?.removeEventListener('abort', cancel);
    }
}

/** Discover even jobs whose acceptance response was lost when the page closed. */
async function recoverGenerationJobs() {
    if (recovering || document.hidden) return;
    recovering = true;
    try {
        const jobs = await request('/api/generation-jobs');
        const relevant = jobs.filter(job => sameOrigin(job.origin));
        const active = relevant.filter(job => !terminal.has(job.status));
        let status = document.querySelector('#background_generation_status');
        if (active.length && !status) {
            status = document.createElement('div');
            status.id = 'background_generation_status';
            status.style.cssText = 'order:24;flex-basis:100%;width:100%;font-size:.85em;padding:.4em;';
            status.setAttribute('role', 'status');
            status.setAttribute('aria-live', 'polite');
            document.querySelector('#send_form')?.prepend(status);
        }
        if (status) {
            status.textContent = '';
            for (const job of active) {
                const row = document.createElement('div');
                row.textContent = `${job.progress?.phase === 'drawing' ? '이미지' : '응답'} 생성 중 · 다른 화면으로 이동해도 계속 처리됩니다 `;
                const stop = document.createElement('button');
                stop.className = 'menu_button';
                stop.textContent = '중지';
                stop.onclick = () => request(`/api/generation-jobs/${job.id}/cancel`, { method: 'POST' }).then(recoverGenerationJobs);
                row.append(stop); status.append(row);
            }
            status.hidden = !active.length;
        }
        for (const job of relevant) {
            if (!terminal.has(job.status) || observed.has(job.id) || waiting.has(job.id)) continue;
            if (job.status === 'completed') {
                if (is_send_press) continue;
                if (!chat.some(message => message.extra?.generation_job === job.id)) await reloadCurrentChat();
                await applyGenerationJobResult(job, job.operation === 'append' ? 'normal' : job.operation);
            } else if (job.status !== 'cancelled') {
                toastr.error(job.error || '생성 작업이 완료되지 않았습니다.', '백그라운드 생성');
            }
            observed.add(job.id);
        }
    } catch (error) { console.debug('Background generation recovery deferred:', error); }
    finally { recovering = false; }
}
export function initializeGenerationJobs() {
    eventSource.on(event_types.APP_READY, recoverGenerationJobs);
    eventSource.on(event_types.CHAT_CHANGED, recoverGenerationJobs);
    document.addEventListener('visibilitychange', recoverGenerationJobs);
    window.addEventListener('online', recoverGenerationJobs);
    setInterval(recoverGenerationJobs, 3000);
}
