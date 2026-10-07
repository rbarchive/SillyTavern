import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generationProgressDisplay, memoryFailureDisplay, visibleGenerationJobs } from '../public/scripts/generation-progress-display.js';

const now = 100_000;
const base = { status: 'running', createdAt: new Date(0).toISOString(), progress: { workPhase: 'dialogue', phaseStartedAt: 88_000, reading: true } };
test('measured input fraction and elapsed time show the reading phase', () => {
    assert.equal(generationProgressDisplay({ ...base, progress: { ...base.progress, inputProgress: { fraction: 0.357 } } }, now), '대화 맥락 읽는 중 · 35% · 12초 경과');
});
test('invalid or absent fractions never invent a percentage', () => {
    for (const fraction of [undefined, null, '0.5', NaN, Infinity, -0.1, 1.1]) {
        assert.equal(generationProgressDisplay({ ...base, progress: { ...base.progress, inputProgress: { fraction } } }, now), '대화 맥락 읽는 중 · 12초 경과');
    }
});
test('complete input is generation, never an overall 100 percent', () => {
    assert.equal(generationProgressDisplay({ ...base, progress: { ...base.progress, inputProgress: { fraction: 1 } } }, now), '응답 생성 중 · 12초 경과');
    assert.equal(generationProgressDisplay({ ...base, progress: { ...base.progress, reading: false, inputProgress: { fraction: 0.5 } } }, now), '응답 생성 중 · 12초 경과');
});
test('postprocessing phase transitions reset elapsed time', () => {
    const state = { ...base, dialogueReady: true, progress: { workPhase: 'latest-state', phaseStartedAt: 92_000, reading: false } };
    assert.equal(generationProgressDisplay(state, now), '최근 상태 정리 중 · 8초 경과');
    assert.equal(generationProgressDisplay({ ...state, progress: { workPhase: 'episodic', phaseStartedAt: 98_000, reading: false } }, now), '이전 대화를 장기 기억으로 정리 중 · 2초 경과');
    assert.equal(generationProgressDisplay({ ...state, progress: { ...state.progress, reading: true, inputProgress: { fraction: 0.25 } } }, now), '최근 상태 맥락 읽는 중 · 25% · 8초 경과');
});
test('long reading is announced without an ETA', () => {
    assert.match(generationProgressDisplay({ ...base, progress: { ...base.progress, reading: false, longReadPossible: true } }, now), /평소보다 시간이 걸릴 수 있습니다$/);
});
test('legacy postprocessing does not count from dialogue creation', () => {
    assert.equal(generationProgressDisplay({ ...base, dialogueReady: true, progress: {} }, now), '최근 상태 정리 중 · 0초 경과');
});
test('memory failure stays visible even when dialogue saved successfully', () => {
    assert.equal(generationProgressDisplay({ ...base, status: 'completed', dialogueReady: true, sessionSummary: { status: 'failed', keepRaw: true } }, now), '장기 기억 정리를 완료하지 못했습니다. 대화 원문은 보존됩니다.');
    assert.equal(memoryFailureDisplay({ memoryOutcome: { latestStateStatus: 'failed', episodicStatus: 'skipped', keepRaw: true } }), '최근 상태 정리를 완료하지 못했습니다. 대화 원문은 보존됩니다.');
});
test('cancelled and unconfirmed raw preservation never claim raw is kept', () => {
    assert.equal(generationProgressDisplay({ ...base, status: 'cancelling' }, now), '작업 중지 중 · 12초 경과');
    assert.equal(generationProgressDisplay({ ...base, status: 'cancelled', sessionSummary: { status: 'interrupted' } }, now), '기억 정리가 중단되었습니다.');
    assert.equal(memoryFailureDisplay({ sessionSummary: { status: 'failed' } }), '장기 기억 정리를 완료하지 못했습니다.');
});
test('image labels remain available', () => {
    assert.equal(generationProgressDisplay({ ...base, progress: { phase: 'drawing', phaseStartedAt: 95_000 } }, now), '이미지 생성 중 · 5초 경과');
});
test('failure receipt disappears when a later job exists', () => {
    const failed = { id: 'old', status: 'completed', createdAt: new Date(0).toISOString(), sessionSummary: { status: 'failed', keepRaw: true } };
    const next = { id: 'new', status: 'running', createdAt: new Date(1).toISOString() };
    assert.deepEqual(visibleGenerationJobs([failed]), [failed]);
    assert.deepEqual(visibleGenerationJobs([failed, next]), [next]);
    assert.deepEqual(visibleGenerationJobs([failed, { ...next, status: 'completed' }]), []);
});

test('long reading warning remains visible while prefill is still in progress', () => {
 const display = generationProgressDisplay({ ...base, progress: { reading: true, inputProgress: { fraction: 0.1 }, longReadPossible: true } }, now);
 assert.ok(display.includes('10%')); assert.ok(display.includes('평소보다 시간이 걸릴 수 있습니다'));
});
