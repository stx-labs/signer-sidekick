# Build audit round 4 — installable trusted-manager profiles (issue #5)

**Date:** July 16, 2026
**Scope:** the entire **uncommitted working tree** on `agent/v1-milestone-1` on top of `0a5b6a3` — the issue #5 implementation (installed-profile schema/store, reference-render proof, `manager trust` CLI, recognition tiers, eligibility audit/alerts, support-bundle surfaces, Compose mount, ADR 0006, Devnet trust scenario).
**Method:** two independent adversarial review passes (service/CLI/dashboard; store/bundle/harness/docs) plus first-hand mechanical verification: all local lanes re-executed, the cited Devnet acceptance evidence authenticated, a hostile-profile-directory probe run against the built loader, and — decisive for this round — a working **exploit reproduction** of the one major finding.

---

## Verdict

**The implementation genuinely delivers issue #5's design — but do not make the signed commit yet.** The proof is real (Sidekick independently re-renders from the pinned upstream and derives eligibility solely from built-in approval), the loader fails closed against every hostile input I threw at it, eligibility transitions are durable and alerted, the mount is read-only everywhere, the ADR records the trust root and the mainnet rule honestly, and the Devnet acceptance evidence is authentic — including a genuinely independent render (different deployer, different source hash, its own sBTC dependency deployments) transitioning `unrecognized → reference-render/verified` through the real CLI and a real restart.

**One confirmed major (T1) violates the feature's core invariant and I reproduced it mechanically:** a hand-crafted profile can inherit the devnet profile's `productionApproved: true` on testnet/regtest by naming the devnet upstream profile ID, because the verifier never binds the referenced upstream artifact's network to the profile's network. The fix is one guard line plus an adversarial test. Fix T1–T3 before the commit; T4/T5 need an explicit recorded decision.

---

## First-hand verification

| Check | Result |
| --- | --- |
| Lint + strict typecheck (`pnpm check`) | ✅ |
| Coverage lane | ✅ **188 tests** (33 files); 78.16 / 70.65 / 82.11 / 79.97 vs floors 77/70/81/79 |
| Clarinet regtest | ✅ 10 tests |
| Dashboard Playwright | ✅ 12 tests (new "explains the manager trust tier" spec at desktop/tablet/mobile) |
| Provenance verifiers | ✅ `protocol:verify` (all 8 generated artifacts incl. regtest set) · `devnet:verify:offline` |
| Acceptance evidence (`artifacts/1784206541283-1860/result.json`) | **Authentic**: runId ↔ `startedAt` epoch-consistent; `gitCommit` = HEAD `0a5b6a3`; all 5 image digests match the verified lock; `trustedManagerProfile` scenario shows an independent render (`ST2REH….signer-manager-alt`, source `239ec41e…` ≠ built-in `ca97d964…`, 3 sBTC dependency txids) going `unrecognized → reference-render`, `provenance: verified`, `automationEligible: true` (devnet-only approval, per the recorded D5 decision) |
| Hostile-profile probe (against built loader) | ✅ 6/6 fail-closed: symlink → rejected; 70 KB file → rejected; self-declared `productionApproved` → rejected (`unrecognized_keys`, the `.strict()` schema closes the self-approval loophole); mainnet profile with testnet principal → rejected; built-in source-hash shadow → rejected; the one valid profile loads |
| T1 exploit probe | **Reproduced** — see below |
| Leak mechanism (T2) | Confirmed: `JSON.parse('hunter2-my-secret…')` → `Unexpected token 'h', "hunter2-my"... is not valid JSON` |
| Mount / wiring | `compose.yaml` mounts `./trusted-managers` **`:ro`**; e2e and smoke bind mounts also read-only; settings update clears the source cache; `reorgedEvents > 0` invalidates per-manager; trust state recorded on the snapshot path; loss alert is **critical** ("Manager Degraded to Read-only") with stable dedup ID and persisted first reason/time |
| Environment note | Local Node 26 vs pinned 24.18 (engine warning only); CI runs the pinned toolchain |

---

## Findings

### Major (fix before the signed commit)

- **T1 · Cross-network `upstreamProfileId` lets a crafted profile inherit devnet's `productionApproved: true` on testnet/regtest — reproduced.** `proveReferenceRender` looks up the upstream artifact purely by `profile.reference.upstreamProfileId` and checks the upstream tag/commit/source-hash tuple — which is **identical across all three built-in profiles** — but never checks `upstreamArtifact.profile.network` against the profile's network. Eligibility is then taken from that artifact's `productionApproved`. My probe: a testnet `reference-render` profile with an attacker-chosen sBTC deployer, referencing `stacks-4.0.0-devnet-reference-manager`, passes the loader (no testnet built-in exists to shadow), the render proof genuinely reproduces, and the report returns `provenance: verified`, `automationEligible: true`, reason "reproducible from approved profile stacks-4.0.0-devnet…". Mainnet is protected only coincidentally (the canonical-principal guard forces hash-equality with the built-in, which the shadow check then rejects). Exposure requires write access to the operator's own profile directory and the tx-engine doesn't exist yet — but this is precisely the gate Phase 4 will trust. **Fix:** require `upstreamArtifact.profile.network === profile.network` in `proveReferenceRender`, mirror it in `createInstalledManagerProfile`, and land the adversarial test (the existing test named "does not inherit approval from an unrelated network profile" exercises only the CLI's benign upstream choice, not the verifier).

### Medium

- **T2 · Support bundle and startup logs can leak raw bytes of an unparseable profile file.** `manager-profile-store.ts` embeds `JSON.parse`'s error message in the `invalid-json` issue, and Node's message includes the first ~10 bytes of the input; issue messages flow verbatim into the support bundle and `server.log.warn`. A stray credentials/PEM file named `*.json` in the mounted directory leaks its prefix into a shareable artifact — the exact class the bundle's `explicit-allowlist` promise exists to prevent. **Fix:** sanitize `invalid-json`/`invalid-profile` messages (error name/position only, or truncate to non-content).
- **T3 · The most safety-critical branches have zero negative-test coverage.** (a) The **mainnet no-substitution guard** — in both `proveReferenceRender` and `createInstalledManagerProfile` — is exercised by no test; the schema deliberately only checks the sBTC deployer's SP/SM prefix, so these runtime guards are the whole mainnet defense, and a future refactor could drop them silently. (b) CLI guard rails untested: non-reproducible source **without** `--observe-only` must throw; `--observe-only` yields `custom-observe`; the `already-built-in` short-circuit; `inferReferencePrincipals` with 0 or >1 embedded deployers. (c) The generator's **wrong-replacement-count** throw has no test anywhere. (d) Schema negatives missing: mainnet + `networkId` rejection; `sbtcDeployer` network mismatch. All cheap to add; T1's fix test belongs in the same batch.
- **T4 · Trust-state recording happens only on the snapshot path — a headless/CLI deployment can lose eligibility silently.** `recordManagerTrustState` is called only in `OperatorService.load()`. `runSynchronization()` and every CLI command (`manager verify`, `events sync`, …) inspect the manager but never record; `serve` doesn't snapshot at startup and the container `HEALTHCHECK` hits `/health/live` (no snapshot). Dashboard and `/health/ready` users are covered; a cron-driven CLI operator gets no durable audit event until something requests a snapshot. **Fix:** record once at `serve` startup and on the sync path (the store call is idempotent and dedups).
- **T5 · Tier downgrades without an eligibility flip are not auditable.** The audit table's `CHECK (transition IN ('gained','lost'))` keys transitions solely off the `automation_eligible` boolean. A testnet `reference-render` (verified but unapproved → already ineligible) whose profile is deleted drops to `unrecognized` with no audit row — only the mutable state row changes. If the gained/lost taxonomy is the intended scope, record that decision; otherwise add a `tier-changed` transition.

### Minor

- The most recent transition backfills every snapshot forever (`trustTransition = recorded ?? trustAudit[0]`), so "Eligibility Gained" (info) or "Degraded to Read-only" (critical) is a permanent alert — every operator whose first observation is eligible sees a lifetime "gained" alert. Retire after acknowledgment/expiry, or retitle as "last transition".
- `recordManagerTrustState` reads previous state before `BEGIN IMMEDIATE` (check-then-act; currently safe because `load()` is serialized).
- `manager trust M --output --observe-only` parses `--observe-only` as the output path; `--observe-only` mode also hard-requires the pinned upstream source it doesn't need.
- ADR 0006 overclaims "wrong-network … profiles are ignored **with visible warnings**" — the loader emits no issue for a wrong-network profile (it just never matches), and the verifier's own network check is dead code behind the lookup pre-filter.
- `.dockerignore` doesn't exclude `trusted-managers/*.json` (`.gitignore` does); operator profiles enter the build stage on a local `docker compose build`, though not the final image.
- `source.match` can report `"exact"` while `recognized: false` (installed-profile hash matches but proof failed) — internally consistent, confusing in the support bundle.
- Playwright asserts only the built-in tier branch; render/custom/unrecognized UI branches are covered at the API level by the Devnet run only.
- A hand-edited `custom-observe` profile with `networkId` omitted matches any private network sharing the network name (still hash- and principal-bound).

### Info

The `unknown.manager?.attachAllowed !== true` assertion arm in the e2e trust scenario is unreachable (`manager verify` exits 2 first) — cosmetic. Devnet's `productionApproved: true` remains the recorded, commented D5 decision; mainnet and regtest remain `false`.

---

## Verified correct (beyond the table)

- **Profiles are data-only claims.** Strict schemas reject any self-declared approval (probed); `automationEligible` derives solely from the built-in upstream artifact's `productionApproved` after a reproducible render; the render profile passed to the generator hardcodes `productionApproved: false`.
- **The proof is independent.** Verification re-fetches deployed source from the configured node (never the API), re-renders from the pinned upstream with the built-in `expectedReplacements`, and requires deployed hashes to match both the profile's claim and the fresh render. The e2e scenario asserts exactly 13 substitutions against `devnet.json` and passes only because the generator reproduces the alternate deployment.
- **Fail-closed loading** across symlinks (`O_NOFOLLOW` + dirent check), oversize, >64 files, invalid JSON/schema, duplicates (all conflicting copies dropped), and built-in shadowing — probed and unit-tested; issues surface in serve logs, `doctor`, alerts, settings UI, and the support bundle (directory path redacted; audit history and profile contents excluded).
- **Cache semantics match the issue text:** per-process (restart invalidates), cleared on settings update, per-manager invalidation on detected reorg, hot-path per-broadcast field checks preserved, hit-avoids-refetch tested.
- **Eligibility is never silent on the product's primary surface:** durable immutable audit rows preserve first reason/time; loss is a critical alert with a stable dedup ID; restart transitions are detected against persisted state (tested).
- **The old `recognized` boolean no longer gates anything** — setup-status, activation-plan, and both dashboard surfaces switched to the four-tier model with accurate consequences copy; automation gating is exclusively `automationEligible`.
- **CLI safety:** no key material; atomic `O_EXCL`+`link` no-clobber profile writes (tested); custom profiles require explicit `--observe-only`.
- **ADR 0006** names the configured Stacks node as the proof's root of trust and states the mainnet rule ("operators cannot choose alternate mainnet PoX-5 or sBTC principals"); v1-plan updates are consistent; issues #2 and #5 updated.

---

## Recommended order

1. **Before the signed commit:** T1 (guard + adversarial test — the one change I'd insist on), T2 (message sanitization), T3 (the negative-test batch; T1's test belongs here).
2. **Decide and record:** T4 (record trust state at serve startup / on sync) and T5 (tier-change audit scope) — either fix or write the decision into ADR 0006 / the disposition.
3. **Next pass:** the minors, led by alert retirement and the ADR wrong-network wording.

After T1–T3, this is ready for the signed commit; re-running the coverage lane and one Devnet acceptance pass after the guard lands would close the loop.
