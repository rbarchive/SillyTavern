export const SUMMARY_OPEN = '\n<rp-session-summary>\n';
export const SUMMARY_CLOSE = '\n</rp-session-summary>';

const REQUIRED_KEYS = ['version', 'scene', 'facts', 'open_threads', 'knowledge'];
const MAX_ITEMS = 12;
const MAX_ITEM_LENGTH = 500;
const MAX_SCENE_LENGTH = 1000;
const MAX_JSON_LENGTH = 8000;

const SUMMARY_SCHEMA = {
    type: 'object',
    required: REQUIRED_KEYS,
    additionalProperties: false,
    properties: {
        version: { type: 'integer', const: 1 },
        scene: { type: 'string', minLength: 1, maxLength: MAX_SCENE_LENGTH },
        facts: { type: 'array', maxItems: MAX_ITEMS, items: { type: 'string', maxLength: MAX_ITEM_LENGTH } },
        open_threads: { type: 'array', maxItems: MAX_ITEMS, items: { type: 'string', maxLength: MAX_ITEM_LENGTH } },
        knowledge: { type: 'array', maxItems: MAX_ITEMS, items: { type: 'string', maxLength: MAX_ITEM_LENGTH } },
    },
};

export const SESSION_RESPONSE_SCHEMA = {
    type: 'object',
    required: ['dialogue', 'summary'],
    additionalProperties: false,
    properties: {
        dialogue: { type: 'string', maxLength: 12000 },
        summary: SUMMARY_SCHEMA,
    },
};

function openingPrefixLength(content) {
    const limit = Math.min(content.length, SUMMARY_OPEN.length - 1);
    for (let length = limit; length > 0; length--) {
        if (content.endsWith(SUMMARY_OPEN.slice(0, length))) return length;
    }
    return 0;
}

export function validateSummary(value, raw) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('summary must be an object');
    const keys = Object.keys(value);
    if (keys.length !== REQUIRED_KEYS.length || REQUIRED_KEYS.some(key => !Object.prototype.hasOwnProperty.call(value, key))) {
        throw new Error('summary keys are invalid');
    }
    if (value.version !== 1) throw new Error('summary version must be 1');
    if (typeof value.scene !== 'string' || value.scene.length === 0 || value.scene.length > MAX_SCENE_LENGTH) throw new Error('summary scene is invalid');
    // Reject schema escaping: a whole JSON summary disguised as the scene string.
    if ((/^\s*[\[{]/u.test(value.scene) && /"(?:version|scene|facts|open_threads|knowledge)"\s*:/u.test(value.scene)) || /<\/?(?:think|thinking)>/iu.test(value.scene)) throw new Error('summary scene contains structured output');
    for (const key of ['facts', 'open_threads', 'knowledge']) {
        if (!Array.isArray(value[key]) || value[key].length > MAX_ITEMS || value[key].some(item => typeof item !== 'string' || item.length > MAX_ITEM_LENGTH || !/[\p{L}\p{N}]/u.test(item))) {
            throw new Error(`summary ${key} is invalid`);
        }
    }
    if (raw.length > MAX_JSON_LENGTH) throw new Error('summary JSON is too long');
    return value;
}

function parseSummary(raw) {
    let value;
    try {
        value = JSON.parse(raw);
    } catch {
        throw new Error('summary JSON is malformed');
    }
    return validateSummary(value, raw);
}

/** Split visible dialogue from the hidden, final session summary in accumulated content. */
export function splitInlineSummary(content, { final = false } = {}) {
    if (typeof content !== 'string') throw new TypeError('content must be a string');
    const start = content.indexOf(SUMMARY_OPEN);
    if (start < 0) {
        const partial = openingPrefixLength(content);
        if (partial) {
            return {
                text: content.slice(0, -partial), started: true, summary: null,
                status: final ? 'failed' : 'pending',
                ...(final ? { error: 'truncated summary opening marker' } : {}),
            };
        }
        return { text: content, started: false, summary: null, status: 'missing' };
    }

    const dialogue = content.slice(0, start).trimEnd();
    const bodyStart = start + SUMMARY_OPEN.length;
    const close = content.indexOf(SUMMARY_CLOSE, bodyStart);
    if (close < 0) {
        return {
            text: dialogue, started: true, summary: null,
            status: final ? 'failed' : 'pending',
            ...(final ? { error: 'truncated summary' } : {}),
        };
    }

    const raw = content.slice(bodyStart, close);
    const extra = content.slice(close + SUMMARY_CLOSE.length);
    if (extra.trim().length) return { text: dialogue, started: true, summary: null, status: 'failed', error: 'extra content after summary' };
    try {
        return { text: dialogue, started: true, summary: parseSummary(raw), status: 'complete' };
    } catch (error) {
        return { text: dialogue, started: true, summary: null, status: 'failed', error: error.message };
    }
}

export function decodeDialoguePrefix(content) {
    let position = 0;
    while (/\s/u.test(content[position] ?? '')) position++;
    if (content[position] !== '{') return { found: false };
    position++;
    while (/\s/u.test(content[position] ?? '')) position++;
    if (content[position] !== '"') return { found: false };
    const nameEnd = content.indexOf('"', position + 1);
    if (nameEnd < 0) return { found: false, pending: true };
    if (content.slice(position + 1, nameEnd) !== 'dialogue') return { found: false };
    position = nameEnd + 1;
    while (/\s/u.test(content[position] ?? '')) position++;
    if (content[position] !== ':') return { found: false, pending: true };
    position++;
    while (/\s/u.test(content[position] ?? '')) position++;
    if (content[position] !== '"') return { found: false, pending: true };
    const openingQuote = position++;
    let closing = -1;
    for (; position < content.length; position++) {
        if (content[position] !== '"') continue;
        let slashes = 0;
        for (let cursor = position - 1; cursor >= openingQuote; cursor--, slashes++) if (content[cursor] !== '\\') break;
        if (slashes % 2) continue;
        closing = position;
        break;
    }
    const raw = content.slice(openingQuote + 1, closing < 0 ? content.length : closing);
    let dialogue = '';
    let pending = false;
    for (let index = 0; index < raw.length; index++) {
        const char = raw[index];
        if (char !== '\\') { dialogue += char; continue; }
        if (index + 1 >= raw.length) { pending = true; break; }
        const escape = raw[++index];
        const simple = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        if (simple[escape] !== undefined) { dialogue += simple[escape]; continue; }
        if (escape !== 'u' || index + 4 >= raw.length || !/^[0-9a-f]{4}$/iu.test(raw.slice(index + 1, index + 5))) { pending = true; break; }
        dialogue += String.fromCharCode(Number.parseInt(raw.slice(index + 1, index + 5), 16));
        index += 4;
    }
    if (/^[\uD800-\uDBFF]$/u.test(dialogue.slice(-1))) { dialogue = dialogue.slice(0, -1); pending = true; }
    if (closing < 0 || pending) return { found: true, pending: true, dialogue };
    try {
        const complete = JSON.parse(content.slice(openingQuote, closing + 1));
        if (typeof complete !== 'string') return { found: true, pending: false, dialogue };
        return { found: true, pending: false, dialogue: complete, end: closing + 1 };
    } catch {
        return { found: true, pending: true, dialogue };
    }
}

export function rootKeys(content) {
    let index = 0;
    const keys = [];
    const whitespace = () => { while (/\s/u.test(content[index] ?? '')) index++; };
    whitespace();
    if (content[index++] !== '{') return { keys, duplicate: false };
    while (index < content.length) {
        whitespace();
        if (content[index] === '}') return { keys, duplicate: new Set(keys).size !== keys.length };
        if (content[index] !== '"') return { keys, duplicate: false };
        const start = index++;
        let escaped = false;
        for (; index < content.length; index++) {
            if (escaped) { escaped = false; continue; }
            if (content[index] === '\\') { escaped = true; continue; }
            if (content[index] === '"') break;
        }
        if (index >= content.length) return { keys, duplicate: false };
        try { keys.push(JSON.parse(content.slice(start, ++index))); } catch { return { keys, duplicate: false }; }
        whitespace();
        if (content[index++] !== ':') return { keys, duplicate: false };
        whitespace();
        let depth = 0; let string = false; escaped = false;
        for (; index < content.length; index++) {
            const char = content[index];
            if (string) {
                if (escaped) escaped = false;
                else if (char === '\\') escaped = true;
                else if (char === '"') string = false;
                continue;
            }
            if (char === '"') { string = true; continue; }
            if (char === '{' || char === '[') depth++;
            else if (char === '}' || char === ']') { if (!depth) break; depth--; }
            else if (char === ',' && !depth) break;
        }
        if (index < content.length && content[index] === ',') { index++; continue; }
        if (index < content.length && content[index] === '}') return { keys, duplicate: new Set(keys).size !== keys.length };
        return { keys, duplicate: false };
    }
    return { keys, duplicate: false };
}

/** Incrementally expose only the dialogue field from a strict JSON response. */
export function splitStructuredSessionResponse(content, { final = false } = {}) {
    if (typeof content !== 'string') throw new TypeError('content must be a string');
    const prefix = decodeDialoguePrefix(content);
    if (prefix.dialogue !== undefined) {
        const text = prefix.dialogue.trimEnd();
        if (prefix.pending || !final) {
            return { text, dialogueComplete: !prefix.pending, summary: null, status: 'pending' };
        }
        try {
            const value = JSON.parse(content);
            const keys = Object.keys(value); const parsedKeys = rootKeys(content);
            if (!value || typeof value !== 'object' || Array.isArray(value) || parsedKeys.duplicate || keys.length !== 2 || !keys.includes('dialogue') || !keys.includes('summary')) throw new Error('response keys are invalid');
            if (typeof value.dialogue !== 'string' || !value.dialogue || value.dialogue.length > 12000 || value.dialogue !== prefix.dialogue) throw new Error('dialogue is invalid');
            validateSummary(value.summary, JSON.stringify(value.summary));
            return { text, dialogueComplete: true, summary: value.summary, status: 'complete' };
        } catch (error) {
            return { text, dialogueComplete: true, summary: null, status: 'failed', error: error.message };
        }
    }
    if (!final) return { text: '', dialogueComplete: false, summary: null, status: 'pending' };
    try {
        const value = JSON.parse(content);
        const parsedKeys = rootKeys(content);
        if (!value || typeof value !== 'object' || Array.isArray(value) || parsedKeys.duplicate || Object.keys(value).length !== 2 || !Object.prototype.hasOwnProperty.call(value, 'dialogue') || !Object.prototype.hasOwnProperty.call(value, 'summary')) throw new Error('response keys are invalid');
        if (typeof value.dialogue !== 'string' || !value.dialogue || value.dialogue.length > 12000) throw new Error('dialogue is invalid');
        validateSummary(value.summary, JSON.stringify(value.summary));
        return { text: value.dialogue.trimEnd(), dialogueComplete: true, summary: value.summary, status: 'complete' };
    } catch (error) {
        return { text: '', dialogueComplete: false, summary: null, status: 'failed', error: error.message };
    }
}

export function buildSessionRecallInstruction() {
    return '고정 세계관과 캐릭터 설정을 기준으로 답하세요. 일시 감정이나 행동을 고정 성격으로 바꾸지 마세요. 기록이 없거나 불명확한 부분은 추측으로 채우거나 반대 사실로 단정하지 마세요.';
}

/** A compact general policy, independent of individual evaluation failures. */
export function buildSessionMemoryInstruction() {
    return [
        buildSessionRecallInstruction(),
        '이전 요약과 그 이후의 대화를 바탕으로 다음 대화에 필요한 현재 상황과 중요한 사건의 행위자·조건·결과를 간결하게 기억하세요. 오래된 비본질적 묘사와 표현은 줄여도 됩니다. 요약은 이전 기억에 이번 대화에서 실제로 달라진 내용을 반영하고 중복을 줄이세요.',
        'scene은 현재 장면, facts는 지속 사실과 중요한 사건, open_threads는 남아 있는 미완료 일, knowledge는 아는 인물과 모르는 인물을 포함한 인물별 정보입니다.',
    ].join(' ');
}

export function buildInlineSummaryInstruction() {
    return `${buildSessionMemoryInstruction()} 먼저 마지막 user 입력에 답하는 자연스러운 한국어 RP 대사를 생성하고, 같은 응답 뒤에 누적 요약 JSON을 붙이세요. 주인공의 다음 행동·생각을 대신 정하지 마세요. 요약은 방금 대사까지 반영합니다. scene은 200자 이내 평문, 각 목록은 최대 12개, 전체 JSON은 800자 이내를 목표로 하되 핵심을 왜곡해서 줄이지 마세요. 다음 구분자와 필드를 지키고 종료 뒤에는 아무것도 출력하지 마세요: ${SUMMARY_OPEN}{"version":1,"scene":"현재 장면","facts":[],"open_threads":[],"knowledge":[]}${SUMMARY_CLOSE}`;
}

export function buildStructuredSummaryInstruction() {
    return [
        buildSessionMemoryInstruction(),
        '마지막 user 입력에 답하는 한국어 RP 대사와 누적 요약을 하나의 JSON으로 출력하세요. dialogue를 먼저, summary를 두 번째로 작성하세요. 주인공의 다음 행동·생각을 대신 정하지 마세요. dialogue에는 대사와 서술만 넣으세요. summary는 방금 대사까지 반영합니다.',
        'scene은 200자 이내 평문, 각 목록은 최대 12개, 전체 요약은 800자 이내를 목표로 하되 핵심을 왜곡해서 줄이지 마세요. 추가 키와 JSON 밖 내용 없이 종료하세요.',
        '형식: {"dialogue":"대사와 서술","summary":{"version":1,"scene":"현재 장면","facts":[],"open_threads":[],"knowledge":[]}}',
    ].join(' ');
}

export function buildSessionSummaryContext(summary, { coveredTurns, coveredMessages } = {}) {
    const value = validateSummary(summary, JSON.stringify(summary));
    const lines = [
        '[이전 세션 요약]',
        buildSessionRecallInstruction(),
        ...(Number.isInteger(coveredTurns) && Number.isInteger(coveredMessages) ? [`범위: ${coveredTurns}턴의 응답 완료까지, 대화 메시지 ${coveredMessages}개를 반영한 최종 상태. 이어지는 원문은 모두 이 범위 이후의 이야기이며 요약된 원문은 재첨부하지 않는다.`] : []),
        `현재 장면: ${value.scene}`,
        `현재 상태·지속 사실·최근 사건: ${value.facts.length ? value.facts.join(' | ') : '기록 없음 (사실 부정 아님)'}`,
        `계획·요청·미해결 사항 (실행 완료 아님): ${value.open_threads.length ? value.open_threads.join(' | ') : '기록 없음 (과제 부재 확정 아님)'}`,
        `인물별 지식/믿음 (인지자·전달 여부·확인 상태를 유지): ${value.knowledge.length ? value.knowledge.join(' | ') : '기록 없음 (지식 부재 확정 아님)'}`,
    ];
    return lines.join('\n');
}
