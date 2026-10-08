import { createHash } from 'node:crypto';

// This is an export contract, not a redaction blacklist. Never copy caller text.
const statuses = ['queued', 'running', 'cancelling', 'completed', 'failed', 'conflict', 'cancelled', 'interrupted'];
const memoryStatuses = ['planning', 'generating', 'pending', 'complete', 'failed', 'skipped', 'interrupted', 'cancelled', 'not-needed', 'deferred-oversized-turn', 'aborted', 'conflict'];
const phases = ['dialogue', 'latest-state', 'episodic'];
const finishes = ['stop', 'length', 'tool_calls', 'content_filter', 'function_call'];
const metricKeys = ['rawBudget', 'invocationCount', 'latestStateMs', 'episodicMs', 'planningMs', 'totalMs', 'pendingTokens', 'protectedTokens', 'targetThroughTurn', 'consolidationTokens', 'backlogRows'];
const statsKeys = ['inputTokens', 'outputTokens', 'reasoningTokens', 'cachedTokens'];
const timingKeys = ['modelPreparation', 'modelRequest', 'firstContent', 'firstReasoning', 'firstToken', 'firstVisible', 'serverFirstVisible', 'lastVisible', 'modelComplete', 'dialogueComplete', 'committed', 'summaryPersisted', 'drawing', 'comfySubmitted', 'imageReceived', 'imageSaved'];
export const diagnosticCodes = Object.freeze(['COMPACT_NOT_OBJECT', 'COMPACT_VERSION_MISSING', 'COMPACT_VERSION_MISMATCH', 'COMPACT_TURN_MISSING', 'COMPACT_TURN_MISMATCH', 'COMPACT_UNKNOWN_FIELDS', 'COMPACT_SOURCE_TABLE_INVALID', 'COMPACT_ROW_INVALID', 'COMPACT_ROW_LENGTH', 'COMPACT_ROW_TYPES', 'COMPACT_SOURCES_NOT_ARRAY', 'COMPACT_SOURCES_EMPTY', 'COMPACT_SOURCES_DUPLICATE', 'COMPACT_SOURCE_NOT_INTEGER', 'COMPACT_SOURCE_OUT_OF_RANGE', 'MEMORY_JSON_INVALID', 'MEMORY_CONTRACT_INVALID', 'MEMORY_OUTPUT_TRUNCATED', 'MEMORY_SOURCE_CHANGED', 'MEMORY_CHECKPOINT_CONFLICT', 'MEMORY_CANCELLED', 'LATEST_STATE_INVALID', 'ERROR_UNCLASSIFIED']);
const legacyCodes = new Map([
    ['Invalid compact delta', 'MEMORY_CONTRACT_INVALID'], ['Invalid compact category', 'MEMORY_CONTRACT_INVALID'], ['Invalid compact removal', 'MEMORY_CONTRACT_INVALID'], ['Invalid compact overview', 'MEMORY_CONTRACT_INVALID'], ['Changed memory requires explicit overview update', 'MEMORY_CONTRACT_INVALID'],
    ['Latest state writer output was invalid.', 'LATEST_STATE_INVALID'], ['Session changed while writing.', 'MEMORY_SOURCE_CHANGED'], ['Latest state compare-and-swap failed.', 'MEMORY_CHECKPOINT_CONFLICT'],
    ['Memory output truncated', 'MEMORY_OUTPUT_TRUNCATED'], ['Consolidated prefix was edited', 'MEMORY_SOURCE_CHANGED'], ['Consolidated source was edited', 'MEMORY_SOURCE_CHANGED'], ['Checkpoint advanced during consolidation', 'MEMORY_CHECKPOINT_CONFLICT'], ['Memory cancelled', 'MEMORY_CANCELLED'],
]);
const numeric = (value, keys) => Object.fromEntries(keys.filter(key => (key === 'fraction' ? Number.isFinite(value?.[key]) && value[key] >= 0 && value[key] <= 1 : Number.isSafeInteger(value?.[key]) && value[key] >= 0)).map(key => [key, value[key]]));
const choice = (value, allowed) => allowed.includes(value) ? value : undefined;
const boolean = value => typeof value === 'boolean' ? value : undefined;
export function diagnosticErrorCode(error) {
    if (!error) return undefined;
    if (diagnosticCodes.includes(error.code)) return error.code;
    if (error instanceof SyntaxError) return 'MEMORY_JSON_INVALID';
    return legacyCodes.get(typeof error === 'string' ? error : error.message) ?? 'ERROR_UNCLASSIFIED';
}
/** Only shape and numeric boundary metadata; never return a raw string/object. */
export function sanitizeTurnDiagnostic(value) {
    if (!value || typeof value !== 'object') return undefined;
    const result = {};
    if (Number.isSafeInteger(value.expectedTurn) && value.expectedTurn >= 0) result.expectedTurn = value.expectedTurn;
    if (['missing', 'null', 'array', 'object', 'string', 'boolean', 'number'].includes(value.returnedType)) result.returnedType = value.returnedType;
    if (value.returnedType === 'number' && Number.isFinite(value.returnedTurn)) result.returnedTurn = value.returnedTurn;
    if (value.returnedType === 'string' && Number.isSafeInteger(value.numericStringTurn) && value.numericStringTurn >= 0) result.numericStringTurn = value.numericStringTurn;
    return Object.keys(result).length ? result : undefined;
}
/** Bounded numeric coordinates and fixed row kinds; no IDs or text. */
export function sanitizeNumberingDiagnostic(value) {
    if (!value || typeof value !== 'object') return undefined;
    const result = numeric(value, ['previousThroughTurn', 'requestedThroughTurn', 'payloadThroughTurn', 'payloadPreviousThroughTurn', 'completedThroughTurn', 'archiveRowCount', 'openingCount', 'selectedRowCount', 'sourceTableCount', 'auxiliaryCount']);
    if (typeof value.requestMatchesPayload === 'boolean') result.requestMatchesPayload = value.requestMatchesPayload;
    if (typeof value.truncated === 'boolean') result.truncated = value.truncated;
    const row = item => ({ ...numeric(item, ['turn', 'sourceIndex']), role: choice(item?.role, ['user', 'assistant']), nativeRows: Array.isArray(item?.nativeRows) ? item.nativeRows.filter(x => Number.isSafeInteger(x) && x >= 0).slice(0, 128) : undefined });
    for (const key of ['selectedRows', 'payloadRows', 'sourceTableRows']) if (Array.isArray(value[key])) result[key] = value[key].slice(0, 128).map(row);
    if (Array.isArray(value.auxiliaryRows)) result.auxiliaryRows = value.auxiliaryRows.slice(0, 128).map(item => ({ ...numeric(item, ['nativeRow']), kind: choice(item?.kind, ['media-artifact', 'system-record', 'empty']) }));
    return result;
}
export function buildNumberingDiagnostic(prepared, selected, memoryValue, session) {
    // Inspect the exact server-built payload, not a reconstructed expectation.
    const payload = JSON.parse(prepared.request.messages.find(row => row.role === 'user').content);
    const table = prepared.sourceTable ?? [];
    const payloadRows = (payload.new_completed_prefix ?? []).map(row => ({ turn: row.turn, role: row.role, sourceIndex: row.source }));
    const selectedRows = selected.map(row => ({ turn: row.turn, role: row.role, sourceIndex: table.indexOf(row.id), nativeRows: row.source_rows }));
    const sourceTableRows = table.map((id, sourceIndex) => { const match = /^t(\d+)(u|a)$/u.exec(id); return { sourceIndex, turn: match ? Number(match[1]) : undefined, role: match ? match[2] === 'u' ? 'user' : 'assistant' : undefined }; });
    const auxiliary = session.auxiliary ?? [];
    return sanitizeNumberingDiagnostic({ previousThroughTurn: memoryValue.through_turn, requestedThroughTurn: prepared.throughTurn, payloadThroughTurn: payload.through_turn,
        payloadPreviousThroughTurn: payload.previous_memory?.t ?? payload.previous_memory?.through_turn, completedThroughTurn: session.completedThrough, archiveRowCount: session.anchors?.length, openingCount: session.opening?.length,
        selectedRowCount: selectedRows.length, sourceTableCount: table.length, auxiliaryCount: auxiliary.length,
        requestMatchesPayload: payload.through_turn === prepared.throughTurn && (payload.previous_memory?.t ?? payload.previous_memory?.through_turn) === memoryValue.through_turn && payloadRows.length === selectedRows.length && payloadRows.every((row, i) => row.turn === selectedRows[i].turn && row.role === selectedRows[i].role && (!prepared.sourceTable || row.sourceIndex === selectedRows[i].sourceIndex)) && selected.at(-1)?.turn === prepared.throughTurn,
        truncated: selectedRows.length > 128 || payloadRows.length > 128 || table.length > 128 || auxiliary.length > 128 || selectedRows.some(row => row.nativeRows?.length > 128),
        selectedRows, payloadRows, sourceTableRows, auxiliaryRows: auxiliary.map(row => ({ nativeRow: row.source_row, kind: row.kind })) });
}
function stats(value) { return { ...numeric(value, statsKeys), finishReason: choice(value?.finishReason, finishes) }; }
function date(value) { return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value) ? value : undefined; }
function memory(value) {
    return { ...numeric(value, metricKeys), numberingDiagnostic: sanitizeNumberingDiagnostic(value?.numberingDiagnostic), turnDiagnostic: sanitizeTurnDiagnostic(value?.turnDiagnostic), status: choice(value?.status, memoryStatuses), errorCode: choice(value?.errorCode, diagnosticCodes) ?? diagnosticErrorCode(value?.error), latestState: { status: choice(value?.latestState?.status, memoryStatuses), errorCode: choice(value?.latestState?.errorCode, diagnosticCodes) ?? diagnosticErrorCode(value?.latestState?.error) }, modelStats: stats(value?.modelStats) };
}
export function diagnosticJob(job) {
    const summary = job.sessionSummary;
    const outcome = summary?.memoryOutcome ?? job.memoryOutcome;
    const timings = numeric(job.timings, timingKeys);
    const phaseStats = {};
    for (const phase of phases) if (job.phaseDiagnostics?.[phase]) {
        const row = job.phaseDiagnostics[phase];
        phaseStats[phase] = { ...numeric(row, ['startedMs', 'completedMs', 'durationMs', 'firstContentMs']), modelStats: stats(row.modelStats), inputProgress: numeric(row.inputProgress, ['cachedTokens', 'totalTokens', 'processedTokens', 'fraction']) };
    }
    return {
        jobRef: typeof job.id === 'string' ? createHash('sha256').update(job.id).digest('hex').slice(0, 24) : undefined,
        status: choice(job.status, statuses), createdAt: date(job.createdAt), updatedAt: date(job.updatedAt), dialogueReady: boolean(job.dialogueReady),
        workPhase: choice(job.progress?.workPhase, phases), timingsMs: timings, phaseStats,
        postDialogueMs: timings.summaryPersisted >= timings.dialogueComplete ? timings.summaryPersisted - timings.dialogueComplete : undefined,
        modelStats: stats(job.modelStats), inputProgress: numeric(job.progress?.inputProgress, ['cachedTokens', 'totalTokens', 'processedTokens', 'fraction']),
        memory: memory(job.memoryMetrics), memoryMetricsAvailable: Boolean(job.memoryMetrics),
        summary: { numberingDiagnostic: sanitizeNumberingDiagnostic(summary?.numberingDiagnostic), turnDiagnostic: sanitizeTurnDiagnostic(summary?.turnDiagnostic), status: choice(summary?.status, memoryStatuses), keepRaw: boolean(summary?.keepRaw ?? outcome?.keepRaw), errorCode: choice(summary?.errorCode, diagnosticCodes) ?? diagnosticErrorCode(summary?.error) },
        outcome: { latestStateStatus: choice(outcome?.latestStateStatus, memoryStatuses), episodicStatus: choice(outcome?.episodicStatus, memoryStatuses), keepRaw: boolean(outcome?.keepRaw) },
        errorCode: diagnosticErrorCode(job.error),
    };
}

/** Collect independent phase measurements without input/output or extra writes. */
export function recordPhaseDiagnostics(job, progress, now = Date.now()) {
    const phase = choice(progress?.workPhase, phases) ?? choice(job.progress?.workPhase, phases);
    if (!phase) return;
    job.phaseDiagnostics ??= {};
    for (const [other, row] of Object.entries(job.phaseDiagnostics)) if (other !== phase && row.completedMs === undefined) {
        row.completedMs = now - Date.parse(job.createdAt); row.durationMs = Math.max(0, row.completedMs - row.startedMs);
    }
    const row = job.phaseDiagnostics[phase] ??= { startedMs: now - Date.parse(job.createdAt) };
    const modelStats = progress?.phaseModelStats ?? progress?.modelStats ?? (phase === 'episodic' ? progress?.memoryMetrics?.modelStats : undefined);
    if (modelStats) row.modelStats = stats(modelStats);
    if (progress?.inputProgress) row.inputProgress = numeric(progress.inputProgress, ['cachedTokens', 'totalTokens', 'processedTokens', 'fraction']);
    const firstContentAt = Number.isSafeInteger(progress?.phaseFirstContentAt) ? progress.phaseFirstContentAt : progress?.event === 'firstContent' ? now : undefined;
    if (firstContentAt !== undefined) row.firstContentMs ??= Math.max(0, firstContentAt - Date.parse(job.createdAt) - row.startedMs);
}
export function finishPhaseDiagnostics(job, now = Date.now()) {
    for (const phase of phases) {
        const row = job.phaseDiagnostics?.[phase];
        if (row && row.completedMs === undefined) { row.completedMs = now - Date.parse(job.createdAt); row.durationMs = Math.max(0, row.completedMs - row.startedMs); }
    }
}
