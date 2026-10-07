import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const MAX_TOKENS = 8192;
const UPDATE_REQUEST = '[RP_MEMORY_UPDATE_REQUEST]';
export const DEFAULT_STORAGE_ROOT = null;
const clone = value => structuredClone(value);
const json = value => JSON.stringify(value);
const scopeKey = scope => typeof scope === 'string' ? scope : json(scope ?? '');
const digest = scope => createHash('sha256').update(scopeKey(scope)).digest('hex');
const rows = session => clone(session?.messages || []).map(row => ({ turn: row.turn, role: row.role, content: row.content }));
const anchors = session => clone(session?.anchors || session?.sourceAnchors || []);
const same = (a, b) => json(a) === json(b);
const isPrefix = (prefix, current) => Array.isArray(prefix) && Array.isArray(current) && prefix.length <= current.length && prefix.every((v, i) => same(v, current[i]));
const rowsHash = value => createHash('sha256').update(json(value)).digest('hex');
const completedTurn = session => session?.completedThrough ?? session?.throughTurn ?? session?.messages?.at(-1)?.turn ?? 0;
function statePath(scope, storageRoot) { if (!storageRoot) throw new Error('Latest state requires a user-scoped storage root'); return path.join(path.resolve(storageRoot), 'state-journal', `${digest(scope)}.json`); }
function record(scope, storageRoot) { const file = statePath(scope, storageRoot); return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null; }
function atomic(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); const temp = `${file}.${randomUUID()}.tmp`; try { fs.writeFileSync(temp, JSON.stringify(value)); fs.renameSync(temp, file); } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); } }
function shared(base, fixedContext = '') { const rules = base?.sharedPrefix || base?.actorRules || base?.writerRules || base?.rules || ''; const fixed = fixedContext && !String(rules).includes(fixedContext) ? fixedContext : ''; return [rules, fixed, base?.episodicSystemContext || base?.episodicContext || ''].filter(v => typeof v === 'string' && v.trim()).join('\n\n'); }
function cardFrom(rec) { return rec?.card && typeof rec.card.text === 'string' ? clone(rec.card) : null; }
function consumable(scope, session, storageRoot) { const rec = record(scope, storageRoot); const card = cardFrom(rec); if (!card || !session) return card; const current = anchors(session); if (!isPrefix(card.sourceAnchors, current) || Number(card.asOfTurn) > Number(completedTurn(session))) return null; return rec.sourceRevision === rowsHash(rows(session).filter(row => row.turn <= card.asOfTurn)) ? card : null; }

export function prepareActor(base, { fixedContext = '', card = null } = {}) {
    const params = clone(base?.params || base || {}); const messages = clone(params.messages || []); const prefix = shared(base, fixedContext); const first = messages.findIndex(m => m?.role === 'system');
    if (first >= 0) messages[first] = { ...messages[first], content: prefix }; else if (prefix) messages.unshift({ role: 'system', content: prefix });
    if (card?.text) { const user = [...messages].map((m, i) => ({ m, i })).reverse().find(x => x.m?.role === 'user'); if (user) messages[user.i] = { ...user.m, content: `[이전 턴 종료 상태 — ${card.asOfTurn ?? 0}턴. 아래 새 원문 이전의 상태이며 새 사건을 반영해 갱신한다.]\n${card.text}\n\n${user.m.content || ''}` }; }
    const latestUser = [...messages].reverse().find(m => m?.role === 'user'); if (latestUser) latestUser.content = latestUser.content.replace('[원문]\n', '[이번 턴 새 원문 — 앞선 상태 이후의 사건. 마지막 요청 이후 장면부터 이어간다.]\n');
    params.messages = messages; return params;
}
export function prepareLatestActor(base, { fixedContext = '', session, scope, storageRoot } = {}) { return { ...base, fixedContext, session, scope, storageRoot, params: prepareActor(base, { fixedContext, card: consumable(scope, session, storageRoot) }), actorRules: base?.actorRules || base?.rules || '', writerRules: base?.writerRules || base?.actorRules || base?.rules || '' }; }

function writerParams(actor, reply) {
    const params = clone(actor?.params || actor || {}); const messages = clone(params.messages || []); const close = actor?.closePrefill || '</think>\n\n'; const tail = messages.at(-1); const prefilled = actor?.assistantPrefill === close || tail?.content?.endsWith(close);
    if (tail?.role === 'assistant' && prefilled) tail.content = `${tail.content || ''}${reply?.text || ''}`; else if (reply?.text) messages.push({ role: 'assistant', content: `${close}${reply.text}` });
    messages.push({ role: 'user', content: `${UPDATE_REQUEST}\n마지막 새 원문 한 쌍과 이전 최종 상태만 갱신하세요. 옛 history는 참고용이며 운영 요청 자체를 사건으로 기록하지 마세요.` }); messages.push({ role: 'assistant', content: close });
    return { ...params, messages, max_tokens: MAX_TOKENS, response_format: undefined, schema: undefined };
}
function valid(text, finishReason) { if (typeof text !== 'string' || !text.trim() || finishReason === 'length') return false; const value = text.trim(); if (/^[{[]/u.test(value) || /^```(?:json)?/iu.test(value) || /"(?:scene|facts|open_threads|knowledge)"\s*:/u.test(value)) return false; return /(?:^|\n)\s*(?:[-*•]|\d+[.)]|[가-힣A-Za-z]+\s*:)/u.test(value); }
function result(status, extra = {}) { return { status, ...extra }; }

export async function updateLatestState({ actor, reply, session, readSession, scope, generate, signal, update = () => {}, remainingMs = Infinity, storageRoot } = {}) {
    if (signal?.aborted || remainingMs <= 0) return result('aborted');
    const before = readSession ? clone(await readSession()) : clone(session); const expected = anchors(session || before); if (!same(anchors(before), expected)) return result('conflict', { error: 'Session anchors changed before writer.' });
    if (actor?.session && !isPrefix(anchors(actor.session), anchors(before))) return result('conflict', { error: 'Actor source changed before writer.' });
    // An obsolete card is not consumed by prepareLatestActor. Rebuild it from
    // the current archive rather than blocking every future update forever.
    const previous = record(scope, storageRoot);
    const previousWasCurrent = !previous?.sourceAnchors || Boolean(consumable(scope, before, storageRoot));
    const controller = new AbortController(); const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true }); const timer = Number.isFinite(remainingMs) ? setTimeout(abort, Math.max(0, remainingMs)) : null; let stats; let generated;
    try { update({ phase: 'latest-state' }); generated = await generate(writerParams(actor, reply), controller.signal, progress => { stats = { ...stats, ...progress?.modelStats }; update(progress); }); if (controller.signal.aborted) return result('aborted'); } catch (error) { return result(error?.name === 'AbortError' ? 'aborted' : 'failed', { error: error.message }); } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    const text = typeof generated === 'string' ? generated : generated?.text; const finish = generated?.finishReason || generated?.finish_reason || generated?.usage?.finishReason || stats?.finishReason; if (!valid(text, finish)) return result('failed', { error: 'Latest state writer output was invalid.' });
    const current = readSession ? clone(await readSession()) : before; if (!same(expected, anchors(current))) return result('conflict', { error: 'Session changed while writing.' }); const latest = record(scope, storageRoot); if (latest?.revision !== previous?.revision || (previousWasCurrent && latest?.sourceAnchors && !isPrefix(latest.sourceAnchors, anchors(current)))) return result('conflict', { error: 'Latest state compare-and-swap failed.' });
    const sourceRows = rows(current); const sourceAnchors = anchors(current); const revision = (latest?.revision || 0) + 1; const card = { text: text.trim(), asOfTurn: completedTurn(current), sourceRevision: rowsHash(sourceRows), sourceAnchors };
    atomic(statePath(scope, storageRoot), { revision, scope: scopeKey(scope), card, sourceRevision: card.sourceRevision, sourceAnchors, anchors: sourceAnchors, start: current?.start ?? session?.start ?? 0, actorPrefixRevision: digest(actor.params.messages.filter(row => row.role === 'system')), savedAt: new Date().toISOString() }); update({ phase: 'latest-state-saved', latestState: card }); return result('complete', { card, revision });
}
export function readLatestState({ scope, session, storageRoot } = {}) { return consumable(scope, session, storageRoot); }
export const latestStateJournalPath = statePath;

export function actorPrefixChanged(actor) { const previous = record(actor.scope, actor.storageRoot); return Boolean(previous?.actorPrefixRevision && previous.actorPrefixRevision !== digest(actor.params.messages.filter(row => row.role === 'system'))); }
