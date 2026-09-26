import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cookieSession from 'cookie-session';
import { csrfSync } from 'csrf-sync';
import { sessionCookieName } from '../src/session-cookie.js';

test('session identities are stable per data root and disclose no path', () => {
    const name = sessionCookieName('/synthetic/runtime', 'test-host');
    assert.equal(name, sessionCookieName('/synthetic/./runtime', 'test-host'));
    assert.notEqual(name, sessionCookieName('/synthetic/sandbox', 'test-host'));
    assert.notEqual(name, sessionCookieName('/synthetic/runtime', 'other-host'));
    assert.match(name, /^session-[0-9a-f]{16}$/);
    assert.throws(() => sessionCookieName(undefined));
});

async function server(name, secret) {
    const app = express();
    app.use(cookieSession({ name, secret, httpOnly: true, sameSite: 'lax' }));
    const csrf = csrfSync();
    app.get('/csrf-token', (req, res) => res.json({ token: csrf.generateToken(req) }));
    app.use(csrf.csrfSynchronisedProtection);
    app.post('/save', (req, res) => res.sendStatus(204));
    app.use((err, req, res, next) => res.sendStatus(err.statusCode || 500));
    const listener = app.listen(0, '127.0.0.1');
    await new Promise(resolve => listener.once('listening', resolve));
    return { listener, url: `http://127.0.0.1:${listener.address().port}` };
}

async function alternating(nameA, nameB) {
    const a = await server(nameA, 'synthetic-secret-A');
    const b = await server(nameB, 'synthetic-secret-B');
    const jar = new Map();
    async function request(instance, route, options = {}) {
        const response = await fetch(instance.url + route, {
            ...options, headers: { cookie: [...jar].map(([k,v]) => `${k}=${v}`).join('; '), ...options.headers },
        });
        for (const cookie of response.headers.getSetCookie()) {
            const pair = cookie.split(';')[0]; const index = pair.indexOf('=');
            jar.set(pair.slice(0, index), pair.slice(index + 1));
        }
        return response;
    }
    try {
        const tokenA = (await (await request(a, '/csrf-token')).json()).token;
        const tokenB = (await (await request(b, '/csrf-token')).json()).token;
        const save = (instance, token) => request(instance, '/save', { method: 'POST', headers: { 'x-csrf-token': token } });
        const statusA = (await save(a, tokenA)).status;
        const statusB = (await save(b, tokenB)).status;
        const invalid = (await save(a, 'invalid-token')).status;
        return { statusA, statusB, invalid };
    } finally {
        await Promise.all([a, b].map(s => new Promise(resolve => s.listener.close(resolve))));
    }
}

test('legacy same-host cookie collides across ports; independent sessions preserve both CSRF tokens', async () => {
    const legacy = await alternating('session-shared-host', 'session-shared-host');
    assert.equal(legacy.statusA, 403);
    const fixed = await alternating(sessionCookieName('/synthetic/runtime'), sessionCookieName('/synthetic/sandbox'));
    assert.deepEqual(fixed, { statusA: 204, statusB: 204, invalid: 403 });
});
