# Build audit — branch `agent/v1-milestone-1`

**Date:** July 14, 2026
**Audited at:** commit `83682cf` ("Move V1 follow-ups to GitHub issue"). Note: HEAD advanced from `b7cdd1c` to `83682cf` *during* the audit — the branch is being actively committed to; re-run the mechanical checks after significant new work.
**Method:** four independent full-source review passes (protocol package · core services/security · domain modules vs. the 4.0.0 contracts · docs/packaging/consistency), each tracing code against ground-truth copies of `pox-5.clar` and `signer-manager.clar` from the stacks-core `4.0.0` tag, plus first-hand mechanical verification: upstream hash comparison against GitHub, artifact regeneration determinism, full test/lint/typecheck/build run, and a live boot of the server with auth/bind/redaction probes. The headline finding (F1) was independently confirmed by the auditor by reading the code and test.

---

## Verdict

**This is a high-quality build.** The contract-provenance pipeline is exactly right, the security fundamentals are genuinely strong (timing-safe auth, strict schemas, parameterized SQL, per-source cursors, checksummed forward-only migrations, hardened container), all 109 tests / lint / typecheck / build / CI pass, and the domain modules' read-only calls match the 4.0.0 contracts name-for-name and argument-for-argument.

**No critical findings.** There are **5 major findings** — one product-logic gap (F1, the 50k-threshold early warning never fires), two security-hygiene items (F2, F3), one resilience gap (F4), and one documentation-anchor problem (F5) — plus a set of minors worth scheduling. Fix F1–F4 before any operator points this at mainnet.

---

## What was mechanically verified as correct (credit)

| Area | Result |
| --- | --- |
| Vendored `pox-5.clar` + `signer-manager.clar` | **Byte-identical** to the GitHub `4.0.0` tag (sha256 re-fetched + compared) |
| Generated mainnet artifact | Exactly the 8 `ST000…AMW42H.pox-5` → `SP000…2Q6VF78.pox-5` substitutions, nothing else; all 21 principal literals accounted for; sBTC principals correctly retained; `metadata.json` source/output hashes accurate; regeneration **bit-for-bit deterministic** (clean git diff); `productionApproved: false` gates automation |
| Tests / gates | 109/109 tests pass; `pnpm check` (biome + tsc) clean; build clean; CI runs verify-pins → check → test → regtest-compile → build → container build, all actions SHA-pinned, `permissions: contents: read` |
| Live security probe | Default bind `127.0.0.1` (unreachable on LAN iface); `/api/*` 401s without/with-wrong bearer token; timing-safe token compare; auth token and `STACKS_API_KEY` never appear in logs or CLI output (`apiKeyConfigured: true` only); no CORS; the single mutating route is bearer-header auth → CSRF-inert |
| Storage | WAL, STRICT tables, `PRIMARY KEY (chain_id, tx_id, event_index)`, forward-only sha256-checksummed migrations with pre-migration backup, all SQL parameterized, bigint/decimal-string amounts end-to-end |
| Domain ↔ contract fidelity | Every read-only call (14 pox-5 + 6 manager) matches name/args/decoding; `eligibleSharesAgree` reproduces the exact contract invariant; SIP-018 grant hash read live from the contract (immune to domain drift); real cross-checked signature fixture in tests; no hardcoded cycle boundaries; no wall-clock where burn height is required |
| Packaging | Non-root (uid 10001), read-only rootfs, `cap_drop: ALL`, `no-new-privileges`, tmpfs, healthcheck, compose publishes on `127.0.0.1` only; GPL-3.0 license + per-file provenance in `contracts/PROVENANCE.md` pinned to commit `5595f08a…` |
| Follow-ups hygiene | `docs/product/follow-ups.md` deletion is a clean migration to GitHub issue #2 (content preserved and expanded); commits signed |

---

## Major findings

### F1 — The 50k-threshold early warning never fires (product-logic gap) — **CONFIRMED FIRST-HAND**

`apps/sidekick/src/pool-forecast.ts:259-264` computes cycle `status` from four *evidence-consistency* checks only. `meetsThreshold` is computed (line 254) **but never feeds status**: a horizon cycle where positions expired (pending=0, delegated=0, `inSignerSet=false`) passes every consistency check and reports `ready`. `operator-service.ts:81-94` only alerts on forecast `attention`, and setup `attention` (which a below-threshold next cycle produces in `setup-status.ts:175`) doesn't alert either — only `blocked` does.

Net effect: the spec's required alerts (`v1-plan.md` §6.5: "Current or next-cycle signer-set amount below threshold" and "Forecast signer-set amount below threshold within the configured cycle horizon") **cannot fire in exactly the scenario they exist for** — the pool dropping below 50,000 STX as positions expire mid-horizon.

The test suite encodes the wrong behavior: `pool-forecast.test.ts:122-139` asserts `status: "ready"` for a cycle with `marginUstx: "-10000000000"` (−10,000 STX) and `meetsThreshold: false`.

**Fix:** make a threshold miss a first-class cycle condition (distinct from evidence inconsistency — e.g. `status: "below-threshold"` or an explicit alert on `meetsThreshold === false` for current/next/horizon cycles), alert on it in `buildAlerts`, and update the test to assert the flagged behavior. Consider whether setup `attention` should also produce an operator-visible alert.

### F2 — Operator `.env` (auth token, API key) is copied into Docker build layers

`.dockerignore` excludes `.git`, `node_modules`, `dist`, `data` — **but not `.env`**. `Dockerfile:13` does `COPY . .` in the build stage, and `docs/operator/deployment.md` instructs `cp .env.example .env` (real `SIDEKICK_AUTH_TOKEN` + optional `STACKS_API_KEY`) *before* `docker compose build`. The secret lands in local build-stage layers and any shared/pushed build cache. (Runtime stage is clean, which is why this is major, not critical.)

**Fix:** add `.env`, `.env.*`, and `backups/` to `.dockerignore`.

### F3 — Config silently ignores admin/signer key material; the spec says it must be rejected

`v1-plan.md` §13.3/§17 promise that admin/signer key fields "cause validation failure if supplied under common names." `apps/sidekick/src/config.ts:33-68` reads only its known env vars — `SIDEKICK_ADMIN_KEY`, `SIGNER_PRIVATE_KEY`, `STACKS_PRIVATE_KEY`, mnemonic/seed variables etc. are silently ignored, not rejected. (The operator-record schema layer does pin `managerAdminKeyHeldBySidekick: z.literal(false)` — good, but not the config-time guarantee.) This is a code↔spec contradiction on a headline security claim.

**Fix:** in `loadConfig`, scan the env for a documented deny-list of key-material names (optionally with value-shape heuristics like 64/66-char hex) and throw. Or, if deferred, soften the spec wording — but the check is cheap and the claim is load-bearing.

### F4 — API client has no retry, backoff, `Retry-After`, or error taxonomy

`apps/sidekick/src/chain-clients.ts:164-182` — `fetchJson` makes exactly one attempt and throws a flat `Error` on any non-OK response. A single 429 from the default (possibly keyless) Hiro endpoint aborts an entire `sync-stakers`/`events sync` run mid-flight, and 429 is indistinguishable from 500. The spec (§9.2) requires `Retry-After` handling, bounded backoff+jitter, and rate-limit visibility. Runs are resumable, which softens but doesn't fix this.

**Fix:** bounded retries (3–5) on 429/5xx/network errors with exponential backoff + jitter, honor `Retry-After`, and typed errors (`RateLimited`, `UpstreamUnavailable`, `SchemaMismatch`) so callers and future alerting can classify.

### F5 — The "master spec" path four documents anchor to has never existed in the repo

`design/HANDOFF.md` (lines 8, 40), `design/DESIGN-DELTAS.md` (line 3), and both review docs reference `pox5-operator-suite-spec.md`; `git log --all` shows that path was never committed. The spec lives as **`docs/product/v1-plan.md`** (every cited section number matches it), but no document says so. `round2-spec-review.md:5` also cites the prior review by a wrong filename (actual: `initial-spec-review.md`).

**Fix:** one alias line in each referencing doc ("the spec formerly circulated as `pox5-operator-suite-spec.md` is `docs/product/v1-plan.md`"), and correct the prior-review filename.

---

## Minor findings

### Correctness / protocol semantics

- **M1 · Prepare-phase off-by-one in "window open" guidance.** `preflight.ts:179-181` / `setup-status.ts:190-205` report the enrollment window open at `blocksUntilPreparePhase == 1`, but a tx submitted at tip = prepare-start − 1 executes at ≥ prepare-start and reverts with u47. Close the advertised window ≥1 block early (more under latency) or annotate the status.
- **M2 · `feeSnapshotBips: "0"` ambiguity.** `reward-status.ts:282` — `get-fee-bips-for-cycle` is `default-to u0`, so "no snapshot yet" and "genuine 0-bips snapshot" are indistinguishable, and the configured fee isn't surfaced alongside (spec §3.5). Null the field when no manager claim event exists for the cycle; report configured fee separately.
- **M3 · Historical-cycle reward status uses the active-only roster.** `reward-status.ts:165-169` filters `activeOnly=true`; a departed staker with unclaimed cycle-N rewards vanishes from that cycle's totals/actionable claims. Current callers only pass the current cycle, but the CLI accepts arbitrary cycles.
- **M4 · Test fixtures encode `reward_cycle_id` = next cycle.** `preflight.test.ts:146-149`, `enrollment-info.test.ts:27,35` set `reward_cycle_id: 141` with `current_cycle.id: 140`; in real `/v2/pox` they're equal. `enrollment-info.ts:222` publishes this field into the public enrollment document — fix the fixtures before the misunderstanding leaks into consumers.
- **M5 · Hex-case mismatch can hard-fail event sync.** API schemas accept uppercase hex (`chain-clients.ts:123,138-151` `/i`), store schemas are lowercase-only (`store.ts:405`), and `manager-event-sync.ts:167-201` passes values through unmodified. An API returning checksummed hex makes every sync throw (fail-closed availability landmine). Normalize `.toLowerCase()` at the client boundary.
- **M6 · `/v2/pox` uSTX fields parsed as JS numbers.** `chain-clients.ts:17-50` uses `z.number().int()` on `min_threshold_ustx`/`stacked_ustx`/`min_increment_ustx`. Safe today (max supply ≈1.82e15 < 2^53) but it's a JS-number protocol boundary the spec forbids, and nothing enforces the implicit supply-cap assumption. Parse from raw text bigint-aware, or add an explicit guard + comment.
- **M7 · signer-staker-sync aborts a whole run on a benign per-staker race.** `signer-staker-sync.ts:153-157` throws when a concurrent unstake/stake-update (or cycle rollover mid-run) breaks a single-tip invariant. Degrade to `stxNodeVerified: false` + discrepancy record (the pattern lines 103-121 already use).
- **M8 · manager-activity fallback path.** `manager-activity.ts:127-174` — 2,000-event truncation silently drops withdrawals whose initiating claim fell outside the window; same-block ordering ignores tx boundaries (`event_index` is per-tx). Fallback-only; the projected path is fine.

### Server / operational

- **M9 · 500s leak internals; async validation errors become 500s.** Fastify's default handler serializes `error.message` on 500s (upstream URL/paths, Zod dumps). Compounding: `server.ts:169,216,237,266,293` `return service.xxx(...)` inside `try{}` **without `await`**, so async rejections bypass the catch meant to produce 400s — e.g. `GET /api/v1/activity?rewardCycle=abc` → 500 with a Zod dump instead of a 400. Fix: `return await`, validate `rewardCycle` at the route, `setErrorHandler` with generic 5xx bodies.
- **M10 · `/metrics` is unauthenticated** (auth gate is `startsWith("/api/")`, `server.ts:96-106`) — violates the spec's "all non-health endpoints require auth" as written. Low exposure (three counters, loopback default), but either gate it or carve it out in the spec. Related (info): prefix-match auth means future non-`/api` routes are unauthenticated by default — prefer an encapsulated plugin scope.
- **M11 · Two non-transactional multi-table writes.** `store.ts:1624-1650` (`markIndexBlockNonCanonical`) and `store.ts:1271-1370` (`putChainEvent`+projection when not called via the page path) lack `BEGIN IMMEDIATE`. Crash between statements leaves the projection canonical while the base event isn't (self-healing on rerun, but wrap them like every other multi-statement method).
- **M12 · `snapshot(force=true)` can return stale pre-sync data.** `operator-service.ts:126-142` joins an in-flight load that started before `runSynchronization` wrote; `POST /api/v1/sync` can respond `{result: fresh, snapshot: stale}`. Track load epoch or re-load after sync.
- **M13 · The `.env.example` placeholder token passes the only strength check** (41 chars ≥ 24). Reject known placeholder values at startup.

### Protocol package hardening (all bounded today by the pinned mainnet profile + `productionApproved` gating)

- **M14 · `generate-manager.ts:22`** — if `--output` doesn't end in `.clar`, `metadataPath === outputPath` and the metadata JSON silently overwrites the just-written contract. Assert the extension.
- **M15 · `manager-artifact.ts:61-65`** — sequential split/join substitution is order-dependent; a profile whose pox5 principal embeds the upstream sBTC deployer substring would be corrupted *and pass all residual checks* (counts are computed pre-substitution). Single-pass replace or post-assert `occurrenceCount(generated, profile.contracts.pox5) === expected`.
- **M16 · `profile.ts`** — no principal↔network cross-validation (accepts `network: "mainnet"` with a testnet pox5, or any contract posing as pox-5); address regex accepts non-c32 chars and skips the checksum validator that already exists in `principals.ts`. Enforce the canonical boot address per network.
- **M17 · Contract-name validation wrong in both validators** — `principals.ts:3` allows 128 chars (consensus limit 40); `profile.ts:3` caps at 40 but rejects underscores (valid in Clarity). Share one pattern: `^[a-zA-Z]([a-zA-Z0-9]|[-_]){0,39}$`.
- **M18 · The real sBTC-substitution branch has zero test coverage** (mainnet is an identity replacement). Add a synthetic/regtest-profile generation test.

### Documentation / licensing / process

- **M19 · ADR numbering collision** — two "ADR 0002" files (`0002-protocol-profiles.md`, `0002-sqlite-persistence.md`). Renumber one and fix the README link.
- **M20 · Reward-pause: record the M4 error-classification intent.** The descope is a product-owner decision and is now consistently recorded (HANDOFF, DESIGN-DELTAS §6.1 `REJECTED`, disposition F1, zero code references) — this audit does not contest it. One gap remains: when M4 automation ships, a claim failing with `u53` needs *some* documented classification (even just "generic failure, normal bounded retry then alert") so the retry/fee-escalation engine's behavior against a permanent condition is a decision rather than an accident. Also add a "superseded by disposition" banner on `round2-spec-review.md` F1 so its "must fix" verdict isn't mistaken for a live requirement.
- **M21 · Stale hand-off wording.** `design/HANDOFF.md:40` says the DESIGN-DELTAS §8 spec edits are "not yet applied" — they mostly **are** (v1-plan already has the §2.4 carve-out, §5.5 generate-don't-host, §8.4 signer endpoint, §12 Settings, no `/pool` route). Two genuinely missing: the signer version/liveness endpoint row in the **§20 launch-blocker table**, and a §14 trust-model note for the probe. Apply those two, then flip the HANDOFF/DELTAS wording.
- **M22 · `team-questions.md` omits two GA questions** from HANDOFF's confirm-before-GA list: the signer version/liveness endpoint+field, and which per-cycle read-onlys expose future cycles for the forecast. Add both so external reviewers actually see them.
- **M23 · Font licensing incomplete.** `design/fonts/` redistributes Instrument Sans and Open Sauce Sans (both SIL OFL — the license text must accompany the fonts) with no license files; NOTICE.md names only Matter/Matter Mono. Add OFL texts and extend NOTICE.
- **M24 · GPL corresponding-source mechanism undocumented.** The obligation is named (v1-plan §15.5/§18, OCI source label present) but no doc states *how* corresponding source maps to a published image (tag ↔ signed commit). One paragraph in NOTICE.md. Non-violating today (no image published).
- **M25 · Compose drifts from the plan's stated secret-mount default** (env vars instead of a `secrets:` mount; defensible pre-automation since no gas key exists yet). Add the one-line note in deployment.md, or Compose `secrets:` support.
- **M26 · Dashboard production CSS lives in the mockup folder.** `apps/dashboard/src/main.tsx:27-28` imports `../../../design/tokens/tokens.css` **and `../../../design/screens/_app.css`** — the mockup-support stylesheet is now production CSS. Editing a mockup can silently restyle the product. Either promote `_app.css` into `apps/dashboard/` (or a shared package) or explicitly document `design/screens/_app.css` as production-owned.
- **M27 · CI never runs on this branch's pushes.** `ci.yml` triggers on `pull_request` and pushes to `main` only — direct pushes to `agent/v1-milestone-1` get no CI unless a PR is open. Add the branch (or `branches: ["**"]`) or open the PR early.

### Info-level (no action required, listed for awareness)

engines exact-pin (`node: 24.18.0`) produces warnings on any other Node without enforcing anything · `/healthz` exists but is undocumented (docs list `/health/live|ready`) · `SIDEKICK_HTTP_PORT=3998garbage` parses as 3998 · test files are excluded from typecheck (`tsconfig` excludes `*.test.ts`; vitest 4 doesn't typecheck) · testnet/devnet/regtest share chain-id `0x80000000` so cross-network agreement checks can't distinguish them · `manager-event-sync.ts:139-150` overlap-stop writes checkpoint metadata from the oldest scanned page (informational fields only) · `claimableByPolicy` at `earned == maxFee` initiates a 0-amount withdrawal that will revert as sBTC dust (operator dust threshold not yet applied, spec anticipates it) · forecast horizon counts the current (already frozen) cycle, so `6` ≈ 5 influenceable cycles · Docker image sets `SIDEKICK_HTTP_HOST=0.0.0.0` (compose confines it to `127.0.0.1`, but a bare `-p 3998:3998` exposes the API guarded only by the bearer token — README warning) · v1-plan §8.2 defaults are stale vs. ADRs (Drizzle → node:sqlite per ADR; Playwright/React-Aria-or-Radix never adopted, no ADR) · milestone ordering drifted (M2/M3 shipped while M1's regtest-lifecycle exit criterion is still open — disclosed honestly in README/dev docs, but §16's gating no longer matches delivery order) · no encoder exists yet for the staker `signer-calldata` wire format (only a decoder) — needed only if the product ever *builds* stake transactions, which is currently out of scope.

---

## Suggested fix order

1. **Now (correctness/security):** F1 (threshold alert + test), F2 (`.dockerignore`), F3 (key-material deny-list), F4 (retry/backoff), M9 (`return await` + error handler), M5 (hex normalization).
2. **Before external review / sharing:** F5 + M19–M22 (doc anchors, ADR numbering, HANDOFF staleness, team questions), M23–M24 (licensing).
3. **Before non-mainnet profiles or automation (M4):** M14–M18 (protocol hardening), M20 (u53 classification note), M1–M3 (window/fee/roster semantics), M7 (sync race), M11–M13.
4. **Housekeeping when convenient:** M6, M8, M25–M27, info items.

---

## Scope notes

- The design mockups (`design/screens/*.html`) were not re-audited here; they are reference material. Their one production-relevant coupling is M26.
- The audit ran while the branch was being actively committed; findings reference the code at `83682cf`. Anything landed after that commit is unaudited.
- No automation/tx-engine code exists yet (M4 scope) — nonce management, job idempotency, and post-condition enforcement were therefore not auditable and remain the highest-risk future surface. The spec's §11 requirements stand.
