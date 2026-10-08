# RP Memory fork patch status — 2026-10-08

This fork and the paired RP-Memory repository contain an uncommitted cumulative development patch, not a completed quality/latency release. Source base: SillyTavern `release` / `551016b3d`; RP-Memory `feat/world-hub-conversations` / `730eca7`.

## Active integration configuration (8001 sandbox only)

`enableRpContextMemory=true`, `rpMemoryDefaultContextMemory=true`, `rpMemoryLatestStateEnabled=true`, native SDK progress enabled, raw target4096, consolidation1024, wire format `compact-v2`. Host URLs/SDK paths/model installation and user configuration are local and must not be committed. Source defaults remain opt-in.

- Free non-thinking Actor with one generation invocation on the normal hot path; separate latest state and conditional episodic consolidation.
- Validated checkpoint, source provenance, recent raw preservation after failure, deterministic retrieval/merge.
- Mixed image/system/blank/adjacent-user archive normalization without deleting archive contents.
- Durable generation/world tools, approval-required writes, scope/edit guards and recovery.
- Single progress UI, foreground receipt reuse, deferred hidden RP panel lists, persistent failure notice IDs.

## Retained but not selected

`inline-session-summary.js` supplies shared summary helpers and the legacy opt-in inline JSON route. `session-ledger.js` delta/evidence experiments require the default-off `enableRpSessionExperiments`. `state-snapshot-memory.js` supports the opt-in `state-snapshot-v3` wire format; 8001 selects `compact-v2`. `rp-background.js` retains legacy prefix/warm/curator compatibility. These files are runtime imports, so moving/deleting them is not a documentation cleanup. Do not enable them from a historical benchmark recommendation.

Explicit KV save/restore, a small-model preprocessing stack, model replacement, thinking Actor, and issue-specific raw deletion are not selected. The normal current context route does not run the old client curator.

## Verification and boundaries

Latest regressions: `node --test tests/*.node.test.mjs` **329 passed**; paired RP suite **134 passed**. Actual8001 synthetic UI turn, elapsed/stop/background receipt, input recovery and panel opening checked. Frontend cleanup installed without server restart. Changes did not deploy production or commit/push.

The earlier frozen UI30 observed factual/causal errors and episodic checkpoint stagnation; subsequent source-index fixes passed local UI consolidation/reuse but are not a new full UI30. Long Writer/prefill times remain. No overall matched speedup percentage is certified.

Canonical detailed status and evidence: paired repository `docs/CURRENT_IMPLEMENTATION.md`, `docs/benchmarks/VERIFICATION_20261008.md`, `docs/CURRENT_HANDOFF.md`. Include all required new backend/public modules and their regression tests in a future source commit; exclude dependency symlinks, local configs, sandbox data, logs and model payloads. Commit/push still require explicit user authorization.

## Development milestone

User authorized commit/push on2026-10-08. Paired milestone label: `milestone/rp-memory-2026-10-08`. This records the validated development checkpoint, with the factual quality/latency limitations above retained. One preceding local commit `551016b3d` (generation recovery polling/failure notices) is also outgoing and is part of the milestone history. Production deployment is not included. The milestone commit/tag was published to origin/release. Git now uses the existing GitHub CLI credential helper for github.com in this checkout only; no token values or global Git settings were changed. The milestone tag points to 78320b02a; a later documentation commit may record the publication.


### 2026-10-08 내용 없는 운영 진단 (source only)

- `GET /api/generation-jobs/diagnostics?limit=20` (`1..100`, 기본20). 기존 로그인·사용자별 경계를 유지하며 `Cache-Control: no-store`. 응답 `schemaVersion:1`, 고정형 configuration과 최신 작업의 diagnostics만 제공한다. 이 응답을 저장/분석하는 운영 점검에 사용하고 기존 전체 작업 상세 API를 진단 export로 쓰지 않는다.
- 포함: 해시 처리한 jobRef, 상태·생성/갱신 시각, 대사 준비 여부, phase, 숫자 시간·토큰·캐시, 종료 사유, 최신 상태/장기 기억의 성공·실패·원문 보존 상태, 고정 오류 코드. 설정은 활성 여부·입력 budget·wireFormat만 허용한다.
- 제외: origin/세계·스토리·캐릭터 이름과 ID, 파일 경로, 대화/세계관/기억/모델 입력·출력·reasoning, tool receipts, URL, 원래 오류 문자열, 알 수 없는 필드. jobRef는 원래 사용자 지정 작업 ID의 SHA256 앞24자리로, 내용을 직접 출력하지 않는 상관키이며 익명성 보장을 의미하지 않는다.
- 조회는 provider 요청/재시도/재시작 복구/DB 변경/원문 변경을 수행하지 않는다. 없는 작업 디렉터리도 만들지 않고 캐시 읽기·쓰기·eviction을 하지 않는다. 서버 내부의 기존 작업 JSON 파싱을 재사용하되 API에는 명시 허용 목록만 반환한다. 메타데이터도 접근 권한 대상이다. 이 endpoint가 운영 조회에 대한 상시 승인을 의미하지 않는다.
- compact 최상위 검증의 object/version 누락·불일치/처리turn 누락·불일치/미허용 필드/sourceTable 오류를 각각 고정 코드로 분리. 행 타입·출처 비정수·중복·범위 오류도 구분. 검증 강도·모델 입력/샘플링/호출 횟수·기억 병합 결과는 변경하지 않는다.
- `memory.latestStateMs`, `episodicMs`, `totalMs`는 기존 runner 계측. 새 `phaseStats`는 단계 진입→다음 단계 전환/종료의 벽시계 시간이므로 준비·계획·저장 등의 비용도 포함할 수 있다. `firstContentMs`는 해당 phase 시작 기준의 첫 본문 토큰이며 브라우저 DOM 표시 시간이 아니다. 최상위 modelStats는 기존 기록 호환용이고 phaseStats가 있는 새 작업에서는 phase별 값을 우선 사용한다. 미계측 값은 생략하며 0으로 추정하지 않는다.
- 기존 작업에 저장된 memoryMetrics도 안전하게 조회 가능. 상세 오류 코드와 phaseStats가 없는 과거 기록은 복원하지 않는다. 옛 `Invalid compact delta`는 MEMORY_CONTRACT_INVALID까지만 분류하며 정확한 위반 조건은 신규 작업부터 확인한다. 의미/사실성 오류는 본문 없이 확정할 수 없다.
- 검증: 합성 fixture HTTP 실제 경로·사용자 분리·인증 누락·상한·고정 오류 응답·내용 sentinel 비노출·orphan 무변경/정상 recovery 유지·없던 디렉터리 무생성, 실제 background runner의 단계 stats/첫본문 이벤트와 오류 코드 전달, compact 실패 code별 분리 및 기존 raw 보존. ST 전체335/335 통과; 문법검사·git diff --check 통과. ESLint 실행 파일이 checkout에 없어 lint는 미실행. 로그: sandboxes/integration/verification/operational-diagnostics-20261008/ST_TESTS.log.
- main이 구현·시험, 독립 read-only reviewer가 노출/동작/실제 callback 누락을 검토했고 지적 사항 반영. 공유8001/운영8000 설치·재시작·실제 모델 호출·커밋·푸시는 수행하지 않음. 8000의 기존 실패를 해결했다는 판정은 하지 않는다.


#### 실패 진단 파일 분리 추가 (미배포)
- 사용자별 `<data-root>/<user>/diagnostics/generation-failures/<hash-jobRef>.json`에 실패 종료 시 자동 추출한다. 정확한 root는 기존 user.directories.root다. 기존 generation-jobs/대화/기억 파일은 이동·삭제·수정하지 않는다. 정상 성공·사용자 취소는 생성하지 않으며 generation failed/conflict/interrupted 및 응답 완료 후 latest-state/episodic 실패도 포함한다. 자동 삭제/보관기간 제한은 추가하지 않았다.
- JSON은 schemaVersion/failureKinds/strict diagnostic snapshot뿐이다. 원문·세계관·기억·provider 출력·원래 오류·파일명/원래job ID는 저장하지 않는다. 사용자별 디렉터리0700, 파일0600, atomic write; 같은 작업은 같은 파일로 갱신되어 재조회·재추출 중복을 만들지 않는다. 파일 저장 장애는 고정 FAILURE_DIAGNOSTIC_WRITE_FAILED만 stderr에 남기고 원래 작업 완료/실패 상태를 바꾸지 않는다.
- `GET /api/generation-jobs/diagnostics/failures?limit=20`은 별도 파일만 읽는다. 기존 작업/대화 저장소를 열지 않는다. 파일을 다시 허용목록으로 검증하고 알 수 없는 필드/오류 문자열은 제외한다. 손상/잘못된 기록·symlink는 unreadableRecords 수로만 보고한다. 조회는 파일 생성/복구하지 않음.
- `POST /api/generation-jobs/diagnostics/failures/export` body `{ "limit":100 }`은 기존 최신<=100개 작업의 safe snapshot 중 실패만 명시적으로 별도 추출한다. 로그인·CSRF 경계 유지, 응답은 written/skipped/writeFailures 숫자만. 반복실행 가능하며 원래 파일과 작업 상태는 변경하지 않는다. 실행 전 운영 조회·쓰기 권한 확인 필요. 자동 startup backfill 없음.
- 검증: 실제 합성 작업 실패→자동 파일 생성, 완료된 대화의 기억 실패·state-only 실패, 내용 sentinel 미저장,0600,동일job1파일,디스크 장애가 작업결과에 영향 없음, 원래 작업·대화 제거 후 실패API 조회, 기존 실패 HTTP수동추출2회 원래bytes 불변, 변조/손상파일 재검증. 전체ST338/338+문법/diff 검사 통과. ST_FAILURE_ARCHIVE_TESTS.log. 실제 운영 디스크·모델 실패는 미검증,8000/8001미적용·commit/push0.


#### 턴 번호 불일치 내용 없는 상세 계측
- COMPACT_TURN_MISSING/MISMATCH에 turnDiagnostic을 붙인다: expectedTurn, 반환값의 고정 returnedType, 숫자인 경우 유한 returnedTurn, 숫자로만 된 문자열인 경우 안전한 numericStringTurn. 원래 문자열/배열/객체는 기록하지 않는다. 타입만 다르더라도 기존과 동일하게 실패 처리하고 검증 완화/자동값덮어쓰기 없음.
- runner→sessionSummary/memoryMetrics→safe API→실패JSON 저장/재검증까지 전달. 과거 결과에 없는 이 값을 소급 복원하지 않으며 새 작업부터 기록한다. 예 expected13/returnedType:string/numericStringTurn13과 expected13/returnedType:number/returnedTurn2를 구분 가능.
- 합성 숫자·숫자문자열·누락·임의본문·객체·null·소수 cases 및 실제 background runner 전달, 파일archive재조회 검증. ST339/339 통과; 로그 ST_TURN_DIAGNOSTICS_TESTS.log. 이 변경은 관측만 강화하며 당시운영실패원인의확정/수정은아직아님.


#### 과거 혼합 이력의 번호 대조 (내용 없음)
- runner가 정확한 server-built writer payload의 목표·이전경계·논리turn/role/source index와 server-side 원문행 좌표/auxiliary kind를 numberingDiagnostic으로 기록한다. 텍스트·인물·세계/스토리명·source id 문자열은 제외하고 배열최대128/truncated명시. 실제모델요청/검증기준은변경하지않음.
- GET /api/generation-jobs/diagnostics/failures/numbering: 최신종료turnmismatch의 당시summaryAnchor와현재archiveprefix hash일치를확인하고그당시길이까지만정규화하여 숫자좌표만복원. 이전context checkpoint는 실패시작전에완료되고scope/anchor가일치한기록만채택. 원문·기억본문은서버내기존함수에서처리되며API/분석결과로출력/저장하지않음. 이경로는원래nativearchive를서버내부에서읽으므로실패파일전용GET과구분하고명시적시스템메타데이터접근허용범위에서만사용한다.
- basis=UNCHANGED_ARCHIVE_RECONSTRUCTION / exactPayloadObserved=false로정확한과거모델입력capture가아님을표시. 당시내용수정/유효checkpoint부재/target불일치면고정reason으로거부. generation/복구/재시도/원문변경없음. 반환t가이전경계/선택turn/sourceindex에일치하는지,9와13각native행좌표를대조가능. 새runner계측은실제payload기록이며복원자료와혼동하지않음.
- 합성15턴에과거image/empty/연속user/assistant조각을삽입하여논리번호동일성,원문행번호차이,이전9/목표13구분,실제payload변조control,안전archive재조회/미허용필드제거,이력추가허용·과거편집복원거부검증. 전체ST343/343. ST_HISTORY_NUMBERING_TESTS.log. 실제운영9의기원은운영숫자복원조회전미확정.

### 2026-10-08 서버 관리 완료 경계 (source only, 미배포)

- accepted: 후처리 모델이 완료 턴 번호를 작성하지 않는다. 서버가 선택한 원문 구간의 끝을 해당 요청 결과에 연결한다. 기존 스토리/기억을 초기화하거나 실패한 모델 결과의 t를 덮어써 재사용하지 않는다.
- 기존 `compact-v2` 설정은 유지하되 새 요청은 `serverOwnedThroughTurn:true`와 응답 계약 `{v:4,s/e/k/x/o}`를 사용한다. `t`/`through_turn` 출력은 허용하지 않는다. 입력의 turn/source는 시간 순서·출처 의미로 남으며 requested_output에는 v만 지정한다. 실제 저장 categorized memory version4 및 through_turn/출처 형식은 변경하지 않는다. opt-in state-snapshot-v3와 legacy-v1은 별개로 유지한다.
- 서버 prepared의 previousRevision/throughTurn/sourceTable에 바인딩하여 전체 변경분 검증 후 체크포인트를 전진시킨다. 모델이 만든 범위로 요청 범위를 바꾸지 않는다. flag 없는 과거 compact v2 decoder는 이전 t 검증을 유지하며 새 요청에서 과거 v2 실패 결과는 거부한다.
- 기존 backlog는 마지막 성공 through_turn 이후부터 planner가 선택하며 cap별로 순차 처리한다. 실패 시 summary를 교체하지 않고 raw를 보존하므로 다음 정상 턴에서 같은 미처리 구간을 다시 시도한다. 자동 일괄 재시도 API/DB migration은 추가하지 않는다.
- 검증: 전체346/346 통과. 새 합성기존스토리(prev8/backlog20)에서 잘못된출처 실패→9~11 재시도 성공→12~14 추가정리, 최신상태 ON/OFF 각각 확인. legacy v2 반환 mismatch 검증·새 출력 t 거부·동일/역행/비정수 경계·stale checkpoint·부분병합거부 확인. 독립 read-only 리뷰에서 blocker 없음, 실제 provider의 length progress 전달 및 journal 원문 anchor/경합 guard 유지 확인.
- 운영8000/공유8001 미설치, 서비스 재시작·commit/push 없음. 실제 운영 기존스토리 복구·웹UI전체는 아직 검증하지 않았다. 모델 의미 누락/사건ID 재사용/사실성 정확도를 보장하는 패치는 아니다. 실모델 시험은 합성자료만 사용하며 결과는 integration/verification/turn-mismatch-20261008에 보존한다.

- 실모델 보완 결과: 같은 가상9~13턴 fixture를 native27B/non-thinking으로3회 실행. t/through_turn 출력0, 서버 완료 경계13 및 병합3/3통과(28.614/17.021/17.053s). 시간 비교/기억 의미 품질 판정은 아님. SERVER_OWNED_RESULT.md에 증거·제약 기록.
