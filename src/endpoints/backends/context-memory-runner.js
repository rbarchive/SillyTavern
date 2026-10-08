import { diagnosticErrorCode } from '../../generation-job-diagnostics.js';
import { runLatestContextMemoryTurn } from './latest-context-memory-runner.js';
import { assembleContextMessages, planConsolidation, buildDeltaRequest, mergeMemoryDelta, sourcesFor, revision, nativePrefixBoundary } from './context-memory.js';
import { buildFreeDialogueRequest } from './separate-session-summary.js';
import { capConsolidationPrefix } from './recent-raw-window.js';
import { orderRoleMetadata } from './cache-friendly-context.js';

/** One foreground call; one optional writer. No writer preview enters the UI. */
export async function runContextMemoryTurn(options) {
    if (options.latestStateEnabled) return runLatestContextMemoryTurn(options);
    const { request, session, previous, scope, fixedContext, rawBudget, countMessages, generate, saveDialogue, readSession, signal, update, sourceChronology = false, consolidationTokenBudget, groundedRetrieval = false, retrievalBudgets, memoryWireFormat = 'legacy-v1' } = options;
    if (request.rp_inline_summary) throw new Error('Conflicting RP memory modes');
    const started = Date.now();
    const assembled = assembleContextMessages(request.messages, session, previous, scope, fixedContext, { sourceChronology, groundedRetrieval, retrievalBudgets });
    const actor = buildFreeDialogueRequest({ ...request, messages: assembled.messages, max_tokens: 8192 }, { enabled: true, systemPolicy: true });
    actor.messages = orderRoleMetadata(actor.messages);
    update({ contextSummary: { ...assembled.retrieval, rawBudget, assemblyMs: Date.now() - started } });
    const reply = await generate(actor, signal, update);
    // Durable commit first; this is also the browser's foreground completion boundary.
    await saveDialogue(reply);
    const metrics = { startedAt: Date.now(), rawBudget, status: 'planning', invocationCount: 0 };
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const report = () => update({ phase: 'session-summary', memoryMetrics: { ...metrics } });
    try {
        const stored = readSession();
        const plan = await planConsolidation(stored, assembled.memory, rawBudget, async rows => { controller.signal.throwIfAborted(); return countMessages(rows, controller.signal); });
        metrics.planningMs = Date.now() - metrics.startedAt;
        metrics.pendingTokens = plan.pendingTokens; metrics.protectedTokens = plan.protectedTokens; metrics.targetThroughTurn = plan.candidateThroughTurn;
        if (!plan.consolidationMessages.length || plan.awaitingConsolidationTokens < 1024) {
            metrics.status = 'not-needed'; metrics.totalMs = Date.now() - metrics.startedAt; report();
            return { ...reply, sessionSummary: { status: 'skipped', mode: 'context-v1' } };
        }
        let prefix = plan.consolidationMessages;
        if (consolidationTokenBudget !== undefined) {
            const capped = await capConsolidationPrefix(prefix, consolidationTokenBudget, rows => countMessages(rows, controller.signal));
            metrics.consolidationTokens = capped.tokens; metrics.backlogRows = capped.pendingRows;
            if (!capped.messages.length) {
                metrics.status = 'deferred-oversized-turn'; metrics.totalMs = Date.now() - metrics.startedAt; report();
                return { ...reply, sessionSummary: { mode: 'context-v1', status: 'skipped', keepRaw: true } };
            }
            prefix = capped.messages;
        }
        const prepared = buildDeltaRequest(actor, { fixedContext, memory: assembled.memory, messages: prefix, wireFormat: memoryWireFormat });
        metrics.targetThroughTurn = prepared.throughTurn;
        const catalog = sourcesFor(stored.messages, prepared.throughTurn);
        const sourceRevision = revision(catalog);
        metrics.invocationCount = 1; metrics.status = 'generating'; report();
        const writer = await generate(request, controller.signal, progress => {
            if (progress.streamMetrics) metrics.provider = { ...metrics.provider, ...progress.streamMetrics };
            if (progress.modelStats) metrics.modelStats = progress.modelStats;
            report();
        }, prepared.request);
        if (metrics.modelStats?.finishReason === 'length') throw new Error('Memory output truncated');
        controller.signal.throwIfAborted();
        const currentCatalog = sourcesFor(readSession().messages, prepared.throughTurn);
        if (revision(currentCatalog) !== sourceRevision) throw new Error('Consolidated prefix was edited');
        const memory = mergeMemoryDelta(writer.text, prepared, assembled.memory, currentCatalog);
        metrics.status = 'complete'; metrics.totalMs = Date.now() - metrics.startedAt; report();
        return { ...reply, sessionSummary: { mode: 'context-v1', status: 'complete', summary: memory, sourceRevision, previousThrough: assembled.memory.through_turn, targetAnchor: stored.anchors.slice(0, nativePrefixBoundary(stored, prepared.throughTurn)) } };
    } catch (error) {
        metrics.status = 'failed'; metrics.totalMs = Date.now() - metrics.startedAt; metrics.errorCode = diagnosticErrorCode(error); metrics.error = error.name === 'AbortError' ? 'Memory cancelled' : error.message; report();
        return { ...reply, sessionSummary: { mode: 'context-v1', status: 'failed', error: metrics.error, errorCode: metrics.errorCode, keepRaw: true } };
    } finally { signal?.removeEventListener('abort', abort); }
}
