# Review: Signer Sidekick PoX-5 Operator Suite Spec

**Reviewed:** July 14, 2026
**Spec:** `pox5-operator-suite-spec.md` (v1 scope, dated July 14, 2026)
**Method:** All protocol, artifact, and prior-art claims were independently verified against SIP-045, the Bitcoin Staking whitepaper appendix, `pox-5.clar` and `signer-manager.clar` at the stacks-core `4.0.0` tag, the stx-labs API/stacks.js repos, live mainnet `/v2/pox` state, and the `degen-lab/stacker-flow-automation` source.

---

## Verdict

The spec is fundamentally sound and unusually accurate. The core architectural bets — clean rewrite, state-reconciler-first design, strict key separation (gas payer only), observe-by-default modes, height-driven scheduling, idempotent jobs with post-confirmation reconciliation — are all correct and directly fix every verified defect in the PoX-4 predecessor. The subtle protocol claims that would be easy to get wrong (one-way `pause-rewards`, insert-only fee snapshots, the invalid balance invariant, permissionless race classification) all check out against the released contracts.

The two significant problems are not correctness problems. They are **sequencing** and **scope-vs-calendar** problems:

1. **The milestone order is backwards for launch reality.** The spec builds the attach path (M2) before the fresh-setup path (M3), but on July 29 there are zero deployed PoX-5 managers to attach to. Every prospective user is on the fresh path.
2. **The single highest-leverage moment for this tool — the PoX-4 → PoX-5 migration surge in the ~12 days after activation — is essentially unscoped.** The migration guide is a documentation deliverable in Milestone 5, which is the last possible place it could matter.

---

## 1. Verification results

### 1.1 Confirmed protocol claims (§3.4, §3.5)

Every claim in §3.4 and §3.5 was verified against `pox-5.clar` and `signer-manager.clar` at the `4.0.0` tag (commit `5595f08a…` confirmed):

- `stake(signer-manager, amount-ustx, num-cycles, start-burn-ht, (optional (buff 500)))` — confirmed.
- `stake-update` for signer change / extend / increase, effective next cycle — confirmed.
- `MAX_NUM_CYCLES u96` — confirmed.
- Prepare-phase rejection (`ERR_STAKE_IN_PREPARE_PHASE` u47; `unstake` uses separate u28) — confirmed.
- `SIGNER_SET_MIN_USTX u50000000000` (50k STX), applied per cycle — confirmed.
- Signer identity = manager contract principal (`register-signer` requires `contract-caller` = the manager) — confirmed.
- SIP-018 grant with single-use `auth-id`s — confirmed.
- Half-cycle distributions (1,050 BTC blocks), rewards as sBTC — confirmed.
- `calculate-rewards` permissionless, requires complete active bond list (`ERR_ACTIVE_BOND_NOT_INCLUDED`), ordered by **descending `stx-value-ratio`, ascending bond-index tie-break**, at most `(list 6 uint)` — confirmed. A read-only `assert-all-active-bonds-included` exists and should be used as preflight.
- `claim-rewards` callable per checkpoint, multiple incremental claims per reward cycle — confirmed.
- `pause-rewards` one-way, no unpause, doc comment says recovery requires hard fork — confirmed. The spec's decision to hard-stop reward jobs on pause and gate the global crank is right.
- Fee snapshots via `map-insert` on `fee-bips-for-cycle {reward-cycle, bond-index}` — insert-only semantics confirmed exactly as described.
- Withdrawal accounting: `settle-accepted-withdrawal` / `reclaim-failed-withdrawal` both permissionless, both delete the request entry (replay-safe); `sweep-fee-refunds` computes sweepable as balance minus `earned-fees + withdrawal-liability + unclaimed-staker-rewards` — the spec's rejection of the naive balance invariant matches the contract's own math.
- Staker payout calldata is `(consensus-buff-encoded) {pox-addr: {version (buff 1), hashbytes (buff 32)}, max-fee: uint}`; presence routes to `sbtc-withdrawal.initiate-withdrawal-request`, absence pays direct sBTC — confirmed.

### 1.2 Confirmed context claims

- **Activation:** `BITCOIN_MAINNET_STACKS_40_BURN_HEIGHT = 960_230` confirmed at the 4.0.0 tag. Live mainnet (July 14): burn height 958,064, cycle 139; cycle 140 reward phase starts at 960,050, so activation lands inside cycle 140 and **cycle 141 is the first PoX-5 cycle — the spec's inference is correct.** The spec's rule that no runtime behavior may hard-code this is still right.
- **API v9 and PRs:** all five PRs (#2582, #2579, #2585, #2594, #2602) exist, are merged, and match their descriptions. Org is `stx-labs` (hirosystems URLs 301-redirect after the org migration) — the spec's links are current.
- **stacks.js #1854:** still an open draft, unmerged. The spec's decision to own PoX-5/manager argument construction rather than depend on it is validated.
- **stacks-core is GPL-3.0** — the §18 licensing concern is well-founded and correctly flagged as a distribution blocker.
- **degen-lab/stacker-flow-automation:** all five automated PoX-4 calls and all five rewrite-justification criticisms (plaintext keys in env vars, hand-rolled `repr` parsing, naive local nonce incrementing, unauthenticated wide-open Express + committed SQLite files, `DELETE FROM`-and-rebuild every loop) are verifiably true in the source. §4 is accurate and the clean-rewrite decision is justified.

### 1.3 Factual corrections (small)

1. **§3.5 "Andon" attribution.** Neither SIP-045 nor the whitepaper contains the word "Andon" or any 250-block figure. The SIP says only that distributions "include a built-in delay window during which a designated multisig can pause a distribution," with no duration. The spec's *conclusion* (the released contract enforces no delay; the only pause is the permanent global one) is confirmed and is the important part — but drop the "250-block" number or re-source it, because a reviewer checking the SIP won't find it.
2. **§3.4 grant-revocation effect is understated.** Revoking the grant blocks not only new `stake`s but also `stake-update` *into* that manager — meaning existing stakers cannot extend, increase, or switch into the pool. That is a materially worse operational event than "no new stakes" and deserves its own alert severity and dashboard language ("pool is in wind-down: existing positions expire and cannot be extended").
3. **Testnet has no scheduled activation.** At the 4.0.0 tag, `BITCOIN_TESTNET_STACKS_40_BURN_HEIGHT = 40_000_000` — a placeholder. Until that changes, regtest/devnet is the *only* rehearsal environment, which raises the importance (and schedule risk) of the Milestone 1 harness.

---

## 2. The calendar problem (most important critique)

The spec reads like a well-run 3–6 month project. The network activates in **15 days**. Mapping the protocol timeline against the milestones:

| Date (est.) | Burn height | Event |
|---|---|---|
| Jul 29 | 960,230 | Epoch 4.0 activates; **all PoX-4 locks release**; PoX-5 deployed |
| Jul 29 – ~Aug 10 | 960,230 – 962,050 | **The one-and-only first stake window**: everyone who wants to be in cycle 141 must `stake` before its prepare phase |
| ~Aug 10–11 | 962,050 – 962,150 | Cycle 141 prepare phase (stake calls rejected) |
| ~Aug 11 | 962,150 | Cycle 141 begins — first PoX-5 reward cycle |
| ~Aug 18 | ~963,200 | First distribution checkpoint; first `calculate-rewards` / `claim-rewards` possible |

Implications the spec doesn't confront:

1. **Attach-first (M2 before M3) is inverted for launch.** §5.1 calls attach "the lowest-risk and first implementation path," which is true from an engineering-risk standpoint but wrong from a user standpoint: on day one there are no existing PoX-5 managers. Every operator needs the fresh path — manager render/deploy, grant ceremony, `register-self`, eligibility verification. Attach only becomes the common case weeks later (and is still needed for people who set up manually first — which, given the timeline, will be most of the launch cohort). Either reorder M2/M3, or explicitly accept that Sidekick is a "second wave" tool that operators adopt after manually surviving launch — that's a legitimate strategy, but it should be a stated decision, not an accident of milestone ordering.
2. **Reward automation (M4) genuinely has slack** — nothing to claim until ~Aug 18, and backlogs are recoverable since claims are permissionless and cumulative (the spec's checkpoint/catch-up design handles late claiming well). The pressure is entirely front-loaded on setup and visibility.
3. **Recommend adding a "Day 0 cut" section:** the smallest artifact that is useful on July 29. Plausibly: preflight checks + manager render/verify + grant ceremony + registration verification + a read-only eligibility/threshold view, even with CLI-only output and no ingestion pipeline. Everything else can follow.

---

## 3. Missing scope

### 3.1 PoX-4 sunset / migration tracker (high value, unscoped)

All PoX-4 locks release at activation and every delegator must re-stake into PoX-5 within the ~12-day window to make cycle 141. For a pool operator migrating from PoX-4, the burning question in that window is: **which of my PoX-4 stackers have re-staked with my manager, who hasn't, and how much of my 50k threshold is at risk?** The tool has (or can trivially get) the operator's PoX-4 roster from indexed history and can diff it against incoming PoX-5 `stake` events. This is a bounded, read-only feature, it lands exactly when operators are choosing tools, and it's the strongest possible acquisition wedge. Currently the only nod to migration is a doc in M5. Strongly recommend promoting a "PoX-4 → PoX-5 migration view" into early scope.

### 3.2 Staker instruction / calldata generator (medium-high value, half-scoped)

§2.2 rightly excludes wallet flows and enrollment UI, and §2.2 vaguely allows "operator-facing values and instructions that a pool publishes elsewhere." Make this concrete. Stakers joining the pool must:

- call `stake` with the exact manager principal,
- encode payout preference as `consensus-buff` `{pox-addr: {version, hashbytes}, max-fee}` (≤500 bytes) — malformed calldata fails admission (`ERR_INVALID_CALLDATA` u1003), and **re-staking without calldata silently deletes a previously stored L1 preference**,
- pass a `start-burn-ht` that resolves to exactly the next cycle (`ERR_INVALID_START_BURN_HEIGHT` — no post-dating),
- avoid the prepare phase,
- know that a second `stake` fails (`ERR_ALREADY_STAKED`) and changes go through `stake-update`, and the only way *down* in amount is `unstake` + re-stake with a missed cycle.

A generator that takes "BTC address + max fee" (or "direct sBTC") and emits the exact call, encoded calldata hex, and the current valid submission window is cheap, keeps Sidekick out of the custody/wallet business, and resolves the internal tension where §2.1 lists a solo signer (staking their own STX) as a primary user while §2.2 excludes stake submission. Without it, the solo-signer persona has no supported path at all.

### 3.3 Unstake and exit-event ingestion (explicit gap in §6.2)

§6.2 mentions "reductions and expirations" but never `unstake` by name. The contract facts: `unstake` unlocks at end of the current cycle, is blocked in prepare phase, and a mid-set unstake can knock the pool below 50k STX for future cycles, which zeroes the signer's STX-only reward shares for those cycles. The threshold alert in §6.5 covers the symptom; the ingestion spec (§9.3, §10) should name `unstake` events and the deferred-unlock semantics (API PR #2594 exists precisely because unstaked STX stays locked until cycle end) as first-class inputs, since they drive the most important predictive alert the tool can issue ("you will fall out of the signer set in cycle N+2").

### 3.4 Epoch 4.0 post-condition types (schedule risk hiding in §11.4)

Epoch 4.0 introduces new post-condition types (staking `0x03`, PoX `0x04`) that apply to stake/bond/unstake families. Released stacks.js predates them (the bitcoin-staking package is a draft PR). The spec already commits to owning argument construction, but it should explicitly acknowledge that **transaction serialization and post-condition support for the new types may also need to be owned or patched**, and that deny-by-default mode interacts with them. This mostly affects the *setup assistant's generated admin transactions* and any future stake tooling rather than the gas-payer jobs (manager claims move sBTC to/from the manager and may be expressible with existing fungible-token post-conditions) — but it should be verified in M1, not discovered in M4.

### 3.5 Hosted-API reality (§9, §13.3)

The spec requires "a Stacks API v9 endpoint" and the deployment topology implies self-hosting. A full API node (Postgres + event replay) is a heavy dependency many small operators won't run. The source-of-truth hierarchy (§9.1) already makes third-party APIs safe to use, so make hosted APIs (with API keys, rate-limit awareness, backoff) a first-class, documented configuration — the predecessor tool's rate-limit and retry handling was hard-won bug-fix behavior, and §9 currently says nothing about rate limits at all.

### 3.6 Things worth stealing from the predecessor

The rewrite justification is airtight, but three behaviors in the old tool are worth consciously preserving (the spec implies but never states them): incremental event backfill with cheap restarts (first full mainnet backfill took 15+ minutes there; PoX-5 event volume will be larger), mempool-aware pending-transaction display (operators evidently used the "what's in flight" table), and the cycle-horizon control concept translated to PoX-5 policy knobs.

---

## 4. Architecture assessment

**The shape is right.** Reconciler-first with SQLite projection as cache-not-authority, read-onlys through the local node as broadcast authority, burn-height scheduling, job state machine where confirmation ≠ success, transactional nonce reservation, and the Observe/Assist/Automate ladder — this is the correct design for a tool whose failure mode is "broadcast the wrong transaction," and each element answers a specific verified defect in the predecessor.

Specific notes:

1. **Package structure is heavier than v1 needs.** Seven packages plus two apps, for a single-process, single-tenant, SQLite tool, is premature factoring. `protocol` + `manager-reference` + `chain-data` + `domain` will have tangled types in practice. Suggest collapsing to ~3 (`protocol` incl. adapters/codecs, `engine` incl. ingestion/jobs/tx, `app` incl. API/UI/CLI) and splitting when a boundary proves real. This matters more given the calendar pressure.
2. **`ManagerAdapter` with exactly one implementation** is usually speculative generality, but here it earns its place as a *safety gate* (unknown source ⇒ no automation) rather than an extensibility mechanism. Keep it, keep it thin, and resist building the second adapter until someone actually ships a variant manager.
3. **Idempotency keys (§11.2) are well-designed** — including manager principal in every key means multi-manager support later is a config-cardinality change, not a schema migration. The rewards-per-token checkpoint targeting with supersession is exactly right for the catch-up-claim semantics the contract allows.
4. **Add a two-instance guard.** SQLite WAL on a shared volume gives accidental protection, but the dangerous case is two containers with *separate* volumes sharing one gas-payer key (e.g., during a botched upgrade): they'd fight over nonces and double-spend gas on races. The nonce-reconciliation rules in §11.3 would eventually pause both; cheaper to also detect "external transactions from my own gas payer that I didn't record" as an explicit, loud alert condition (it's currently implied by "competing external transaction" but worth naming).
5. **Preflight tooling the contract already gives you:** `assert-all-active-bonds-included` (read-only validation of the bond-periods list before broadcast), `is-in-prepare-phase`, `get-new-rewards`, `verify-signer-key-grant`, `get-withdrawal-request-staker`. §11.5's job definitions should reference these explicitly — they eliminate whole classes of simulate-then-race failures.
6. **Chain_events growth is unbounded** (§10 stores immutable raw+decoded events forever). Fine for v1 scale; add a stated retention/archival posture so it's a decision rather than a surprise.
7. **Tech choices (§8.2) are fine and boring in the good way.** No objections.

**One economic validation of the v2 deferral:** SIP-045 §8.1 confirms no slashing and no protocol-level penalty for missed signing in PoX-5 (yield penalties deferred to PoX-6). So deferring signer-machine health doesn't leave a direct reward-loss channel uncovered in v1 — that materially strengthens the §6.1 "registration health, not machine health" boundary. Worth citing in the spec, because it's the first question a reviewer will ask about that deferral.

---

## 5. Smaller items

- **§5.2 grant ceremony:** verified that reference `register-self` performs `grant-signer-key` + `register-signer` in one admin call, matching the wizard flow. The single-use `auth-id` (`ERR_SIGNER_KEY_GRANT_USED` u12) means a failed/re-tried ceremony needs a *new* auth-id — the wizard should handle retry explicitly rather than reusing the payload.
- **Error-code taxonomy:** the job engine's race classification (§11.2) should enumerate the benign-race set up front: `ERR_DISTRIBUTION_ALREADY_COMPUTED` (u30), manager u1009/u1011 "wrong withdrawal state" (often means the other branch already ran or another caller won), `ERR_NO_CLAIMABLE_REWARDS` (u32/u1001) after a competing claim. Terminal: `ERR_REWARDS_PAUSED` (u53). Retry-next-window: u47/u28 prepare-phase.
- **Hardcoded mainnet sBTC principals** in the reference manager (`SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.*`) confirm §5.2's insistence on network-specific artifact rendering — the raw file genuinely cannot be deployed off-mainnet. The regtest harness therefore needs sBTC contracts deployed at substituted principals; §15.3 lists sBTC contracts in the stack, but call out the principal-substitution dependency explicitly since it gates every contract test.
- **"No STX staked ⇒ staker cut folds to reserve"**: not operator-actionable, but it means reward-per-token can be zero for a cycle in ways the reconciler should classify as valid rather than discrepant.
- **§20 blocker status after this review:** activation height 960,230 — now confirmed at the 4.0.0 tag (still keep the runtime derived from `/v2/pox`); API org migration to `stx-labs` — confirmed, links current; stacks.js #1854 — confirmed still draft, spec's posture validated. The remaining genuine blockers are unchanged: license resolution, reproducible manager artifact, global-crank policy, and the signer grant command against released tooling.

---

## 6. Recommended spec changes, prioritized

1. Add a **Day-0 / launch-window cut** and re-order M2/M3 (or explicitly adopt a "second wave" positioning). *(§2)*
2. Add the **PoX-4 → PoX-5 migration tracker** to early scope. *(§3.1)*
3. Add the **staker instruction + calldata generator**; resolves the solo-signer contradiction. *(§3.2)*
4. Correct **grant-revocation semantics** (blocks `stake-update` too) and the **Andon/250-block attribution**. *(§1.3)*
5. Name **`unstake`/deferred-unlock ingestion** and the predictive threshold alert explicitly. *(§3.3)*
6. Verify **epoch 4.0 post-condition type support** in M1; budget for owning serialization. *(§3.4)*
7. Make **hosted APIs + rate limiting** first-class config. *(§3.5)*
8. Collapse the package layout; add the two-instance/foreign-gas-payer-tx alert; state an event-retention posture. *(§4)*
