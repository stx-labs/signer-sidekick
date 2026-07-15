# Build audit round 2 — Phase 1 lifecycle + Phase 2 hardening + Phase 3 onboarding/config

**Date:** July 15, 2026
**Audited at:** commit `032ba25` ("Complete Phase 1 lifecycle and Phase 2 hardening"), covering `83682cf..032ba25`. **Extended** (§Phase 3 below) to commit `b476ba0` ("Implement Phase 3 onboarding and configuration"), covering `032ba25..b476ba0`.
**Prior audit:** [`build-audit-2026-07-14.md`](build-audit-2026-07-14.md) (at `83682cf`).
**Method:** same as round 1 — independent full-source review passes (one verifying every prior finding's fix from the diff and hunting regressions in the hardening code; one deep-dive on the new regtest/Clarinet lifecycle harness) plus first-hand mechanical verification: live-chain provenance checks, full suite + lifecycle run, lint/typecheck/build, artifact-regeneration determinism, and live server probes of the changed security behaviors.

> **Working-tree advisory:** uncommitted **Phase-3 WIP** was landing in the tree while this audit ran (`onboarding-service.ts`, `pool-card.ts`, `runtime-settings.ts`, `phase3.tsx`, migration 8, enrollment `officialPlatforms`) and currently fails 2 tests (`store.test.ts` expects `schemaVersion: 7`; `enrollment-info.test.ts` expects the old Leather URL). That WIP is **out of scope** here and unaudited — but update those test expectations before committing. Everything below refers to `032ba25`, where the full suite is green.

---

## Verdict

**Excellent response round.** 27 of the 32 prior findings are correctly and verifiably fixed — with real behavioral test assertions, not mirrored ones — including all five majors. The new regtest lifecycle harness is genuine, hermetic, and honest: fixture provenance is airtight (verified against the live chain), signatures are real secp256k1, and expected reward values are hand-derivable from contract constants.

**Remaining gaps, in order of importance:** (1) the lifecycle suite covers 6 of 12 §15.2 contract paths in full — the Milestone-1 exit criterion is not yet met, though the docs disclose this honestly; (2) `OperatorService` — the exact file this round changed twice — has zero unit-test coverage; (3) a handful of low-severity residuals in the new retry/store code; (4) M27 (CI on branch pushes), M20's u53 note, and three info items remain open.

---

## Mechanical verification (first-hand)

| Check | Result |
| --- | --- |
| Vendored sBTC contracts (`sbtc-registry/token/deposit/withdrawal`) | **Byte-match the live deployed mainnet sources** — re-fetched from `api.mainnet.hiro.so/v2/contracts/source/SM3VD…JFQ4/*` and hashed; all four match PROVENANCE.md exactly |
| Regtest pox-5 fixture | Differs from canonical 4.0.0 in **exactly 12 lines — all sBTC-deployer principal substitutions**; no constants, heights, or logic touched; generator hard-fails on count drift |
| Regtest manager artifact | Exactly 13 sBTC-deployer substitutions; pox-5 refs correctly untouched (upstream already targets the testnet boot address); hashes consistent across artifact/metadata/verifier/`known-managers.ts`; `productionApproved: false` |
| `verify-upstream.mjs` | Extended to **12 pinned artifacts**, all pass |
| Regeneration determinism | `generate-regtest-contracts.mjs` re-run → clean git diff |
| Test suite | 134 unit/integration tests pass (30 protocol + 104 sidekick, up from 109) + **6 lifecycle tests pass in ~1.4 s, hermetic** (verified: runs with the requirements cache deleted, no network) |
| Gates | lint + typecheck + build clean; lifecycle suite wired into `pnpm test:regtest` and CI |
| Live probes | `SIGNER_PRIVATE_KEY`/`SIDEKICK_ADMIN_KEY` → hard startup failure (F3 ✅) · placeholder token rejected (M13 ✅) · `rewardCycle=abc` → clean `400 {"error":"invalid_query"}`, no internals in 5xx bodies (M9 ✅) · retry taxonomy live: `UpstreamUnavailableError … after 4 attempts` (F4 ✅) · `/health/live` 200 + `/health/ready` correctly 503 with node down · `/metrics` still open without auth (see M10) |

---

## Prior-findings scoreboard

**Majors: 5/5 fixed.**

| ID | Status | Notes |
| --- | --- | --- |
| F1 threshold alert | **FIXED** | `meetsThreshold` now feeds cycle status (`pool-forecast.ts:267`); distinct "Pool Below Signer-Set Threshold" alert in `buildAlerts`; test flipped to assert `attention` at −10,000 STX. Two follow-ons: P2-1, P2-2 below |
| F2 `.env` in image | **FIXED** | `.dockerignore` now has `.env`, `.env.*`, `!.env.example`, `backups` |
| F3 key-material rejection | **FIXED, verified live** | 15-name deny-list, exact-name match (no false positives), hard failure on non-blank value, tested |
| F4 retry/backoff | **FIXED, verified live** | 4 attempts, exp backoff 250ms·2ⁿ capped 5s ±25% jitter, `Retry-After` as seconds *and* HTTP-date (sleep capped 30s), typed error taxonomy, real tests. Residuals: P2-3, P2-4 |
| F5 spec anchor | **FIXED** | Alias lines in all four docs; prior-review filename corrected |

**Minors: 20 fixed · 1 documented-accepted · 1 partial · 1 not fixed · 3 info open.**

- **Fixed with quality (spot-check highlights):** M1 (window closes at `blocksUntilPreparePhase <= 1`, tested at the boundary) · M2 (configured fee + nullable snapshot via new `decodeOptionalUInt`, migration 7, dashboard renders "Not snapshotted" vs real 0%) · M3 (cycle-scoped roster keeps departed stakers) · M5 (hex lowercased at the client boundary; store rejects non-lowercase) · M6 (`Number.isSafeInteger` refine, fails closed, tested) · M7 (all three race shapes degrade to `stxNodeVerified:false` + typed discrepancy; sync completes) · M8 (fallback reducer deleted; SQL CTE pagination; resolved withdrawals can't be truncation-dropped; intra-block ordering documented as a stable-compound-key decision) · M11 (savepoints, correctly nestable — no nested-BEGIN hazard) · M12 (force-snapshot ordering sound; untested → P2-1) · M13–M19, M21–M26 all fixed as recommended (incl. OFL texts shipped into the image, corresponding-source paragraph, single-pass substitution regex, c32+boot-address profile validation, shared 40-char contract-name pattern, synthetic sBTC-substitution test, `_app.css` declared production-owned).
- **M10 `/metrics` auth → documented accepted risk.** v1-plan §13.2 now explicitly states it's intentionally unauthenticated and must stay loopback/proxy-protected; there's a test asserting the behavior; compose confines to `127.0.0.1`; the Docker healthcheck uses `/health/live` so nothing breaks. Verified no prefix-bypass (`//api/...` 404s). Acceptable close-out. Residual caution: auth is still URL-prefix based — new surfaces must live under `/api/`.
- **M20 partial.** The superseded-banner is in place, but the requested one-sentence **u53/`ERR_REWARDS_PAUSED` classification note for M4** was not added anywhere. Still the cheapest insurance in this list: without it, the future retry/fee-escalation engine's behavior against a permanent on-chain condition is an accident waiting to be designed.
- **M27 not fixed.** CI still triggers only on PRs + pushes to `main` — this branch's pushes run no CI. (Open the PR early or add the branch.)
- **Info items still open:** `/healthz` undocumented · `SIDEKICK_HTTP_PORT=3998garbage` parses as 3998 · test files still excluded from typecheck (only the regtest suite gets `tsc --noEmit`).

---

## New findings this round

### Hardening code (apps/sidekick, packages/protocol)

- **P2-1 · MEDIUM — `OperatorService` has zero test coverage, including both changes made this round.** No test imports `operator-service.ts`. The F1 alert branch (`operator-service.ts:84-97`) and the M12 force-snapshot ordering fix (`:131-137`) are exactly the code changed in this round and are unexercised; the force fix's correctness rests on subtle `.finally`/microtask ordering that a refactor would silently break. Add `operator-service.test.ts`: buildAlerts (below-threshold vs generic attention vs setup-blocked) and a force-snapshot race (stale in-flight load → force returns post-sync data).
- **P2-2 · LOW — Threshold alert hardcodes "50,000 STX" in prose** (`operator-service.ts:93`), duplicating `POX5_SIGNER_SET_MIN_USTX`. Format from `cycle.threshold.thresholdUstx` so the copy can't drift from the constant.
- **P2-3 · LOW — Retryable/error responses' bodies are never consumed or cancelled** in `fetchJson` (`chain-clients.ts:266-272` and the throw paths). With undici, an unread body pins the socket until GC; a sustained 429/5xx storm across `load()`'s parallel read-only fan-out can exhaust the connection pool. `await response.body?.cancel()` before `continue`/`throw`.
- **P2-4 · LOW — Worst-case cumulative latency per fetch ≈130 s** (3×30s capped sleeps + 4×10s abort timeouts). `/health/ready` awaits a full snapshot fan-out, so readiness can hang for minutes in an upstream brownout — beyond typical probe timeouts. (The Docker healthcheck is safe — it uses `/health/live`.) Add an overall per-fetch or per-snapshot deadline well under 30s.
- **P2-5 · LOW — The reorg test doesn't cover the projection flip M11 was about.** `store.test.ts:171-198` asserts only `chain_events.canonical`; the `manager_activity_events` UPDATE (`store.ts:1700-1714`) could regress with no test failing. Seed a claim event, reorg its index block, assert `listManagerClaims` drops it.
- **P2-6 · INFO — `retryAfterMilliseconds` accepts non-decimal numeric strings** (`Number("0x10")` → 16s). Gate with `/^\d+$/`.

### Regtest lifecycle harness

- **P2-7 · MAJOR (coverage, not correctness) — §15.2 contract-path coverage is 6 covered / 3 partial / 3 missing.** Missing entirely: **threshold crossing both directions** (every stake is exactly 50,000 STX; the signer-set add/remove paths are never asserted), **both half-cycle calculations** in one reward cycle (`calculate-rewards` runs once per test), **permissionless races** (no duplicate-calculate/double-claim `ERR_DISTRIBUTION_ALREADY_COMPUTED`-style assertions), **prepare-phase rejection** (u47/u28 never exercised). Partial: `stake-update` never called; fee-snapshot **insert-only** semantics untested (no fee change between claim and payout); below-max-fee L1 rejection untested. Also: `calculate-rewards` and manager `claim-rewards` are invoked by the deployer/admin, so their permissionless property isn't demonstrated — use the third wallet. The harness primitives already support all of these; ~5 focused tests close the Milestone-1 exit criterion. **Credit:** the README and v1-plan §16 status honestly list what is and isn't covered — this is a disclosed gap, not a misrepresentation.
- **P2-8 · MINOR — No `print`-event payload assertions.** The sidekick ingester depends on the manager/pox-5 event shapes, and the harness is the only place they execute against real contracts. Assert `result.events` payloads for at least `stake`, `calculate-rewards`, and `claim-staker-rewards`.
- **P2-9 · MINOR — Duplicate pox-5 instance in the simnet.** `Clarinet.toml` declares `[contracts.pox-5]` *and* the plan boot-overrides the boot address, so a second full pox-5 is published at the deployer principal. Tests correctly target the boot address, but a mistyped contract id would hit a live copy and could still pass. Drop the `[contracts]` entry if the boot override suffices, or assert the deployer copy is never called.
- **P2-10 · MINOR — Stale mainnet requirements cache inside the harness dir** (`test/integration/regtest/.cache/requirements/` — leftovers from a pre-hermetic iteration; gitignored; suite passes without it). Delete to avoid confusion.
- **P2-11 · INFO** — Toy burnchain parameters (cycle=100 blocks) mean boundary arithmetic is only exercised at small scale — fine for simnet, add a comment · `sbtc-deposit.clar` fixture is tracked/hashed but never deployed by any test · the clarinet vitest environment uses a Vitest-4-deprecated option (`transformMode`) that will break on Vitest 5.

---

## Suggested fix order

1. **Close Milestone 1:** P2-7 (the ~5 missing lifecycle tests) + P2-8 (event payload assertions) — this is the last substance between the branch and the M1 exit criterion.
2. **Test the code you just changed:** P2-1 (OperatorService tests), P2-5 (reorg projection test).
3. **Small correctness/robustness:** P2-3 (body cancel), P2-4 (overall deadline), M20's u53 sentence, P2-2, P2-9, P2-10.
4. **Process:** M27 (CI on branch pushes — or open the PR now), `/healthz` doc line, P2-6, port parsing, test typecheck.
5. **Phase-3 WIP:** fix the 2 failing test expectations (`schemaVersion: 7→8`, Leather URL) before committing; flag for the next audit round.

---

## Scope notes

- This round audited only `83682cf..032ba25` plus fix-verification of all prior findings; round-1 conclusions about unchanged code stand.
- The uncommitted Phase-3 WIP in the working tree (onboarding service, runtime settings, pool card, migration 8, dashboard phase3.tsx) is **unaudited** — request a round-3 audit once committed.
- Still no automation/tx-engine code (M4) — nonce management, job idempotency, and post-condition enforcement remain the highest-risk unaudited future surface.

---

# Phase 3 addendum — onboarding & configuration (`032ba25..b476ba0`)

**Audited at:** commit `b476ba0` "Implement Phase 3 onboarding and configuration" (the WIP flagged in the Scope notes above is now committed and clean). New surface: `onboarding-service.ts`, `runtime-settings.ts`, `pool-card.ts` (+tests), 12 new API routes, store migration 8 (three new tables), a 1,502-line `apps/dashboard/src/phase3.tsx`, and `docs/architecture/onboarding-and-settings.md`.
**Method:** two independent review passes (backend services/security; dashboard/design) against the same contracts + design docs, plus first-hand live probes of every new route (auth, secret egress, injection, audit trail) and the pool-card generator source.

## Verdict

**Another strong phase, and the previous round's fixes held** — F1 threshold alert and M12 force-snapshot survived the `operator-service` refactor; the round-2 test advisory (schemaVersion 7→8, Leather URL) was resolved and the full suite is green (30 protocol + 113 sidekick + 6 lifecycle). The onboarding flow correctly reuses the existing preflight/activation/grant modules and preserves the trust model (principals + a config *path* only — never key material; every response carries explicit safety flags).

**No critical findings.** **One major** (`javascript:` URL scheme reaches the published pool card — cross-confirmed by both agents and reproduced first-hand) plus **two decisions the operator must ratify** (endpoint change not preflighted; API key now stored in SQLite). The rest are minors/polish. **P3-1 should be fixed before any operator generates a real card.**

## Mechanical verification (first-hand)

| Check | Result |
| --- | --- |
| Suite / gates | 30 + 113 + 6 tests pass; lint + `tsc -b` + dashboard build clean |
| Auth on all 12 new routes | Every one 401s without a token (probed `GET/PUT /settings`, `/onboarding*`, `/pool-card/generate`) — all sit under the `/api/` timing-safe hook |
| Secret egress | `GET /settings` returns `apiKeyConfigured: true` + `apiKeySource`, **never the key value**; audit rows store field *names* only |
| Settings audit trail | Works — revision increments, `changedFields` + `changedAt` recorded per write (reproduced live) |
| Embed API URL | Credentials/query/fragment rejected (`createPoolCardArtifact` throws) |
| Regressions | F1 alert present (`operator-service.ts:89-97`); M12 serialization intact; endpoint change re-binds per-source cursors via `runtimeContext()` |

## Findings

### P3-1 · MAJOR — `javascript:`/`data:` URLs pass settings validation and land in `href`s in the public pool card
Both agents independently, and I reproduced it: `z.url()` (installed zod 4.4.3) accepts `javascript:alert(1)` and `data:text/html,…` (verified by execution). `pool.websiteUrl` (`runtime-settings.ts:10-14`), `pool.leatherUrl` (`:48`), and the `enrollment-info.ts` URL fields all use bare `z.url()`; a `PUT /api/v1/settings` with `websiteUrl: "javascript:alert(1)"` returned **200 and persisted**. These flow into `pool-card.ts:117` (`<a href="${html(website)}">`) and `:121` (the "Open in Leather" button from `officialPlatforms[0].url`). `html()` escapes characters but **not the URL scheme**, so the generated artifact — which the operator publishes for pool members — ships a clickable script link. The dashboard preview itself is safe (React-escaped; snippet shown in `<pre>`, no `dangerouslySetInnerHTML`), and `displayName` is safe (entity-escaped in markup + `<` in the JSON block). The gap is specifically dangerous URL schemes in href-bearing fields.
- Caveat: operator-controlled (not third-party-injectable), and the link requires a click — but the victim is the pool's own visitors, and it's a trivially preventable validation gap on a security-sensitive artifact path.
- **Fix:** restrict scheme to `http(s)` at input — zod 4 `z.url({ protocol: /^https?$/ })` — on `websiteUrl`, `leatherUrl`, URL-form `supportContact`, and `officialPlatforms.url` in both `runtime-settings.ts` and `enrollment-info.ts`; add a defense-in-depth scheme check in `createPoolCardArtifact` before emitting any `href`; add a hostile-scheme test (current `pool-card.test.ts` only covers character escaping).

### P3-2 · MAJOR (decision to ratify) — endpoint replacement is not validated before switching
v1-plan line 911 says Sidekick "validates the replacement endpoint before switching." `RuntimeSettingsController.update()` (`runtime-settings.ts:299-301`) does syntactic URL parsing only and commits immediately; the new architecture doc quietly weakens this to "takes effect on the next operation" (`onboarding-and-settings.md:77`). A typo'd `nodeRpcUrl` is accepted and every snapshot/sync then fails until re-edited (recoverable — settings routes still work). **Fix:** run a preflight/`/v2/info` probe on the candidate endpoints inside `update()` and reject on failure, **or** amend the plan to record the deferred-validation behavior deliberately.

### P3-3 · MAJOR (decision to ratify) — API key stored plaintext in SQLite
Migration 8 adds `runtime_settings.api_key_secret TEXT`, written via the `apiKeyAction: "replace"` path. v1-plan §13.3/§14.2 model the API key as a *secret reference* (env/file/Docker-secret), never a DB column; the DB is precisely the artifact operators are told to back up. Egress is correctly blocked (never returned, not in support bundle — verified), so this is at-rest only, and the new doc acknowledges the DB "can contain this API credential." Still a deviation from the stated trust model. **Fix:** keep the key env/secret-reference-only (retain `apiKeyMode` metadata in the DB), or encrypt at rest, or amend §14.2 to record the accepted risk. (Note: distinct from the gas-payer key, which remains un-stored.)

### Minor

- **P3-4 · onboarding mutations have no audit trail.** v1-plan line 883 requires audit logging on mutating routes; settings writes get `settings_audit` rows, but the eight onboarding mutations only overwrite the singleton `onboarding_state` row — no who/when/what history (a `start` silently discards a completed wizard). Reuse the `settings_audit` pattern.
- **P3-5 · onboarding `state_json` not schema-validated on read.** `onboarding-service.ts:106,401` cast `stored.state as PersistedOnboardingData` with no zod parse (runtime-settings *is* parsed on read). A malformed/older-schema row throws inside `get()`, which is called unguarded in the summary route (`server.ts:353`) → 500s the dashboard's main endpoint. `safeParse` and treat failure as "no state."
- **P3-6 · `POST /onboarding/start` destroys progress on a misclick.** Dashboard (`phase3.tsx:385-393,436-449`) POSTs unconditionally — even re-clicking the active path — and the service nulls `activationPlan`/`freshInput`/`signerGrant` with no confirmation, discarding a verified signer-grant mid-ceremony. No-op when path is unchanged; confirm when progress exists. (Compounds P3-4.)
- **P3-7 · the expected SIP-018 grant hash is never shown in the UI.** The server returns `signerGrant.preparation.expectedMessageHashHex` and the mockup (`setup.html:87`) shows it with a `src-chain` dot for out-of-band comparison — the whole point of the ceremony UI — but `phase3.tsx:666-724` renders only the command and paste box. Render the expected hash as an identifier.
- **P3-8 · `supportContact` classified as email by `includes("@")`.** `operator-service.ts` `poolCard()` routes a settings-valid support URL containing `@` (or `mailto:`) to the `{email}` branch, which then fails `z.email()` in `enrollment-info.ts` → `pool_card_generation_failed` (400) for settings the settings endpoint accepted. Classify with `z.email().safeParse().success`.
- **P3-9 · static pool-card mode returns JSON only.** DESIGN-DELTAS §1.4 and `development.md` promise a static **HTML** variant "plus versioned JSON"; `createPoolCardArtifact` returns JSON for `static`, HTML only for `live`. Add a baked static-HTML render (suppress the live `<script>` — `cardHtml` is 95% there) and correct the doc.
- **P3-10 · dashboard drops server error detail.** `phase3.tsx:138` throws `Request failed with HTTP ${status}`, discarding the body (`invalid_runtime_settings`, gas-payer mismatch). Surface it. Also inconsistent 401 handling: the snapshot path clears the token and re-logs in; the new `api()` just shows a banner on a dead page (`phase3.tsx:129-140` vs `main.tsx:1478-1483`).
- **P3-11 · P2-1 still open, now worse.** No `operator-service.test.ts`; Phase 3 added `settings()`/`updateSettings()`/`poolCard()`/`runtimeContext()` to that untested file — and P3-8's integration bug lives in exactly the untested seam.
- **P3-12 · provenance dots absent from all three new pages.** DESIGN-DELTAS §5.1 + the mockups establish `src-*` markers on the source hash (`phase3.tsx:659-661`), grant hash (P3-7), and enrollment chain values; `main.tsx` uses them on equivalents. `phase3.tsx` has none.

### Info / polish
`forecast.horizonCycles` uses `Number()` per keystroke → `0`/`NaN` in state (the one numeric field not kept as a string; uSTX/sats are correctly stringy) · settings section-nav highlight is hardcoded to index 0 (`phase3.tsx:911`) · 20s onboarding auto-poll resets `selectedStep`, yanking the operator off the step they're reading · data-source badge shows raw `pass/warn/fail` machine tokens instead of "Connected" (mockup) · `GET /settings` lacks the try/catch its siblings have (500 vs intended 501); `PUT` maps all failures (incl. disk) to 400 · env-var precedence (stored settings win once a revision exists) is undocumented · `putRuntimeSettings` reads `revision` just outside its `BEGIN IMMEDIATE` (safe under today's single connection) · `formatUstx` duplicated (`phase3.tsx:1283`, `pool-card.ts:46`) · Leather URL change to `earn.leather.io` matches Leather's real Earn product (genuine correction, now operator-overridable).

## Verified correct (Phase 3)
- **Trust model preserved:** onboarding accepts only principals, contract name, auth id, and a config *path* (display-only, "Sidekick does not open or read this path"); strict zod; both paths pin to `SIDEKICK_MANAGER_PRINCIPAL`; forbidden key-material env vars still rejected; safety flags asserted in every response; the grant step shows exactly `stacks-signer generate-staking-signature --config … --signer-manager … --auth-id … --json` and never requests a key or config contents.
- **Secrets:** `publicSettings()` omits the key (test-asserted); `type=password`/`new-password`, cleared after save, keep/replace/clear model; key/token never in the DOM beyond the login field; support bundle unchanged allowlist.
- **Pool-card (all but schemes):** every interpolation HTML-escaped; JSON payload `<`-escaped so `</script>` can't break out; live mode fetches only unauthenticated `GET /v2/pox`; embed API URL rejects credentials/query/fragment; artifacts carry no key/gas-payer/DB data; the old client-side snippet that interpolated the principal **unescaped** is replaced by the escaped server artifact — a net security improvement.
- **Migration 8:** forward-only append, checksum-verified, backup-before-migrate intact and re-tested at v8; three new tables STRICT with CHECK + `json_valid`; runtime settings schema-parsed on read (onboarding state is the exception — P3-5).
- **Design system:** zero hard-coded hex/rgb/inline styles in `phase3.tsx`; the 111 new `styles.css` lines use `var(--…)` only; testnet remap intact; no emoji/exclamations; form-bearing sections use Form B. (The hard-coded palette inside `pool-card.ts` is correct — a self-contained external artifact that can't reference app tokens.)
- **Wizard fidelity:** fresh path matches `setup.html` step-for-step; `main.tsx` refactor moved Setup/Settings/Enrollment into `phase3.tsx` (not dropped); all 8 nav pages still route; no new dependencies; `tsc -b` clean; uSTX/sats formatted from strings via `BigInt`.

## Updated fix order (supersedes the round-2 list for open items)
1. **Before any operator generates a card:** P3-1 (URL scheme validation + test).
2. **Ratify or fix the two decisions:** P3-2 (endpoint preflight), P3-3 (API-key-at-rest) — each is "fix the code" or "amend the spec," not "ignore."
3. **Correctness/robustness:** P3-5 (onboarding state safeParse → don't 500 the summary), P3-8 (support-contact classify), P3-4/P3-6 (onboarding audit + no-op-on-same-path), P3-11 (OperatorService tests), P3-7 (grant hash in UI).
4. **Then the round-2 carry-overs still open:** P2-7 (close §15.2 lifecycle coverage — the last gate on Milestone 1), P2-3/P2-4 (fetch body cancel, snapshot deadline), M20 (u53 note), M27 (CI on branch pushes).
5. **Polish:** P3-9, P3-10, P3-12, and the info list.

## Scope notes (Phase 3)
- Working tree is clean at `b476ba0`; the suite is green.
- The automation/tx-engine (M4 — nonce management, job idempotency, post-conditions, and the reward/payout/withdrawal broadcast paths) still does not exist and remains the highest-risk unaudited future surface. Everything audited to date is read-only + manifest-generation + config; no operator funds move through any code path reviewed in rounds 1–3.
