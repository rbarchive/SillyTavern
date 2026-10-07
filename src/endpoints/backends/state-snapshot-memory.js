import { compactWriterInstruction, decodeCompactDelta } from './compact-memory-delta.js';

/** Opt-in writer contract: only the small active-state layer is a complete snapshot. */
export function stateSnapshotWriterInstruction() {
    const rules = compactWriterInstruction().split('\n').slice(0, 6);
    rules[3] = 'current_state_snapshot은 경계 시점의 현재 위치·진행 중 목표·미완료 조건·대상별 관계의 전체 유효 목록이다. 제공된 이전 상태 전체와 새 원문을 대조한다. 변하지 않은 유효 상태도 포함하고 완료·취소되거나 새 상태로 대체된 것은 목록에서 제외한다. 같은 대상은 기존 id를 유지한다. 같은 장면의 상태를 연결해서 적되 계획은 완료로 바꾸지 않는다. 일시 감정은 기본 성격 변화가 아니다. 상태의 교체·삭제 연산은 CPU가 계산하므로 s나 상태 삭제 x를 출력하지 않는다.';
    return [...rules,
        '현재 상태는 경계 시점에 실제로 유효한 결과와 다음 행동을 제한하는 조건이다. 이전 장소별 설명·완료 과정·지난 계획을 상태 목록에 누적하지 않는다. 이동하면 현재 위치를 갱신하고, 완료된 일은 미완료 목표에서 제외하되 완료 결과가 다음 행동에 필요하면 결과로 남긴다. 중요한 과정·명시 원인·당시 계획은 사건 이력에 보존한다. 아직 유효한 약속·관계·조건은 오래됐다는 이유로 제외하지 않는다. 인물의 오래된 주장이나 믿음은 그 인물에게 새 근거가 전달됐을 때만 갱신하며 세계의 현재 사실과 혼합하지 않는다.',
        'JSON 한 객체만 출력한다. v:3,t:요청값,current_state_snapshot:[상태 행]은 항상 필수다. current_state_snapshot과 e의 각 행은 정확히 3칸 [id,text,[정수 source 번호]]이다. k의 각 행만 정확히 5칸 [id,text,[정수 source 번호],holder,basis]이며 holder와 basis는 k에만 쓴다. basis는 observed/received/claim/belief/uncertain 중 하나다. 사건의 발언 주체·주장·추정·조건은 e의 text 안에 보존하고 추가 칸으로 만들지 않는다. x는 ["e"/"k",삭제할 기존id] 행들의 배열이다. 출처 문자열은 쓰지 않는다.',
        '전체 상태 snapshot을 쓰되 e/k는 변경분만 쓴다. 같은 범주의 같은 id는 교체 또는 삭제 중 하나만 출력한다. 변경 없는 e/k는 CPU가 보존하므로 출력하지 않는다. s 또는 ["s",id] 삭제 연산은 허용되지 않는다.',
        '형식 예시(이야기 사실 아님): 기존 s1을 갱신하고 완료된 s2를 제외하면 {"v":3,"t":2,"current_state_snapshot":[["s1","현재 유효 상태",[0,1]]]}. 이전 상태 s3가 계속 유효하면 s3도 snapshot에 포함해야 한다. 새 사건만 추가하면 e에 새 id를 쓴다.',
        'snapshot 누락은 오류다. 모든 활성 상태가 사라졌다는 근거가 있을 때만 명시적인 []를 쓴다. e/k/x 생략은 해당 변경 없음이다. 개요 o는 기존 개요가 있고 기억이 바뀌면 짧게 갱신하거나 빈 문자열로 비운다. 분석·들여쓰기·코드펜스 없이 끝낸다.',
    ].join('\n');
}

const sameState = (left, right) => left && left.id === right.id && left.text === right.text
    && JSON.stringify(left.sources) === JSON.stringify(right.sources);

/** Validate the full snapshot, then compute operations. Never infer missing facts or repair output. */
export function decodeStateSnapshotDelta(value, prepared, memory) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.v !== 3
        || !Object.hasOwn(value, 'current_state_snapshot') || !Array.isArray(value.current_state_snapshot)
        || Object.keys(value).some(key => !['v', 't', 'current_state_snapshot', 'e', 'k', 'x', 'o'].includes(key))
        || (Object.hasOwn(value, 'x') && !Array.isArray(value.x))
        || (value.x || []).some(row => Array.isArray(row) && row[0] === 's')) throw new Error('Invalid state snapshot contract');

    const snapshot = decodeCompactDelta({ v: 2, t: value.t, s: value.current_state_snapshot, o: memory.overview }, prepared, memory).current_state.upsert;
    const present = new Set(snapshot.map(row => row.id));
    if (present.size !== snapshot.length) throw new Error('Duplicate state snapshot id');
    const previous = new Map(memory.current_state.map(row => [row.id, row]));
    const compact = { v: 2, t: value.t, s: value.current_state_snapshot.filter((_, index) => !sameState(previous.get(snapshot[index].id), snapshot[index])) };
    for (const key of ['e', 'k', 'o']) if (Object.hasOwn(value, key)) compact[key] = value[key];
    compact.x = [...(value.x || []), ...memory.current_state.filter(row => !present.has(row.id)).map(row => ['s', row.id])];
    return decodeCompactDelta(compact, prepared, memory);
}
