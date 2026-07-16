# Build audit round 3 — released-environment Devnet harness (issue #3)

**Date:** July 15, 2026
**Scope:** branch `agent/issue-3-devnet-harness` — the entire **uncommitted working tree** on top of `819e66b` (= tip of `agent/v1-milestone-1`). Covers the E2E harness (`scripts/e2e-devnet.mjs`, `test/e2e/`), the coverage + dashboard-Playwright lanes, and ~220 lines of production-code change made to support the harness.
**Method:** two independent review passes (harness controller/actor/proxy/lock/workflow; production-code changes vs. the audited base) plus first-hand mechanical verification: all local lanes executed, coverage thresholds run, image digests re-verified against live registries, retained artifacts secret-scanned independently, the cited acceptance `result.json` authenticated, and the pagination fix **confirmed against the live mainnet Stacks API**.

---

## Verdict

**The harness is genuine, well-built, and delivers issue #3's core scope — and it has already paid for itself.** Within its first runs it surfaced a **real production bug that every previous audited-green build carried**: manager event-sync paginated by the wrong cursor field and would silently stop after one page against the real Stacks API (fixtures had encoded the same wrong assumption, so no fixture-based lane could ever catch it). The fix is verified correct against the live API. This is precisely the class of defect the issue predicted only a released-environment lane could find.

The no-key trust boundary is genuinely enforced (external actor deploys **the artifact Sidekick generated**, hash-checked against the lock), the digest lock is **consumed by Clarinet at run time** (not decorative — the verifier asserts the settings file contains each `reference@digest`), restart/pagination/replay scenarios prove what they claim, and the cited acceptance evidence is authentic.

**Before commit:** fix the two artifact-hygiene majors (D1, D2), the cleanup gap (D3), and resolve the `productionApproved` drift (D5). None are architectural.

---

## First-hand verification

| Check | Result |
| --- | --- |
| Local lanes | **169 unit/integration** (31 protocol + 138 sidekick) ✅ · **10 Clarinet simnet** ✅ · **9 dashboard Playwright** ✅ · lint/typecheck/build/protocol-provenance ✅ |
| Coverage lane | Real and enforced: v8 provider, thresholds 77/70/81/79 vs. actual **77.9 / 70.9 / 81.6 / 79.8** — a proper ratchet floor (backend+protocol; dashboard covered via Playwright, honestly separated; `main.ts` + `generate-manager.ts` excluded) |
| Version lock | `verify-devnet-lock.mjs` passes; all 5 image digests **re-verified against live registries** (node/signer 4.0.0, API 9.0.1, bitcoind v27.2, postgres 17.6); Clarinet binary itself SHA-256-verified before use; `settings/Devnet.toml` pins `reference@digest` in the file Clarinet actually consumes |
| Acceptance evidence (`artifacts/1784162751181-40692/result.json`) | **Authentic**: from-genesis pass in 8m17s; `gitCommit` matches HEAD; versions block matches the lock; 9 transaction ids match the scenario code exactly; interruption statuses are Sidekick's own 500s (not the proxy's 503s — a detail a hand-writer would miss); serial resource-sampling counts consistent with the monitor implementation |
| Artifact hygiene (retained logs) | Independently grepped: no keys/mnemonics/tokens; only "private key" hits are the signer image's own BNS help text; artifacts dir correctly gitignored; Sidekick DB never copied out of its volume |
| Pagination fix | **Confirmed against live mainnet API**: first page returns `next_cursor: null`, `prev_cursor: <older>` — the new code direction is right, the old one was wrong |
| Full Docker run | **Not reproduced in this review environment** — judged from code + four retained run artifacts (two of which postdate the production fix and pass against the real API image) |

---

## The headline finding (credit, not a defect)

**D0 — Event-sync pagination was broken against production in every prior build; the harness caught it on first contact.**
Old code followed `next_cursor` and treated `null` as end-of-data. Against the real API v9, `next_cursor` is null on the *first* (newest) page — so backfill would stop after one page (`eventPageLimit` window) and silently miss all older manager events. Three independent confirmations: live mainnet API probe; the devnet run's API access log showing a multi-page drain via `cursor=…` after the fix; contract-log fixtures now modeling descending block heights. The unit-test change alone is a field-swap (would be tautological) — the E2E run is the real validation, which is exactly the point of this harness. **Both prior "verified correct" audit rows for event ingestion were wrong in this one respect; fixture-based verification could not have caught it.**

Same pattern, second bug: `signer-staker-sync` threw on a post-`unstake` roster entry. Verified against `pox-5.clar:1424-1451`: `unstake` does `map-set` (not delete) and `num-cycles = 0` is reachable when unstaking the cycle before rewards begin — the old throw aborted the entire reconciliation run. New behavior (`active:false`, node-verified absence) is contract-grounded, tested with real assertions, and preserves the round-1 M3 guarantee (departed stakers still appear in historical-cycle reward totals; no double-count).

---

## Findings

### Major (fix before commit / before CI enablement)

- **D1 · Secret scan is detection-only — its failure is swallowed and gates nothing.** `scripts/e2e-devnet.mjs:640` runs `scanArtifacts()` *after* all artifacts are written; in `test()` the call is wrapped `.catch(error => ({error}))` (`:861`), `result.status` is already `"pass"`, exit code stays 0, and the CI workflow's `upload-artifact` (`devnet-e2e.yml:52-59`, `if: always()`) uploads regardless. A detected leak would be uploaded anyway. **Fix:** scan before/while writing, and make a scan hit flip status to fail / delete the offending file, so the upload is actually gated.
- **D2 · Playwright live traces/videos are uploaded but never scanned — and they contain the live auth token.** `scanArtifacts()` covers `result.json` + logs only; CI uploads `playwright-report/` + `test-results/` with 30-day retention; the live spec types `state.authToken` into the credential field and `trace/video: retain-on-failure` captures both the typed value and `Authorization: Bearer …` headers. Token is ephemeral and destroyed on `down()` (bounds impact), but the issue's own requirement is scrubbed-and-scanned retained traces. **Fix:** scan/scrub the report dirs before upload, mask the credential field, or set trace/video off in CI.
- **D3 · Cleanup is not attempted on the most common failure path (local runs leak).** `state = await up()` only assigns on success; the `finally` guards `if (state)` — so a bootstrap timeout (network-ready/PoX-5/health waits) leaks Clarinet containers plus the *detached, unref()'d* proxy and resource-monitor processes spawned before the first `writeState`. CI is shielded by its separate `always()` down-step + ephemeral runners; local `e2e:devnet:test/up` is not. **Fix:** persist state/PIDs immediately after each spawn, and capture partial state so `finally` can always `down()`.
- **D4 · Injected-lag assertion is an exact-equality flake.** `failureInjection()` freezes an API status fixture at `burn_block_height − 2` while the node keeps auto-mining (~10s blocks); if the node advances between snapshot and sync, lag = 3 and the assertion (`=== 2`) fails the whole ~8-minute run — and harness scenarios have no retry wrapper. **Fix:** assert `burnBlockLag >= 2`, or pause mining around the assertion.

### Medium

- **D5 · Devnet manager profile flipped to `productionApproved: true` — the only `true` in the codebase — with stale generated metadata.** `known-managers.ts:45` + `profiles/devnet.json` say `true` (mainnet and regtest are `false`); the generated `metadata.json` still says `false` (the flip happened without regenerating, and nothing gates that). At runtime this makes a matched devnet manager automation-eligible. **Blast radius verified confined to devnet** — candidate selection is network-scoped and hash-matched, devnet hashes ≠ mainnet hashes, so no mainnet exposure. It's plausibly intentional (the E2E needs live flows where regtest simulates), but it must be a *recorded decision*: regenerate the devnet artifact so metadata agrees, and extend the verifier to assert profile↔metadata `productionApproved` sync plus `metadata.outputSha256 == lock.manager.sha256`.

### Minor

- **D6 ·** Wall-clock auto-mining (`automining_disabled = false`, ~10s) contradicts the issue's "mine one block, wait for catch-up" determinism model; the `mine` command can race the auto-miner (tip jumps >1). Correctness holds via `waitForTip`/`waitForTransaction`, but flip to explicit block driving or amend the issue text. (Feeds D4.)
- **D7 ·** `up` doesn't reap a prior crashed run's containers/volumes (fixed compose project name + fixed host ports → collision; the old run's differently-named volume is never removed). Run the `down()` reap at the start of `up`.
- **D8 ·** Failure-injection proxies bind `0.0.0.0` (needed for `host.docker.internal`) — an unauthenticated LAN pass-through to node/API while the harness runs. Control port is correctly loopback. Bind to the docker bridge or document the exposure.
- **D9 ·** `scanArtifacts` hardcodes the signer key literal and omits the eight devnet BIP-39 mnemonics from `Devnet.toml` (documented public fixtures, so low impact). Derive the forbidden set from config.
- **D10 ·** `versions.lock` verifier doesn't cover the manager profile/metadata (see D5 fix).

### Info

`--keep-on-failure` is argv-honored anywhere (CI just never passes it) · the proxy's single-pass `fail-after` token can be consumed by a concurrent background poll (latent nondeterminism) · reorg remains unexercised — `reorgedEvents` is structurally always 0 (matches the disclosed Phase-6 stretch status; just don't count that field as coverage) · `timings.restart = 1.4s` is plausible-but-fast (cached image + 500ms health poll) · acceptance run was local darwin/arm64 — the "first GitHub Actions execution" remains genuinely unvalidated, as disclosed.

---

## Verified correct (beyond the table above)

- **No-key boundary:** Sidekick's container env carries only URLs, manager principal, and its own auth token; all signing lives in the external actor; `freshSetup` downloads Sidekick's generated artifact, hash-checks it against the lock, and deploys **that exact source**; grant JSON is public-fields-only, 0600, deleted in `finally`.
- **Readiness model:** gates on Clarinet ready-log → node chain/PoX-5 (`.pox-5` contract id) → API indexed **through the node's live burn tip** → register-self via node reads. No fixed sleeps as readiness (only a 2s SIGINT grace in teardown).
- **Scenarios prove their claims:** restart = real `docker rm --force` + fresh container on the same named volume; interrupted-sync resume asserted via `resumed` flags after real mid-pagination kills; pagination at page-limit-1 over real multi-page data; replay idempotency (`newEvents === 0`); failure-injection actor talks directly to node/API while only Sidekick traverses the proxies (correct scoping).
- **Production-code changes:** page-limit config defaults exactly preserve prior behavior; `inspectManagerOrReportMissing` catches **404 only** (everything else re-throws) and can only degrade toward observe; store change binds the pre-existing `active` column (no DDL); devnet artifact hash recomputed and consistent across profile/known-managers/metadata/result.json.

---

## Recommended order

1. **Before committing the branch:** D1, D2, D3 (hygiene + cleanup), D5 (regenerate metadata + record the intent), D4 (`>=` assertion).
2. **With the first CI run** (disclosed as pending): confirm runner resources against the measured envelope (~8min, 34 serial samples locally), and verify the `always()` down-step actually reaps on a mid-bootstrap failure (D3's CI shield).
3. **Later:** D6–D10, and keep reorg (Phase 6) + live reward-withdrawal lifecycle + CTO artifact confirmation on the open list — all three were disclosed as remaining and this audit confirms that status.

## Scope notes

- The full Docker devnet run was not reproduced in this environment; authenticity was established from code-artifact cross-checks and the live-API confirmation of the pagination fix. The first scheduled GitHub Actions run is the remaining execution-environment unknown.
- With this branch, the four-lane coverage model from the roadmap is now: instrumentation ✅ (thresholds enforced) · dashboard ✅ (9 fixture Playwright + live spec) · released-env E2E ✅ (this harness) · **M4 tx-engine — still future**, and still the surface where the coverage bar must be highest when it lands.
