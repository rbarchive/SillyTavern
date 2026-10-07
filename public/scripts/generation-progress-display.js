const terminalStatuses = new Set(['completed', 'failed', 'conflict', 'cancelled', 'interrupted']);

/** A memory failure remains visible with the saved response, without repeated notifications. */
export function memoryFailureDisplay(job) {
    if (job.toolReceipts?.some(receipt => receipt.warning)) return '세계관 설정은 저장됐지만 내보내기 파일 갱신에 실패했습니다.';
    if (job.status !== 'completed' && job.toolReceipts?.some(receipt => receipt.writeApplied)) return '작업은 종료됐지만 일부 세계관 설정은 이미 저장되었습니다.';
    const outcome = job.memoryOutcome;
    const stateFailed = outcome?.latestStateStatus === 'failed';
    const episodeFailed = outcome?.episodicStatus === 'failed';
    if (['cancelled', 'interrupted'].includes(job.sessionSummary?.status)) return `기억 정리가 중단되었습니다.${outcome?.keepRaw === true || job.sessionSummary?.keepRaw === true ? ' 대화 원문은 보존됩니다.' : ''}`;
    if (!stateFailed && !episodeFailed && job.sessionSummary?.status !== 'failed') return null;
    const label = stateFailed ? '최근 상태 정리를 완료하지 못했습니다.' : '장기 기억 정리를 완료하지 못했습니다.';
    const keepRaw = outcome?.keepRaw === true || job.sessionSummary?.keepRaw === true;
    return `${label}${keepRaw ? ' 대화 원문은 보존됩니다.' : ''}`;
}

/** Format only measured input progress; elapsed time is local to the current work phase. */
export function generationProgressDisplay(job, now = Date.now()) {
    if (terminalStatuses.has(job.status)) return memoryFailureDisplay(job);
    const progress = job.progress || {};
    const phase = progress.workPhase || (job.dialogueReady ? 'latest-state' : 'dialogue');
    const startedAt = Number.isFinite(progress.phaseStartedAt) ? progress.phaseStartedAt
        : phase === 'dialogue' ? Date.parse(job.createdAt)
            : Number.isFinite(job.timings?.dialogueComplete) ? Date.parse(job.createdAt) + job.timings.dialogueComplete : now;
    const elapsed = Number.isFinite(startedAt) ? Math.max(0, Math.floor((now - startedAt) / 1000)) : 0;
    if (job.status === 'cancelling') return `작업 중지 중 · ${elapsed}초 경과`;
    const fraction = progress.inputProgress?.fraction;
    const validFraction = typeof fraction === 'number' && Number.isFinite(fraction) && fraction >= 0 && fraction <= 1;
    const reading = progress.reading === true && (!validFraction || fraction < 1);
    let label;
    if (progress.phase === 'awaiting-confirmation') label = '세계관 저장 승인 대기';
    else if (progress.phase === 'awaiting-tool') label = '세계관 화면 작업 대기';
    else if (progress.phase === 'tools') label = '세계관 도구 처리 중';
    else if (progress.phase === 'drawing') label = '이미지 생성 중';
    else if (progress.phase === 'description') label = '이미지 묘사 생성 중';
    else if (reading) label = `${phase === 'episodic' ? '장기 기억' : phase === 'latest-state' ? '최근 상태' : '대화'} 맥락 읽는 중`;
    else label = phase === 'episodic' ? '이전 대화를 장기 기억으로 정리 중' : phase === 'latest-state' ? '최근 상태 정리 중' : '응답 생성 중';
    const percent = reading && validFraction ? ` · ${Math.floor(fraction * 100)}%` : '';
    const notice = progress.longReadPossible && !job.dialogueReady ? ' · 이번 대화 맥락 처리에는 평소보다 시간이 걸릴 수 있습니다' : '';
    return `${label}${percent} · ${elapsed}초 경과${notice}`;
}

/** Show active jobs and retain a memory failure only until the next job starts. */
export function visibleGenerationJobs(jobs) {
    const active = jobs.filter(job => !terminalStatuses.has(job.status));
    const latest = jobs.reduce((current, job) => !current || Date.parse(job.createdAt) > Date.parse(current.createdAt) ? job : current, null);
    if (latest && terminalStatuses.has(latest.status) && memoryFailureDisplay(latest)) active.push(latest);
    return active;
}
