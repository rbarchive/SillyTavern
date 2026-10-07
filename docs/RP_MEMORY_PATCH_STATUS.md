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
