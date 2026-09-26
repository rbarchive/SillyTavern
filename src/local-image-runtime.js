/** Own a separate local ComfyUI process; never adopt or restart an external server. */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export function boostPreference(value) {
    if (value === undefined) return true;
    if (typeof value !== 'boolean') throw new Error('부스트 모드 값은 켜짐 또는 꺼짐이어야 합니다.');
    return value;
}
function localOrigin(value) {
    try {
        const url = new URL(value);
        if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname)
            || url.username || url.password || url.search || url.hash || url.pathname !== '/') return null;
        return `http://127.0.0.1:${url.port || '80'}`;
    } catch { return null; }
}
export function comfyModeArgs(boost) {
    return boostPreference(boost) ? ['--use-pytorch-cross-attention'] : ['--cache-none'];
}
async function portOccupied(port) {
    return new Promise(resolve => {
        const socket = net.connect({ host: '127.0.0.1', port });
        socket.setTimeout(1000);
        const done = value => { socket.destroy(); resolve(value); };
        socket.once('connect', () => done(true));
        socket.once('error', error => done(error.code !== 'ECONNREFUSED'));
        socket.once('timeout', () => done(true));
    });
}

export function createComfyProcess(config) {
    const port = Number(config.port);
    if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === Number(new URL(config.sourceUrl).port || 80)) {
        throw new Error('관리용 ComfyUI 포트는 원본 서버와 다른 포트여야 합니다.');
    }
    for (const name of ['python', 'main', 'modelPaths', 'dataDirectory']) {
        if (typeof config[name] !== 'string' || !path.isAbsolute(config[name])) throw new Error(`localImageRuntime.${name} 경로를 설정하세요.`);
    }
    const url = `http://127.0.0.1:${port}`;
    let child;
    let logError;
    const alive = () => Boolean(child?.pid && child.exitCode === null && child.signalCode === null);
    const json = async route => {
        const response = await fetch(`${url}${route}`, { signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error(`관리용 ComfyUI 응답 오류: ${response.status}`);
        return response.json();
    };
    return {
        url, alive, error: () => logError ? `이미지 서버 로그 기록 오류: ${logError.code || 'write_failed'}` : null,
        async idle() {
            if (!alive()) return;
            const deadline = Date.now() + 15 * 60 * 1000;
            while (alive()) {
                // Only this owned server. A failed client poll must not permit killing inference.
                const queue = await json('/queue');
                if (!queue.queue_running?.length && !queue.queue_pending?.length) return;
                if (Date.now() > deadline) throw new Error('이미지 생성이 끝나지 않아 모드 전환을 보류했습니다.');
                await sleep(250);
            }
        },
        async stop() {
            if (!alive()) { child = undefined; return; }
            const owned = child;
            await new Promise(resolve => {
                const timer = setTimeout(resolve, 10000);
                owned.once('exit', () => { clearTimeout(timer); resolve(); });
                owned.kill('SIGTERM');
            });
            if (alive()) throw new Error('관리용 ComfyUI 종료를 확인하지 못했습니다.');
            child = undefined;
        },
        async start(boost) {
            if (await portOccupied(port)) throw new Error('관리용 ComfyUI 포트가 사용 중입니다. 기존 서버는 변경하지 않았습니다.');
            for (const folder of ['input', 'output', 'user']) fs.mkdirSync(path.join(config.dataDirectory, folder), { recursive: true });
            const args = [config.main, '--listen', '127.0.0.1', '--port', String(port),
                '--extra-model-paths-config', config.modelPaths,
                ...['input', 'output', 'user'].flatMap(folder => [`--${folder}-directory`, path.join(config.dataDirectory, folder)]),
                '--disable-auto-launch', '--disable-api-nodes', '--disable-all-custom-nodes', ...comfyModeArgs(boost)];
            const log = fs.createWriteStream(path.join(config.dataDirectory, 'server.log'), { flags: 'a' });
            let startup = '';
            let failure;
            logError = null;
            // A full/unwritable disk must not escape into ST's uncaughtException handler.
            // After startup, retain running inference and expose the controller error.
            log.on('error', error => { logError = error; failure = error; });
            child = spawn(config.python, args, { cwd: path.dirname(config.main), stdio: ['ignore', 'pipe', 'pipe'], shell: false });
            const owned = child;
            for (const stream of [owned.stdout, owned.stderr]) stream.on('data', data => { log.write(data); startup = (startup + data).slice(-16000); });
            owned.once('error', error => { failure = error; });
            owned.once('close', () => log.end());
            const deadline = Date.now() + 90000;
            try {
                while (true) {
                    if (failure || !alive()) throw new Error('관리용 ComfyUI 시작에 실패했습니다. 서버 로그를 확인해 주세요.');
                    // Require the owned child's successful bind message before querying readiness.
                    if (startup.includes(`To see the GUI go to: ${url}`)) { await json('/system_stats'); return; }
                    if (Date.now() > deadline) throw new Error('관리용 ComfyUI 시작 시간이 초과되었습니다.');
                    await sleep(250);
                }
            } catch (error) { await this.stop(); throw error; }
        },
    };
}

export function createLocalImageRuntime(config = {}, suppliedProcess) {
    const enabled = config.enabled === true;
    const source = localOrigin(config.sourceUrl);
    if (enabled && !source) throw new Error('localImageRuntime.sourceUrl은 로컬 ComfyUI URL이어야 합니다.');
    const backend = enabled ? (suppliedProcess || createComfyProcess(config)) : null;
    let tail = Promise.resolve();
    let mode = null;
    let pending = 0;
    let active = false;
    let closing = false;
    let error = null;
    const supports = url => enabled && localOrigin(url) === source;
    const state = url => ({ supported: Boolean(supports(url)), ready: Boolean(backend?.alive() && mode !== null),
        applied: backend?.alive() ? mode : null, active, pending, error: error || backend?.error?.() || null,
        reason: !enabled ? '이 서버에는 로컬 이미지 부스트 관리가 설정되지 않았습니다.' : !supports(url) ? '설정된 로컬 ComfyUI 연결에서 사용할 수 있습니다.' : null });
    const enqueue = operation => {
        if (closing) return Promise.reject(new Error('이미지 서버가 종료 중입니다.'));
        pending++;
        const result = tail.then(async () => {
            pending--; active = true; error = null;
            try { return await operation(); }
            catch (failure) { error = failure.message; throw failure; }
            finally { active = false; }
        });
        tail = result.catch(() => {});
        return result;
    };
    const ensure = async wanted => {
        if (backend.alive() && mode === wanted) {
            if (backend.error?.()) throw new Error(backend.error());
            return;
        }
        if (backend.alive()) { await backend.idle(); await backend.stop(); }
        mode = null;
        await backend.start(wanted);
        mode = wanted;
    };
    return {
        supports, status: state,
        apply(url, preference) {
            const wanted = boostPreference(preference);
            if (!supports(url)) return Promise.reject(new Error(state(url).reason));
            return enqueue(async () => { await ensure(wanted); return { ...state(url), active: false }; });
        },
        run(url, preference, signal, operation) {
            const wanted = boostPreference(preference);
            if (!supports(url)) return operation(url, signal);
            return enqueue(async () => {
                signal?.throwIfAborted();
                await ensure(wanted);
                signal?.throwIfAborted();
                // Once accepted, continue polling through browser disconnect/cancellation.
                // The caller can discard the result afterwards, but the lease stays held.
                return operation(backend.url, undefined);
            });
        },
        async close() {
            closing = true;
            await tail;
            if (backend?.alive()) { await backend.idle(); await backend.stop(); }
            mode = null;
        },
    };
}
