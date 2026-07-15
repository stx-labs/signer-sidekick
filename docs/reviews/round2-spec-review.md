# Re-review (Round 2): Signer Sidekick PoX-5 Operator Suite Spec

> **Superseded for implementation decisions.** See [`round2-disposition.md`](round2-disposition.md). In particular, the reward-pause finding below was explicitly not adopted for v1 by product-owner decision.

**Reviewed:** July 14, 2026 (revision incorporating Round-1 feedback)
**Spec:** [`docs/product/v1-plan.md`](../product/v1-plan.md), formerly circulated as `pox5-operator-suite-spec.md`
**Prior review:** [`initial-spec-review.md`](initial-spec-review.md)

---

## Verdict

The revision is a clear improvement and resolved nearly everything from Round 1 — usually more thoroughly than the review asked for. The milestone plan now matches the calendar (M2 "activation setup cut" is exactly the right Day-0 artifact), the licensing question is closed coherently, the hosted-API and two-instance realities are handled, and the new §13.1 signer-command claim **verifies against the 4.0.0 source**.

One significant regression must be fixed before this goes out for external review: **all handling of the global `pause-rewards` switch was deleted**, apparently as collateral damage from removing the misattributed "250-block Andon" sentence. The pause itself is real, shipped, and one-way; the spec now has no display, no alert, no circuit-breaker condition, no terminal-error classification, and no contract test for it. Details in F1.

---

## 1. New claims verified this round

- **§13.1 signer grant command — CONFIRMED.** `stacks-signer/src/cli.rs` at the `4.0.0` tag defines `GenerateStakingSignature` (line 66) with `GenerateStakingSignatureArgs`: `--config <FILE>`, `--signer-manager <principal>` (parsed as `PrincipalData`), `--auth-id <u128>`, `--json`. The spec's exact command line is accurate, and upgrading it from Round 1's "cannot be frozen yet" to a pinned command is justified.
- **§3.3 testnet placeholder — CONFIRMED** (matches Round-1 finding: `BITCOIN_TESTNET_STACKS_40_BURN_HEIGHT = 40_000_000` at the tag).
- **§11.5 read-onlys** (`get-new-rewards`, `get-earned`, `assert-all-active-bonds-included`, `get-withdrawal-request-staker`) — all exist in the 4.0.0 contracts (verified in Round 1).
- **GPL-3.0 decision (§18)** — coherent with stacks-core's license; the corresponding-source obligation for container images is correctly called out, which most teams miss.

## 2. Round-1 findings — resolution status

| Round-1 item | Status |
|---|---|
| Milestone order vs. calendar; Day-0 cut | **Resolved** — §16 launch-window strategy + new M2; CLI-first cut is the right scope |
| Grant revocation also blocks `stake-update` | **Resolved** — §3.4, §6.5 wind-down alert |
| "250-block Andon" misattribution | **Over-resolved** — the wrong number is gone, but so is the entire pause topic (see F1) |
| `unstake` / deferred-unlock ingestion + threshold forecast | **Resolved** — §6.2, §6.5, acceptance criteria |
| Epoch 4.0 post-condition types | **Resolved** — §11.4, M1 deliverable |
| Hosted API, rate limits, per-source cursors | **Resolved** — §5.1, §9.2, §13.3; more thorough than requested |
| Package over-structure | **Resolved** — §8.1 collapsed to `protocol` + `core`; adapter kept as safety gate |
| Two-instance / foreign gas-payer tx guard | **Resolved** — §11.3 worker lease + foreign-tx alert + §15.3 test |
| Auth-id single-use retry hygiene | **Resolved** — §5.2 step 5 |
| Evidence-based race classification | **Resolved** — §11.2 |
| Zero-STX-share → reserve edge case | **Resolved** — §6.3 |
| Event retention posture | **Resolved** — §9.3 |
| No-slashing rationale for v2 deferral | **Resolved** — §6.1 |
| Staker instruction / calldata generator | **Partially resolved** — §5.5 enrollment-info page; calldata explicitly excluded (see F5/F6) |
| PoX-4 → PoX-5 migration tracker | **Not addressed** — neither adopted nor rejected (see F4) |

## 3. Findings

### F1 — Regression: global `pause-rewards` handling was deleted (must fix)

The released contract's pause is real and was verified in Round 1: `pause-rewards` (pox-5.clar:489) is admin-gated, **one-way, with no unpause** — the doc comment says recovery requires a hard fork — and reward paths fail with `ERR_REWARDS_PAUSED` (u53) while paused. Round 1 asked only for a sourcing correction on the "250-block" figure. The revision instead removed:

- the entire §3.5 "Global reward pause" nuance section,
- the "PoX-5 rewards globally paused" alert (§6.5),
- "global pause" from the circuit-breaker trip list (§7),
- the "PoX-5 not paused" precondition on the manager-claim job (§11.5B),
- the "Global pause behavior" contract test (§15.2).

This matters more now than in draft 1, because the fallback crank (§6.3/§11.5A) will broadcast by default after its grace period: under a pause, the crank and claim jobs would repeatedly fail with u53, and without a terminal classification the engine's retry/fee-escalation machinery would grind against a permanent condition. Restore, correctly sourced to the contract rather than the SIP:

1. §3.5 nuance: pause exists, is one-way, recovery requires a protocol upgrade; display the on-chain paused state prominently.
2. §6.5 alert: rewards globally paused (critical severity).
3. §7: paused state trips the circuit breaker for reward jobs.
4. §11.2: `ERR_REWARDS_PAUSED` (u53) is **terminal**, not benign and not retryable.
5. §15.2: pause-behavior contract test.

### F2 — Fallback crank: default posture should be stated (minor)

The move from "monitor-only, feature-flagged" to "race-tolerant fallback after grace + jitter" is mechanically sound, and §7 still gates global calculation separately while §20 keeps the confirm-with-core blocker. Two things should be explicit: (a) the fallback's *default* state before Milestone-0 confirmation (recommend: disabled or a generous default grace, since the SIP describes a distribution "delay window" for multisig intervention that the shipped contract does not enforce — an eager crank removes whatever soft window launch operations may rely on); (b) what "short configurable grace period" defaults to. One sentence each closes this.

### F3 — Attach recognition loosening needs bounds (moderate)

§5.1 now allows recognition via "a canonicalized semantic/source profile rather than requiring identical whitespace or comments." The motivation is fine (manually deployed managers), but "semantic" is doing dangerous work in that sentence: §14.3's own threat table says the mitigation for a mimicking manager is *exact reviewed source/profile*. Recommend constraining recognition to: byte-exact match against rendered artifacts, **or** trivial lexical canonicalization only (whitespace/comment normalization), **or** membership in a maintained allowlist of reviewed on-chain source hashes. Explicitly forbid AST/semantic-equivalence checking as an automation gate — it adds parser attack surface for exactly the contracts an attacker controls.

### F4 — PoX-4 migration tracker: still missing, still the best acquisition wedge (moderate)

Round 1's strongest product recommendation was neither adopted nor recorded as rejected. All PoX-4 locks release at activation; the operator's dominant question during the ~12-day first stake window is "which of my PoX-4 stackers have re-staked with my manager, and do I clear 50,000 STX for cycle 141?" This is a bounded, read-only diff (historical PoX-4 delegation roster vs. incoming PoX-5 `stake` events) and it lands exactly when operators are choosing tools. It fits naturally in M2 or early M3. If it's deliberately out of scope, add it to §2.4 or §19 with a sentence of rationale so reviewers don't re-raise it.

### F5 — Alert on payout-preference loss (minor, cheap)

Verified in Round 1: the reference manager's `validate-stake!` **deletes** a staker's stored L1 pox-addr when a `stake`/`stake-update` arrives without calldata. Since the revision delegates all calldata encoding to official interfaces (§5.5), this footgun now lives entirely in third-party UIs. Sidekick already tracks payout preference (§6.2); add a §6.5 alert when a staker's stored preference disappears or changes after a stake-update, so the operator can flag it to the staker before the next payout pays sBTC to someone expecting BTC on L1.

### F6 — Solo-signer persona: state the resolution (minor)

§2.1 still lists the solo signer as a primary user; §2.2 excludes stake submission; §5.5 now explicitly excludes user-specific calldata. The implied answer — solo signers stake their own STX through official interfaces like everyone else, and Sidekick handles everything after admission — is reasonable, but say it in §2.1 so the persona doesn't read as contradicting the non-goals.

## 4. Checklist verdict

Every §21 item can be marked **accepted** except:

- "Global calculation fallback and manager-claim readiness are represented accurately" — **changed**: accurate for the happy path, but incomplete until F1 (pause handling) is restored.
- "Existing and fresh onboarding paths are complete enough for operators" — **accepted with note** F4 (migration visibility) and F3 (recognition bounds).

With F1 fixed and F3 tightened, this spec is ready to go to the external reviewers listed in §20.
