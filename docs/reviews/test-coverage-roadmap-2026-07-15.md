# Latest-commits review + path to total automated coverage

**Date:** July 15, 2026 · **HEAD:** `819e66b` (branch `agent/v1-milestone-1`, pushed) · covers `b476ba0..819e66b` plus a coverage assessment of the whole app and a review of [issue #3](https://github.com/stx-labs/signer-sidekick/issues/3).

---

## 1. Latest commits (`b476ba0..819e66b`) — verdict: clean, all shipped with tests

Suite at HEAD: **175 tests green** (30 protocol + 135 sidekick + 10 Clarinet lifecycle); lint + strict TS + build + container build all pass.

| Commit | What | Assessment |
|---|---|---|
| `4ffb937` Address Phase 2/3 audit findings | The remediation re-reviewed last round | Verified first-hand previously (URL-scheme guard, endpoint preflight, onboarding audit/safeParse, etc.). No change. |
| `6be0d15` Allow operators to skip guided onboarding | New "skip onboarding" path | +35 onboarding-service tests, +server wiring. Trust model intact (no keys). |
| `32f0e9e` Allow overriding network ID | `SIDEKICK_NETWORK_ID` override | +29 config tests. Watch: this loosens the network-agreement guard — see finding C1. |
| `e27a992` Fix long-lived PoX-5 position reconciliation | Reconciliation correctness fix | +65 signer-staker-sync test lines; the fix came with its regression test. Good. |
| `819e66b` Add external + container test harness coverage | `test:regtest:external`, `test:container:external`, `smoke-container.mjs` | The read-only halves of the issue-#3 lanes; correctly opt-in (env-gated). |

**One thing to check (C1, minor):** `32f0e9e` adds `SIDEKICK_NETWORK_ID` to override the chain-id used in the node↔API agreement check. That check is a load-bearing safety guard (round-1 req 7). Confirm the override is (a) validated, (b) logged/surfaced when set, and (c) documented as a test/devnet affordance — an operator who sets it wrong silently disables cross-network protection. It exists precisely because devnets don't use the standard testnet chain-id, so it's legitimate; just make its blast radius explicit.

---

## 2. Current coverage baseline (the honest picture)

Coverage today is **strong at the layers that exist, with two structural holes and no measurement**:

| Layer | State | Notes |
|---|---|---|
| `packages/protocol` | **Excellent** | Codecs, artifact generation, adapters — 30 tests; every protocol boundary bigint-safe; contract fixtures hash-verified against the live chain. |
| `apps/sidekick` backend | **Excellent (file-level)** | 46/47 source files have a colocated `.test.ts`. Only `main.ts` (CLI arg dispatch) is untested. |
| Clarinet lifecycle | **Complete for §15.2** | 10 deterministic simnet tests cover every listed contract path (real secp256k1 sigs, hand-derived values). |
| **`apps/dashboard`** | **ZERO tests** | ~2,600 lines (`main.tsx` + `phase3.tsx`) — settings writes, onboarding wizard, pool-card generation/preview, auth/401 handling, provenance rendering — none exercised by any automated test. **This is the single biggest gap.** |
| External / container lanes | **Exist, opt-in, no environment** | `test:regtest:external` (RUN_REGTEST-gated) and `test:container:external` are real but require an operator-supplied live network + Docker; they don't (can't) run in standard CI. |
| **Coverage instrumentation** | **None** | No `@vitest/coverage-v8`, no threshold gate. "175 tests" is a count, not a measured %. There is no automated signal when a new file or branch ships untested. |
| M4 automation / tx-engine | **Does not exist** | Nonce mgmt, job idempotency, post-conditions, the claim/payout/withdrawal broadcasts — the highest-risk surface, and untestable until built. |

**Reframe on "total":** 100% line coverage is the wrong target — it rewards testing trivial getters and still misses the risks that matter (a real signer binary rejecting a grant, the API indexer lagging, a reorg, funds moving). "Total automated coverage" for this app means **every risk surface is covered at the layer that can actually exercise it**, with an instrumented floor that fails CI when coverage drops. The gap to that is four concrete lanes below.

---

## 3. Issue #3 review — correct lane, well-scoped; it's necessary but not sufficient

Issue #3 (released-environment E2E harness) is **exactly the right next lane** and is well-specified. Its value is that it covers what nothing else in the suite can:

- The **Fresh Setup ceremony against the real released `stacks-signer` binary** — the Clarinet lifecycle uses in-process secp256k1 signing, so the actual `generate-staking-signature` command/output path is currently unexercised end-to-end. This is a standing "confirm before GA" item in the hand-off.
- **Real API event indexing** — Clarinet asserts contract `print` payloads in-process, but the Stacks API v9 indexer turning those into the endpoints Sidekick reads (roster enumeration, contract-log pagination) is only tested against fixtures today.
- **Restart/cursor resume, pagination, overlap replay, and (if practical) an induced reorg** — the reconciliation guarantees the whole design rests on, against a moving chain rather than a static simnet.

The scenario checklist maps cleanly to the real validation gaps, and the delivery recommendations are right: **opt-in/scheduled (not per-PR), pinned binaries, one-command up/test/cleanup, reuse the existing `:external` lanes as the assertions.** That last point matters — `819e66b` already built those assertion lanes, so #3 is mostly "stand up the environment and wire the ceremony," not new assertion code.

**On its open decisions, my recommendations:**
- **Ephemeral local devnet vs shared private env → ephemeral-first, with the shared private-1 as the documented fallback (as the issue already proposes).** Ephemeral wins on determinism, hermeticity, and the ability to *induce* pagination/reorg — which a shared env can't do on demand. The issue's own fallback note covers the case where spinning a full devnet is impractical.
- **Pinned versions:** record `stacks-node`, `stacks-signer`, API v9+, and sBTC image digests in the machine-readable result (the issue asks for this — make it a hard requirement; a green E2E against unknown versions is nearly worthless for a July-29 launch target).
- **Signing/funding isolation:** keep the harness's test-account keys entirely outside Sidekick's config surface (the config deny-list already rejects key material — assert that the harness never sets those env vars).
- **Reorg:** treat as best-effort (the issue says "if practical") — don't block the harness landing on it; a deterministic pagination/restart test is the must-have, reorg is the stretch.

**But #3 is one of four lanes**, not the whole goal. It deepens *integration* coverage; it does nothing for the dashboard hole or the missing instrumentation.

---

## 4. Roadmap to total coverage (priority order)

1. **Instrument coverage + set a floor (small, do first).** Add `@vitest/coverage-v8`, emit `text-summary` + `lcov`, and add a CI threshold (start at the current backend level so it can only go up; exclude generated fixtures and `main.ts` bootstrap). Without this, "total coverage" is unmeasurable and unenforceable — every subsequent lane should move a visible number.
2. **Dashboard tests (biggest hole).** Two sub-lanes: (a) **component/interaction tests** (Vitest + React Testing Library) for the settings form (validation, keep/replace/clear key action, error surfacing), the onboarding wizard state machine, pool-card generation/preview escaping, and 401→re-login; (b) a thin **browser E2E** (Playwright) that drives login → each screen against a mocked or fixtured API, asserting no console errors, the 390px layout, and that no secret renders in the DOM. Design-system rules (tokens, no hard-coded hex) are lintable — consider a Stylelint rule so that's enforced, not spot-checked.
3. **Issue #3 released-environment E2E** (this issue) — the integration ceiling: real signer binary, real indexer, restart/reorg. Opt-in/scheduled.
4. **M4 automation/tx-engine tests (when that code lands).** Nonce reservation under contention, idempotency-key dedup, post-condition construction, permissionless-race classification, gas-budget/circuit-breaker gating, and — critically — property/fuzz tests that assert **policy can never alter a broadcast's recipient or amount** (the core money-safety invariant). This is where the coverage bar should be highest; it's the only code that will move funds.

Cross-cutting: a couple of unit-level fills worth doing alongside #1 — a `main.ts` CLI-dispatch test (arg parsing, exit codes, the `serve` guards), and the `SIDEKICK_NETWORK_ID` override guard (C1).

---

## 5. Bottom line

The latest commits are clean and disciplined (fixes ship with tests; 175 green). Issue #3 is the right, well-scoped next lane and I'd approve it with ephemeral-first + pinned-version-recording. But if the literal goal is *total automated coverage*, sequence it as **#1 instrumentation → #2 dashboard → #3 released-env E2E → #4 tx-engine**: #3 closes the deepest integration gap, yet the dashboard (zero tests) and the absence of any coverage floor are the holes that most threaten "total," and the tx-engine remains the highest-risk surface the moment it exists.
