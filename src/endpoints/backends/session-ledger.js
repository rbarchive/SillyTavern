import { createHash } from 'node:crypto';
import { decodeDialoguePrefix, rootKeys, validateSummary, SESSION_RESPONSE_SCHEMA } from './inline-session-summary.js';

const MAX_FIELDS = 64;
const MAX_CHANGES = 16;
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const exact = (o, keys) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).length === keys.length && keys.every(k => own(o, k));
export function ledgerRevision(state) {
    return createHash('sha256').update(JSON.stringify({ anchor: state.anchor, fields: Object.fromEntries(Object.entries(state.fields).sort(([a], [b]) => a.localeCompare(b))) })).digest('hex');
}
export function validateLedger(state) {
    if (!exact(state, ['version', 'anchor', 'fields']) || state.version !== 2 || typeof state.anchor !== 'string' || !state.anchor || !state.fields || typeof state.fields !== 'object' || Array.isArray(state.fields)) throw new Error('Invalid ledger');
    const fields = Object.entries(state.fields);
    if (fields.length > MAX_FIELDS || fields.some(([id, value]) => !/^[a-z][a-z0-9_.-]{0,79}$/.test(id) || typeof value !== 'string' || value.length > 500)) throw new Error('Invalid ledger fields');
    return state;
}
export function validatePatch(patch) {
    if (!exact(patch, ['version', 'base_revision', 'changes']) || patch.version !== 2 || typeof patch.base_revision !== 'string' || !Array.isArray(patch.changes) || patch.changes.length > MAX_CHANGES) throw new Error('Invalid patch');
    if (patch.changes.some(c => !exact(c, ['id', 'value', 'source', 'quote', 'kind']) || [c.id, c.value, c.source, c.quote].some(v => typeof v !== 'string') || c.value.length > 500 || !c.quote || c.quote.length > 500 || !['request', 'claim', 'completed'].includes(c.kind))) throw new Error('Invalid patch changes');
    if (new Set(patch.changes.map(c => c.id)).size !== patch.changes.length) throw new Error('Duplicate patch target');
    return patch;
}
export function applyLedgerPatch(state, patch, sources) {
    validateLedger(state); validatePatch(patch);
    const revision = ledgerRevision(state);
    // A retry of the same operation is a no-op only if its base was accepted.
    if (patch.base_revision !== revision) throw new Error('Stale ledger revision');
    const next = structuredClone(state);
    const finalFields = { ...state.fields, ...Object.fromEntries(patch.changes.map(c => [c.id, c.value])) };
    for (const c of patch.changes) {
        if (!own(next.fields, c.id)) throw new Error('Unknown ledger ID: ' + c.id);
        const source = sources[c.source];
        if (!source || typeof source.text !== 'string' || !source.text.includes(c.quote)) throw new Error('Missing evidence: ' + c.source);
        const taskDetail = /^task\.([a-z0-9_-]+)\.(agent|recipient|payload|participants|when|place|clock)$/.exec(c.id);
        const plannedDetail = c.kind === 'request' && taskDetail && ['planned', 'requested'].includes(finalFields[`task.${taskDetail[1]}.status`]);
        if (c.kind !== 'completed' && next.fields[c.id] !== c.value && !plannedDetail && !(c.kind === 'request' && /^task\..*\.status$/.test(c.id) && ['planned', 'requested'].includes(c.value)) && !(c.kind === 'claim' && /^knowledge\..*\.verification$/.test(c.id) && c.value === 'unconfirmed')) throw new Error('A request or claim cannot replace confirmed state');
        if (/^task\..*\.status$/.test(c.id) && next.fields[c.id] === 'completed' && c.value !== 'completed') {
            if (source.role !== 'user' || !/재개|다시 시작|새로운 과제/.test(c.quote)) throw new Error('Completed task cannot reopen without an explicit user event');
        }
        next.fields[c.id] = c.value;
    }
    validateLedger(next);
    return next;
}
// Receipt-based deduplication is scoped by chat/anchor; it does not bless a stale patch.
export function applyLedgerReceipt(state, patch, sources, applied) {
    const key = createHash('sha256').update(JSON.stringify(patch)).digest('hex');
    if (applied?.key === key && applied.anchor === state.anchor && applied.resultRevision === ledgerRevision(state)) return { state: structuredClone(state), receipt: applied, duplicate: true };
    const next = applyLedgerPatch(state, patch, sources);
    return { state: next, receipt: { key, anchor: state.anchor, resultRevision: ledgerRevision(next) }, duplicate: false };
}
export const PATCH_RESPONSE_SCHEMA = {
    type: 'object', required: ['dialogue', 'patch'], additionalProperties: false,
    properties: {
        dialogue: { type: 'string', maxLength: 12000 },
        patch: { type: 'object', required: ['version', 'base_revision', 'changes'], additionalProperties: false, properties: {
            version: { type: 'integer', const: 2 }, base_revision: { type: 'string' },
            changes: { type: 'array', maxItems: MAX_CHANGES, items: { type: 'object', required: ['id', 'value', 'source', 'quote', 'kind'], additionalProperties: false, properties: { id: { type: 'string' }, value: { type: 'string', maxLength: 500 }, source: { type: 'string' }, quote: { type: 'string', maxLength: 500 }, kind: { type: 'string', enum: ['request', 'claim', 'completed'] } } } },
        } },
    },
};
// Some models copy the outer format into the dialogue string itself. Hold
// incomplete metadata keys before displaying them; reject the final payload.
function cleanExperimentalDialogue(text, pending) {
    const metadata = text.search(/"(?:patch|summary)"\s*:\s*\{/);
    if (metadata >= 0) return { text: text.slice(0, metadata).replace(/[,\s{]+$/, ''), embedded: true };
    if (pending) {
        const prefixes = ['"patch":{', '"summary":{'];
        for (let i = Math.max(0, text.length - 64); i < text.length; i++) {
            if (text[i] !== '"') continue;
            const suffix = text.slice(i).replace(/\s/g, '');
            if (prefixes.some(prefix => prefix.startsWith(suffix))) return { text: text.slice(0, i), embedded: false };
        }
    }
    return { text, embedded: false };
}
export function splitExperimentalResponse(content, { final = false, mode = 'delta' } = {}) {
    const prefix = decodeDialoguePrefix(content);
    const cleaned = cleanExperimentalDialogue(prefix.dialogue ?? '', !final && prefix.pending);
    const text = cleaned.text.trimEnd();
    if (!final || prefix.pending) return { text, dialogueComplete: prefix.dialogue !== undefined && !prefix.pending, status: final ? 'failed' : 'pending' };
    try {
        if (cleaned.embedded) throw new Error('Metadata embedded in dialogue');
        const value = JSON.parse(content), key = mode === 'delta' ? 'patch' : 'summary';
        if (!exact(value, ['dialogue', key]) || rootKeys(content).duplicate || typeof value.dialogue !== 'string' || !value.dialogue || value.dialogue.length > 12000 || value.dialogue !== prefix.dialogue) throw new Error('Invalid experimental response');
        if (mode === 'delta') validatePatch(value.patch);
        else validateEvidenceSummary(value.summary);
        return { text, dialogueComplete: true, status: 'complete', summary: value[key] };
    } catch (error) { return { text, dialogueComplete: Boolean(text), status: 'failed', error: error.message }; }
}
export function buildLedgerContext(state) {
    validateLedger(state);
    return '[현재 세션 상태 — 초기 설정보다 최신]\n' + Object.entries(state.fields).map(([id, value]) => `${id}=${value}`).join('\n');
}
export function buildPatchInstruction(state) {
    return `한국어 RP 대사를 dialogue에 먼저 250~400자로 쓰고 patch에 변경분만 출력한다. 최신 user 질문에 직접 답하고 이전 대사 전체를 다시 쓰거나 사용자의 다음 행동을 대신 결정하지 않는다. NPC는 직접 아는 정보만 말한다. 과거 통지·목격·전달을 답변 근거로 지어내지 않는다. 완료된 동일 과제를 재수행 과제로 만들지 않는다.
기존 상태의 바뀌지 않은 항목은 출력하지 않는다. id는 제공된 현재 상태의 ID만 사용한다. 사용자 선언과 최근 실제 사건이 초기 상태보다 최신이다. 부탁·계획은 kind=request, task의 status=planned/requested와 주체·대상·내용·시점·장소로 기록하되 object/scene의 완료 상태로 승격하지 않는다. 실제 완료된 사건은 kind=completed로 기록한다. 완료 과제는 사용자가 명시적으로 재개하지 않으면 다시 미해결로 만들지 않는다. 소문은 kind=claim 및 verification=unconfirmed로 유지한다. 정보의 내용·인지자·비인지자를 구분하고 실제 전달 사건 없이 지식 범위를 확대하지 않는다.
각 변경의 source는 실제 존재하는 단일 근거 ID 하나다. 여러 ID를 쉼표로 합치지 않는다. 사용자 선언을 인용할 때는 그 사용자 원문의 rN을 사용한다. 시작자료의 인용은 w, 이번 dialogue에서 실제 발생한 NPC 발언·행동을 근거로 할 때만 d를 사용한다. 사용자 원문의 인용을 d로 지정하지 않는다.
quote는 지정한 source의 원문에 실제 있는 짧고 연속된 구절 그대로다. 여러 문장을 이어 붙이거나 내용을 다시 쓰지 않는다. 인용은 해당 id와 value를 의미상 뒷받침해야 한다. 비밀 발언의 인용으로 소문 인지자를 변경하는 등 무관한 근거를 사용하지 않는다. 값이 여러 사실을 조합해도 단일 인용이 뒷받침하지 못하면 변경 범위를 줄이거나 보류한다. 이번 dialogue에 없는 사용자 인용을 만들기 위해 대사를 반복하지 않는다.
base_revision은 ${ledgerRevision(state)} 이다. 오직 {"dialogue":"대사","patch":{"version":2,"base_revision":"${ledgerRevision(state)}","changes":[{"id":"변경 항목 ID","value":"새 값","source":"단일 근거 ID","quote":"해당 원문의 연속 인용","kind":"completed"}]}} 형식으로 출력한다. 변화가 없으면 changes=[]로 쓴다.`;
}
/** Keep history intact; only omit additional copies of the same source IDs. */
export function additionalEvidenceRows(rows, historyRows) {
    const present = new Set(historyRows.map(row => row.id));
    return rows.filter(row => !present.has(row.id)).map(row => structuredClone(row));
}
export function chooseImportantEvidence(rows, { coveredCount = 0, unresolvedIds = [], historyIds = [], maxRows = 12, maxChars = 4000 } = {}) {
    if (!Number.isInteger(coveredCount) || coveredCount < 0 || coveredCount > rows.length) throw new Error('Invalid evidence coverage');
    const unresolved = new Set(unresolvedIds), history = new Set(historyIds);
    if (unresolvedIds.some(id => !rows.some(row => row.id === id))) throw new Error('Unknown unresolved evidence');
    const required = rows.filter((row, index) => index >= coveredCount || unresolved.has(row.id));
    const needed = required.filter(row => !history.has(row.id));
    const overflow = required.length > maxRows || required.reduce((n, row) => n + row.text.length, 0) > maxChars;
    // Never silently discard unprocessed evidence or reinject the whole history.
    return { overflow, usable: !overflow, rows: structuredClone(needed), ...(overflow ? { reason: 'Unprocessed or unresolved evidence exceeds input budget; checkpoint required' } : {}) };
}
export function renderEvidence(rows) {
    return '[원문 근거 — 요청·주장과 실제 완료를 구별]\n' + rows.map(r => `${r.id} (${r.role}): ${r.text}`).join('\n');
}

/** Build a checkpointed experimental turn without reintroducing processed logs.
 * Provenance stays in the returned CPU source dictionary, not the model prompt.
 */
export function buildLedgerMessages({ world, state, rows, coveredCount = 0, unresolvedIds = [], instructions = '', evidenceLimits = {} }) {
    validateLedger(state);
    if (!rows.length || rows.at(-1).role !== 'user' || new Set(rows.map(row => row.id)).size !== rows.length || rows.some(row => !['user', 'assistant'].includes(row.role) || typeof row.text !== 'string')) throw new Error('Invalid session dialogue');
    const history = rows.slice(coveredCount);
    if (history[0]?.role !== 'user') throw new Error('Checkpoint splits a dialogue turn');
    if (unresolvedIds.some(id => rows.findIndex(row => row.id === id) < coveredCount)) throw new Error('Processed evidence belongs in the checkpoint, not raw overlap');
    const evidence = chooseImportantEvidence(rows, { ...evidenceLimits, coveredCount, unresolvedIds, historyIds: history.map(row => row.id) });
    if (!evidence.usable) throw new Error(evidence.reason);
    return {
        messages: [
            { role: 'system', content: world },
            { role: 'system', content: buildLedgerContext(state) + `\n범위: 대화 메시지 ${coveredCount}개 반영 완료. 아래 원문은 이 범위 이후의 이야기만 포함한다.` },
            { role: 'system', content: instructions + '\n[원문 ID — 합성 메시지 없이 이어지는 history와 순서대로 대응] ' + history.map(row => row.id + '(' + row.role + ')').join(',') + '; 이번 생성 대사는 d.\n' + renderEvidence(evidence.rows) },
            ...history.map(row => ({ role: row.role, content: row.text })),
        ],
        sources: Object.fromEntries(rows.map(row => [row.id, { role: row.role, text: row.text }])),
        historyIds: history.map(row => row.id), extraIds: evidence.rows.map(row => row.id),
    };
}

export function ledgerAsSummary(state) {
    validateLedger(state);
    const byPrefix = prefix => Object.entries(state.fields).filter(([id, value]) => id.startsWith(prefix) && !(prefix === 'task.' && value === '미확인')).map(([id, value]) => `${id}=${value}`);
    const facts = byPrefix('object.');
    const allTasks = byPrefix('task.');
    const completedIds = new Set(Object.keys(state.fields).filter(id => /^task\..*\.status$/.test(id) && state.fields[id] === 'completed').map(id => id.split('.')[1]));
    const tasks = allTasks.filter(row => !completedIds.has(row.split('.')[1]));
    facts.push(...allTasks.filter(row => completedIds.has(row.split('.')[1])));
    const knowledge = byPrefix('knowledge.');
    const summary = { version: 1, scene: byPrefix('scene.').join('; '), facts, open_threads: tasks, knowledge };
    // Use one stable row per entity, never silently truncate a long ledger.
    for (const key of ['facts', 'open_threads', 'knowledge']) {
        const groups = new Map();
        for (const row of summary[key]) {
            const group = row.split('.')[1];
            groups.set(group, [...(groups.get(group) || []), row]);
        }
        summary[key] = [...groups.values()].map(rows => rows.join('; '));
    }
    return validateSummary(summary, JSON.stringify(summary));
}

const EVIDENCE_ITEM = { type:'object', required:['statement','source','quote','kind'], additionalProperties:false, properties:{ statement:{type:'string',maxLength:500},source:{type:'string'},quote:{type:'string',maxLength:500},kind:{type:'string',enum:['request','claim','completed']} } };
export const EVIDENCE_RESPONSE_SCHEMA = structuredClone(SESSION_RESPONSE_SCHEMA);
EVIDENCE_RESPONSE_SCHEMA.properties.summary.required.push('evidence');
EVIDENCE_RESPONSE_SCHEMA.properties.summary.properties.version.const = 3;
EVIDENCE_RESPONSE_SCHEMA.properties.summary.properties.evidence = {type:'array',maxItems:8,items:EVIDENCE_ITEM};
export function validateEvidenceSummary(value) {
    if (!exact(value,['version','scene','facts','open_threads','knowledge','evidence']) || value.version!==3 || !Array.isArray(value.evidence) || value.evidence.length>8) throw new Error('Invalid evidence summary');
    for (const e of value.evidence) {
        if (!exact(e,['statement','source','quote','kind']) || [e.statement,e.source,e.quote].some(v=>typeof v!=='string'||!v||v.length>500) || !['request','claim','completed'].includes(e.kind)) throw new Error('Invalid evidence item');
    }
    const {evidence,...summary}=value;summary.version=1;validateSummary(summary,JSON.stringify(summary));return {summary,evidence};
}
export function checkEvidenceSummary(value,sources) {
    const result=validateEvidenceSummary(value);
    for(const e of result.evidence) {const s=sources[e.source];if(!s||!s.text.includes(e.quote))throw new Error('Evidence quote does not exist');}
    return result;
}
export function buildEvidenceInstruction() {
    return '요약 version은3이며 기존 scene/facts/open_threads/knowledge에 evidence 목록을 추가한다. 이번 중요한 변화마다 statement(기록한 변화),source(입력 원문 근거ID 또는 이번 dialogue의 d),quote(정확한 원문 인용),kind(request/claim/completed)를 짧게 기록한다. 요청/계획과 소문을 완료·확정 사실로 적지 않는다. 원문에 없는 과거 통지·목격·전달을 답변 근거로 만들지 않는다. 완료한 같은 과제는 닫고 재대조 과제로 되살리지 않는다. 비밀 내용과 주인공·엘린만 안다는 범위를 유지한다. evidence는 최대8개이며 없는 근거는 만들지 않는다.';
}
