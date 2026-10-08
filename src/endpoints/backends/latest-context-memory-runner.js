import { diagnosticErrorCode } from '../../generation-job-diagnostics.js';
import { orderRoleMetadata } from './cache-friendly-context.js';
import { assembleContextMessages, planConsolidation, buildDeltaRequest, mergeMemoryDelta, sourcesFor, revision, nativePrefixBoundary } from './context-memory.js';
import { buildFreeDialogueRequest } from './separate-session-summary.js';
import { capConsolidationPrefix } from './recent-raw-window.js';
import fs from 'node:fs';
import { prepareLatestActor, updateLatestState, actorPrefixChanged } from './latest-state-overlay.js';
const rules = JSON.parse(fs.readFileSync(new URL('./rp-context-rules.json', import.meta.url), 'utf8'));


/** One foreground call; separate background writers without an elapsed-time cutoff. No writer preview enters the UI. */
export async function runLatestContextMemoryTurn({ request, session, previous, scope, fixedContext, rawBudget, countMessages, generate, saveDialogue, readSession, signal, update, sourceChronology = false, consolidationTokenBudget, groundedRetrieval = false, retrievalBudgets, memoryWireFormat = 'legacy-v1', latestStateStorageRoot }) {
    if (request.rp_inline_summary) throw new Error('Conflicting RP memory modes');
    const started = Date.now();
    const assembled = assembleContextMessages(request.messages, { ...session, opening: [] }, previous, scope, fixedContext, { sourceChronology, groundedRetrieval, retrievalBudgets });
    const firstSystem = assembled.messages.find(row => row.role === 'system')?.content || '';
    const core = firstSystem.includes(fixedContext) ? firstSystem : firstSystem + '\n\n' + fixedContext;
    const shared = rules.modeRules + '\n\n[공통 세계관·설정]\n' + core + '\n\n[일반 RP 모드에서만 적용하는 지침]\n' + rules.actorRules + '\n\n[기억 갱신 모드에서만 적용하는 지침]\n' + rules.writerRules;
    const overlayActor = prepareLatestActor({ ...request, messages: assembled.messages, max_tokens: 8192, actorRules: shared, writerRules: shared, assistantPrefill: '</think>\n\n' }, { fixedContext: '', session, scope, storageRoot: latestStateStorageRoot });
    const actor = overlayActor.params;
    actor.messages = orderRoleMetadata(actor.messages);
    overlayActor.params = actor;
    update({ contextSummary: { ...assembled.retrieval, rawBudget, assemblyMs: Date.now() - started } });
    update({ workPhase: 'dialogue', phaseStartedAt: Date.now(), reading: false, longReadPossible: actorPrefixChanged(overlayActor) });
    const reply = await generate(request, signal, update, actor, 'dialogue');
    // Durable commit first; this is also the browser's foreground completion boundary.
    await saveDialogue(reply);
    const metrics = { startedAt: Date.now(), rawBudget, status: 'planning', invocationCount: 0 };
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    let workPhase = 'latest-state';
    const outcome = episodicStatus => ({ latestStateStatus: metrics.latestState?.status === 'complete' ? 'complete' : 'failed', episodicStatus, keepRaw: episodicStatus !== 'complete' });
    const finish = sessionSummary => ({ ...reply, sessionSummary: { ...sessionSummary, memoryOutcome: outcome(sessionSummary.status) } });
    const report = () => update({ phase: 'session-summary', memoryMetrics: { ...metrics, latestState: metrics.latestState ? { status: metrics.latestState.status, asOfTurn: metrics.latestState.card?.asOfTurn, errorCode: diagnosticErrorCode(metrics.latestState.error) } : undefined, stateProgress: undefined }, memoryOutcome: metrics.latestState ? outcome(metrics.status) : undefined });
    const showRead = progress => {
        if (progress.modelStats || progress.event === 'firstContent') update({ phaseModelStats: progress.modelStats, phaseFirstContentAt: progress.event === 'firstContent' ? progress.receivedAt : undefined });
        if (progress.inputProgress || progress.reading !== undefined) update({ workPhase, inputProgress: progress.inputProgress, reading: progress.reading, longReadPossible: progress.longReadPossible });
    };
    const phase = value => { workPhase = value; update({ phase: 'session-summary', workPhase: value, phaseStartedAt: Date.now(), reading: false }); };

    try {
        const stored = readSession();
        const stateStarted = Date.now();
        phase('latest-state');
        metrics.latestState = await updateLatestState({ actor: overlayActor, reply, session: stored, readSession, scope, signal: controller.signal, storageRoot: latestStateStorageRoot, remainingMs: Infinity, update: progress => { showRead(progress); }, generate: (params, stateSignal, progress) => generate(request, stateSignal, progress, params, 'latest-state') });
        metrics.latestStateMs = Date.now() - stateStarted;
        report();
        const plan = await planConsolidation(stored, assembled.memory, rawBudget, async rows => { controller.signal.throwIfAborted(); return countMessages(rows, controller.signal); });
        metrics.planningMs = Date.now() - metrics.startedAt;
        metrics.pendingTokens = plan.pendingTokens; metrics.protectedTokens = plan.protectedTokens; metrics.targetThroughTurn = plan.candidateThroughTurn;
        if (!plan.consolidationMessages.length || plan.awaitingConsolidationTokens < 1024) {
            metrics.status = 'not-needed'; metrics.totalMs = Date.now() - metrics.startedAt; report();
            return finish({ status: 'skipped', mode: 'context-v1', keepRaw: true });
        }
        let prefix = plan.consolidationMessages;
        if (consolidationTokenBudget !== undefined) {
            const capped = await capConsolidationPrefix(prefix, consolidationTokenBudget, rows => countMessages(rows, controller.signal));
            metrics.consolidationTokens = capped.tokens; metrics.backlogRows = capped.pendingRows;
            if (!capped.messages.length) {
                metrics.status = 'deferred-oversized-turn'; metrics.totalMs = Date.now() - metrics.startedAt; report();
                return finish({ mode: 'context-v1', status: 'skipped', keepRaw: true });
            }
            prefix = capped.messages;
        }
        const prepared = buildDeltaRequest(actor, { fixedContext, memory: assembled.memory, messages: prefix, wireFormat: memoryWireFormat });
        metrics.targetThroughTurn = prepared.throughTurn;
        const catalog = sourcesFor(stored.messages, prepared.throughTurn);
        const sourceRevision = revision(catalog);
        metrics.invocationCount = 1; metrics.status = 'generating'; report();
        const episodicStarted = Date.now();
        phase('episodic');
        const writer = await generate(request, controller.signal, progress => {
            showRead(progress);
            if (progress.streamMetrics) metrics.provider = { ...metrics.provider, ...progress.streamMetrics };
            if (progress.modelStats) metrics.modelStats = progress.modelStats;
            if (progress.streamMetrics || progress.modelStats) update({ memoryMetrics: { ...metrics }, memoryOutcome: outcome(metrics.status) });
        }, prepared.request, 'episodic');
        metrics.episodicMs = Date.now() - episodicStarted;
        if (metrics.modelStats?.finishReason === 'length') throw new Error('Memory output truncated');
        controller.signal.throwIfAborted();
        const currentCatalog = sourcesFor(readSession().messages, prepared.throughTurn);
        if (revision(currentCatalog) !== sourceRevision) throw new Error('Consolidated prefix was edited');
        const memory = mergeMemoryDelta(writer.text, prepared, assembled.memory, currentCatalog);
        metrics.status = 'complete'; metrics.totalMs = Date.now() - metrics.startedAt; report();
        return finish({ mode: 'context-v1', status: 'complete', summary: memory, sourceRevision, previousThrough: assembled.memory.through_turn, targetAnchor: stored.anchors.slice(0, nativePrefixBoundary(stored, prepared.throughTurn)) });
    } catch (error) {
        metrics.status = 'failed'; metrics.totalMs = Date.now() - metrics.startedAt; metrics.errorCode = diagnosticErrorCode(error); metrics.error = error.name === 'AbortError' ? 'Memory cancelled' : error.message; report();
        return finish({ mode: 'context-v1', status: 'failed', error: metrics.error, errorCode: metrics.errorCode, keepRaw: true });
    } finally { signal?.removeEventListener('abort', abort); }
}
