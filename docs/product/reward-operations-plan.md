# Reward operations — design and implementation plan

- Status: **Accepted — revision 5, in delivery (S0–S2b delivered 2026-08-22; see §10 status)**
- Branch: `codex/reward-forecast-and-overview-clarity`
- Replaces: the Phase 2–5 plan in issue #34 and the earlier mockup run-rail / signing-session /
  Autopilot model. ADR 0009's safety invariants stand; its sequencing is amended (§15).
- Mockups: `design/mockups/` (hi-fi pages on the real dashboard CSS) and the editable canvas.
- Next: confirm revision 3 → S0 (ADR 0010, #34 rewrite) → S1/S2 in parallel.

## 0. Review status

A second review of revision 3 confirmed the four original blockers resolved and raised three
implementation-level issues, all folded in here: the **payment accounting model** (gross → operator
fee → staker entitlement → payout; Bitcoin-route payout is entitlement minus the Bitcoin fee
budget; the column is *To staker*, §5.2/§9); **recipe bounds** (exact account set and maximum
entitlement per account sealed at approval; children may disappear, shrink, or be skipped, never
added or increased; one active run per gas wallet, §8.5); and a **dedicated `gas-wallet-sweep`
authorization variant** owned by S2 (§7.6, §8.4). Its mockup corrections and open-question
recommendations are applied (§6, §8.6).

An independent review of revision 2 approved the product direction — vocabulary, operator
workflow, evidence-first model, dedicated gas wallet, sequential execution, frontend-design gate —
and raised four design blockers plus refinements. All are verified against source and folded in:

| Finding | Resolution in this revision |
| --- | --- |
| A run cannot pre-authorize exact payment hashes before collect locks the fee | Runs approve a **sealed recipe**; payment children are materialized after collect is included and the fee snapshot is proven (§8.5) |
| "Clean up … no money moves" is false for rejected withdrawals (`reclaim-failed-withdrawal` transfers the refund to the staker, `signer-manager.clar` L344–L380) | Renamed **Finish Bitcoin payouts** with two cases: retire settled (no movement) / return rejected (exact manager→staker sBTC postcondition) (§3, §8.6) |
| Historical attribution promised more than the evidence supports (realizations store pool-level amounts; fresh-install recovery excludes departed members by default) | Ledger and exports keep a simplified coverage model — `exact` / `combined` / `historical-coverage-incomplete` — and acceptance is scoped to the recovery boundary (§5.3, §5.6, §11) |
| No manager-capability matrix | §5.7 defines what the ledger shows at each of four capability levels |
| Refinements: separate distribution state from execution availability; version the engine authorization schema; define gas-wallet activation; keep `observe` default and retire `assist`; fuller run lifecycle; split approval expiry from runtime; honest per-run cap; external races as normal completion; distinct transaction-ID export columns; S0 first; security review as a gate | All adopted (§5.8, §7.3, §8.5–8.7, §9, §10, §13) |

## 1. Context, goals, decisions

### 1.1 Context

PoX-5 reward handling is a set of **permissionless** calls: `calculate-rewards` (PoX-5), manager
`claim-rewards`, `claim-staker-rewards`, `settle-accepted-withdrawal`,
`reclaim-failed-withdrawal`. Anyone may call them; none moves the caller's own assets; payouts are
fixed to the named staker. The Stacks Core team is expected to automate these calls network-wide.
Sidekick's flow exists for (a) a pool's first distribution and (b) the backup case when this
signer's calls were skipped — not as a workflow engine.

The previously approved plan (issue #34, ADR 0009, the mockup concept) was judged over-engineered
for that purpose: a five-object durable ledger with allocation-coverage tiers as first-class UI,
per-checkpoint "books", guided wallet signing sessions, an Autopilot panel, and machine signing
gated behind issuer attestation and a multi-phase release checklist.

### 1.2 Goals (in priority order)

1. **Visibility, in operator terms**: for every distribution, past and current, show what has
   happened and what is outstanding — whoever made the calls.
2. **A couple of clicks to act**: when something is outstanding, the operator clicks, confirms,
   and can walk away; Sidekick's own gas wallet signs and broadcasts.
3. **Accounting you can reconcile**: clean CSV/JSON at pool/fee level and per staker, tied to
   transaction IDs.

### 1.3 Decisions already made (not open)

- Operator-run machine signing **does not require issuer attestation**; the operator's click on a
  sealed review is the authorization. Attestation remains only for future unattended Autopilot.
- Withdrawal finishing (`settle-accepted-withdrawal`, `reclaim-failed-withdrawal`) is **in v1**.
- Runs execute **sequentially, one transaction in flight**, and continue server-side after the
  operator closes the page.
- The existing browser-wallet proposals stay as a **fallback** when no gas wallet is configured;
  no new wallet flows are built.
- **Autopilot** (no-click automation) is later, not now.
- Vocabulary: **Cycle / Distribution / Calculate / Collect / Distribute / payments** (§3).
- The gas wallet is **generated by Sidekick** (never typed or pasted), surfaced in Settings, with
  a dismissable setup banner on the Rewards page; `observe` stays the default until the operator
  enables it.
- Who performed a step and when are **not on the main surface** — ⓘ tooltip and exports only.
- **Amounts**: below 100,000 sats as "N sats"; otherwise 3 significant figures with the unit word
  always present (`64,350 sats` · `0.0129 sBTC` · `2.42 sBTC`); exact sats on hover and in
  exports; STX to 2 decimals. **Unit by context:** sBTC for anything held or moved on Stacks
  (accrued, calculated, collected, direct payouts, fees held in the manager); BTC for payouts that
  went out over Bitcoin (sent / arrived); "sats" for either below the threshold. The payments
  table's *To staker* column is in the unit the staker receives.
- **Payment accounting model** (per payment, integer sats): `gross_reward` → `operator_fee` →
  `staker_entitlement = gross − operator_fee` → `payout`: direct route = entitlement in sBTC;
  Bitcoin route = entitlement − `l1_max_fee` (the Bitcoin fee budget) in BTC; rejected Bitcoin
  route = entitlement returned in sBTC (`refund = amount + max-fee`, `signer-manager.clar`
  L356). `l1_actual_fee` and `fee_refund` are recorded when proven.
- **Sorting, filtering, and totals operate on integer sats (and µSTX), never on rendered
  strings.** Rendering is presentation only: a column that mixes `sats`, `sBTC`, and `BTC` sorts
  and filters by the underlying sats value (sBTC and BTC are both sats-denominated, so the
  comparison is consistent), thresholds and "largest first" use exact values, and exports carry
  integer sats.
- Projection presentation: distribution-first tile with earned-so-far beneath, one cycle line
  under the tiles, details and accuracy collapsed.
- The gas wallet has a **Sweep remaining STX** function in Settings (send the whole balance minus
  the network fee to an operator-entered address).

## 2. Non-goals and superseded artifacts

Not built: the five-object ledger as durable objects; coverage tiers as prominent UI;
per-checkpoint financial "books"; wallet sign-next loop and signing sessions; standing
authorization policy; Autopilot; pipelined nonces; per-half splitting of a combined payment's sats
in the UI; xlsx export; signer/admin/staker key custody; public staker UI.

Disposition of existing artifacts (§15): ADR 0009 invariants kept, sequencing amended by ADR 0010;
issue #34 rewritten to §10; issue #6 re-scoped to unattended Autopilot only; the earlier mockup
concept is superseded by `design/mockups/`.

## 3. Vocabulary (final)

| UI term | Meaning | Protocol term it replaces |
| --- | --- | --- |
| **Cycle** | PoX reward cycle (~2 weeks). "Cycle 141." Reconciliation roll-up; the fee locks per cycle. | reward cycle |
| **Distribution** | One of the two periods per cycle for which rewards are calculated and handed out. "Cycle 141 · First Distribution." The operator's weekly work unit. PoX-5 itself calls this a *distribution cycle* (`pox-5.clar:2933–2938`). | distribution cycle / calculation checkpoint |
| **Calculate** | The network counts the pot for a distribution; no money moves. Usually automatic. Sidekick offers **Run calculation** only once overdue. | `calculate-rewards` |
| **Collect** | Pull this pool's calculated share from PoX-5 into the manager. The cycle's fee **locks** on the first collect. | manager `claim-rewards` |
| **Distribute** | Send each staker their share. Items are **payments** — one per staker per bucket; counts are of payments, never stakers. "Distributed 38 of 40 payments." | `claim-staker-rewards` |
| **Arriving over Bitcoin** / **Returned** | A Bitcoin-route payment is *sent* until sweep evidence proves arrival; the staker receives the entitlement minus the Bitcoin fee budget. A rejected one is **returned** to the staker as sBTC (the full entitlement) by Finish Bitcoin payouts. | withdrawal request / settle / reclaim |
| **Finish Bitcoin payouts** | Two cases in one action: **retire** settled payouts (no money moves) and **return** rejected ones (the full entitlement goes to the staker as sBTC). The confirm names both: "Retire 3 completed payouts · return 59,356 sats to 1 staker." Future payouts keep the staker's configured route; Sidekick never changes a route. | `settle-accepted-withdrawal`, `reclaim-failed-withdrawal` |
| **Your fee** | Operator fee: earned, withdrawn (derived: earned − balance; `withdraw-fees` emits no event), balance held in manager. | `earned-fees`, `withdraw-fees` |
| **Gas wallet** | Sidekick's own small STX wallet that pays transaction fees when the operator clicks. | gas payer |
| **Accruing** | Before a distribution is calculated: "Accruing · projected 0.0129 sBTC." The quiet resting state names the last completed cycle on one line. | outlook / forecast |
| **Rolled forward** | Payments not made before the next calculation merge into that later distribution's payment. | (ADR 0009 "combined" coverage, presentation) |
| **STX pool** / **Bond #n** | Reward buckets; bond rows appear only when the pool has bonds. | `bond-index none` / bond period |

Copy rules: no protocol terms on the page (no checkpoint, anchor, canonical, settlement account,
allocation); "confirmed" / "needs re-check" instead of canonical / noncanonical; exceptions are
never rendered green; who/when only in ⓘ and exports; every action label states what happens to
the money.

## 4. Protocol facts this plan relies on (verified)

Reference manager — `contracts/reference-manager/upstream/signer-manager.clar`:

- `claim-rewards` (L163) and `claim-staker-rewards` (L228) have **no admin check**; the only
  `is-admin` assertions are in admin functions (`update-admin` L436, `update-fees` L453,
  `withdraw-fees` L468, `sweep-fee-refunds` L510, `register-self` L544; `is-admin` L577).
- `claim-rewards` calls PoX-5 `claim-rewards`, reserves `unclaimed-staker-rewards`, then
  `map-insert`s `fee-bips-for-cycle` for the STX bucket and each bond bucket → **the fee pins on
  the first collect of a cycle/bucket** and is unchanged by later collects.
- `claim-staker-rewards` asserts earned > 0, unclaimed ≥ gross, manager sBTC balance > 0 →
  otherwise `ERR_NO_CLAIMABLE_REWARDS`; a stale payment aborts rather than misfires. Direct route
  transfers `earned` sBTC to the staker; Bitcoin route requires `earned ≥ max-fee` and calls
  `sbtc-withdrawal.initiate-withdrawal-request`, recording the request id and adding to
  `withdrawal-liability`.
- `settle-accepted-withdrawal` (L396) checks the registry status is accepted, deletes the
  mapping, and reduces `withdrawal-liability`; **no asset movement**.
- `reclaim-failed-withdrawal` (L344) checks the registry status is rejected, deletes the mapping,
  reduces liability, and **transfers the refund in sBTC from the manager to the staker**
  (`as-contract? … transfer refund tx-sender staker`). No admin check.

PoX-5 — `contracts/upstream/stacks-core-4.0.1/pox-5.clar`:

- `calculate-rewards` (L2158) is permissionless, moves no assets, requires the complete ordered
  active-bond list (enforced by the reviewed adapter in `packages/protocol/src/pox5-calculate-rewards.ts`).
- Two distributions per cycle: `current-distribution-cycle` (L2933),
  `distribution-cycle-to-burn-height` (L2938).
- `claim-rewards` (L2387) asserts `not rewards-paused` (L2404) — **pause blocks only new
  collects**; payouts from already-collected funds and finishing continue.
- The settleable unit is `(staker, reward-cycle, bond-index)`; both distributions accrue into the
  same account (`claim-staker-rewards-for-signer` L2444).

Engine (existing, single-tenant) — `apps/sidekick/src/transaction-engine/`:

- `gas-payer-signer.ts`: hardened secret-file loader (absolute path, no symlink, regular file,
  owner-only perms, owner match, `O_NOFOLLOW`, change-during-read check, zeroed buffers) and
  exactly one signing method, `signManagerClaimRewardsPlan`, which revalidates the sealed plan
  before signing. No generic signing. The signer is constructed when the engine runtime starts
  (`runtime.ts` ~L705–745) — there is no hot activation today.
- `runtime-config.ts`: `SIDEKICK_ENGINE_MODE=observe|assist`; `SIDEKICK_GAS_PAYER_PRINCIPAL` /
  `_PUBLIC_KEY` / `_SECRET_FILE`; attestation files required by `assist`; fee cap default
  100 000 µSTX (max 10 STX); approval default 30 min; finality depth default 6.
- The sealed manager-claim plan schema **requires** `attestationDigest`
  (`packages/protocol/src/manager-claim-rewards.ts` ~L102) and the planner injects the accepted
  attestation (`manager-claim-observer.ts` ~L638) — an operator-run mode needs a versioned
  authorization variant, not just skipped admission checks (§8.7).
- `admission.ts` (retired in S3.1): attestation, live fingerprint, adapter/revision, anchor canonical +
  descendant, prerequisites, fee state, fee cap, observe-mode, approval (missing/invalid/expired), signer
  availability/identity, nonce (owned/unresolved/foreign), authoritative blockers.
- `nonce-policy.ts` (retired in S3.1): single unresolved reservation. `state-machine.ts`: `prepared → preflighted →
  awaiting_approval → nonce_reserved → broadcast → confirmed → reconciled`, plus `blocked`,
  `ambiguous`, `noncanonical_reobserve`, `superseded`.
- `manager-claim-assist-coordinator.ts` (~52 KB, retired in S3.1): admission → sign → broadcast →
  observe → reconcile, hard-wired to the manager-claim adapter; `api-service.ts` L263–265 asserted it.
- `manager-claim-proposal.ts` (`buildManagerClaimProposal` L220): the sealed, execution-neutral
  proposal (ADR 0009). Routes: `server.ts` L1978–2031.

Proposals on the wallet path — `apps/sidekick/src/wallet-intent-service.ts`: manager claim
(~L968–1054), `calculate-rewards` (~L1059–1097), `claim-staker-rewards` (L1459–1586, bucket args
+ exact sBTC post-condition). **No proposal exists for settle/reclaim** (capability ids only, in
`manager-capabilities.ts`).

Reads and evidence: `reward-status.ts` (`readStxRewardStatus` L1347, `readRewardOutlook` L1117,
`discoverStakerClaims` L593); `reward-realization-sync.ts` (`syncRewardRealizations` L552 —
node-verified `calculate-rewards` events replayed through the simulator at the parent anchor;
stores the **pool-level** realized amount, not per-staker splits; `historical-anchor-unavailable`
L333); `pox5-pool-events.ts` / `pox5-pool-activity-sync.ts` (`claim-staker-rewards-for-signer`,
roster topics); `manager-event-sync.ts` / `manager-event-vocabulary.ts` (detailed manager prints
decoded only for the **reviewed reference vocabulary**, ~L270). Fresh-install recovery
(`docs/product/fresh-install-data-recovery.md`): manager history to deploy height; pool history
for **current members only** — departed members are not recovered by default (L73).

Storage: `migrations.ts` latest `version: 34`; engine tables `transaction_jobs` L597,
`transaction_attempts` L697/L928, `transaction_approvals` L744,
`transaction_reconciliation_observations` L780. Runtime settings:
`runtime-settings.ts` (`RuntimeSettingsController` L226, `effectiveConfig` L266). Data dir =
directory of `config.ts` `databasePath` (`SIDEKICK_DATABASE_PATH`, default
`data/sidekick.sqlite`). Export precedent: `server.ts` L2087 `/api/v1/pool/roster.{csv,json}`.

## 5. Ledger model

### 5.1 Principle

Sidekick stores no status badge. Everything is **derived at read time** from anchored contract
reads plus node-verified events already indexed. Provenance (you / another caller) is a ⓘ detail,
never a state.

### 5.2 Per distribution, per bucket

| Fact | Source | Shown as |
| --- | --- | --- |
| Calculated? | realization record; `get-last-reward-compute-height` | Calculated ✓ / waiting / overdue |
| Calculated for this pool | realization replay (pool-level `actualPoolSats`); "—" with ⓘ when the historical anchor is unavailable | "Calculated 0.0129 sBTC" |
| Collected; fee locked % | `claim-rewards` event; `fee-bips-for-cycle` | "Collected 0.0129 sBTC · fee locked 5%" |
| Payments: gross / operator fee / entitlement / payout / route / status | `get-earned-staker-rewards` at anchor; staker payout preference (`max-fee`); `claim-staker-rewards` prints | payments table (*To staker* = payout in the unit received; entitlement and Bitcoin fee budget in the row detail) |
| Bitcoin payouts: sent / arrived / returned / retired | manager `withdrawal-requests`; sBTC registry reads; settle/reclaim prints | arrivals column |
| Your fee | Σ payment fees (locked %); `earned-fees`; `withdraw-fees` events | "Your fee 64,350 sats" |

Per **cycle** (roll-up): fee locked %, Σ collected, Σ distributed, Σ fee, outstanding now.

### 5.3 The seam rule and evidence coverage

Both distributions of a cycle accrue into the same `(staker, cycle, bucket)` account, so a payment
made after the second calculation can cover both. Presentation rule: **a payment belongs to the
latest distribution of its cycle whose calculation preceded it**; payments outstanding when the
next calculation landed show as "k rolled forward" on the earlier distribution and with ⓘ
"includes First Distribution" on the later one; *Outstanding* is always what is owed now.

That rule is presentation, not financial proof of how a combined payment divides. Realization
records store pool-level amounts only, so the split is **not** derivable today. The ledger and
exports therefore carry a simplified coverage value per payment/allocation:

- `exact` — the amount attributable to this distribution is proven (single-distribution payment,
  or per-staker shares and index delta proven at the calculation anchor);
- `combined` — the payment is proven but its split across distributions is unavailable;
- `historical-coverage-incomplete` — evidence was unavailable or outside the recovery boundary
  (pre-install history on a non-archival node; departed members).

Coverage is a column in exports and a ⓘ detail in the UI, never a prominent tier.

### 5.4 Status line per distribution (financial state; highest wins)

1. **Needs attention** — ambiguous transaction; a rejected Bitcoin withdrawal **awaiting return**;
   collect blocked by `rewards-paused`. Once returned, the distribution reads **Complete · 1
   returned payout** in caution styling with all payments resolved — never green.
2. **Waiting on the network calculation** (usually automatic · expected ~date).
3. **Calculation overdue** → Run calculation.
4. **Ready to collect & distribute** (X sBTC · N payments).
5. **Distributing… k of N.**
6. **All distributed** (K arriving over Bitcoin / finishing pending) → Finish Bitcoin payouts.
7. **Complete.** Before calculation: **Accruing · projected X**; the quiet resting state reads
   "Nothing to do — accruing for the next distribution" and names the last completed cycle on one
   line.

### 5.5 Invariants carried unchanged from ADR 0009

A payment is never offered until the fee is proven locked for its exact cycle/bucket; unknown is
never rendered as zero or paid; provisional fee is visibly distinct from locked; `rewards-paused`
blocks only new collects; returned / below-fee / dust outcomes are exceptions, never green;
external completion is normal progress.

### 5.6 Fresh install and cost

History recovery follows `docs/product/fresh-install-data-recovery.md`: current state from
contract reads + roster enumeration; manager history to deploy height; pool history for current
members to the recovery boundary. Departed members and pre-boundary history surface as
`historical-coverage-incomplete`, stated on the page and in exports — never silently absent. The
projection is cached per chain anchor and invalidated on new anchors/events; per-payment reads use
the existing paged `discoverStakerClaims`.

### 5.7 Manager-capability matrix

| Capability level | What the ledger shows |
| --- | --- |
| PoX-5-proven baseline (any trait-compatible manager) | Calculations, pool-level calculated amounts, current membership where provable, network-wide accrual and projection |
| Manager-readable | Fee configuration and callable state the attached manager exposes (fee %, unclaimed balances, earned fees) |
| Reviewed event vocabulary | Detailed historical collect / payment / withdrawal accounting from decoded manager prints |
| Reviewed execution adapter | The actions Sidekick can run (Collect, Distribute, Finish); otherwise the row shows "available through your wallet / another caller" |

Each level degrades explicitly: a custom manager without the reviewed vocabulary still gets the
baseline and manager-readable rows, with payments history marked `historical-coverage-incomplete`.

### 5.8 Distribution state vs execution availability

The status line is the **financial state**. Whether Sidekick can act is a separate axis carried by
the gas-wallet chip and banners: "Ready to collect & distribute · gas wallet needs 0.2 STX", never
"Needs attention". A missing/unreadable/low gas wallet disables the primary button and explains
why; it does not change the distribution's state.

## 6. Information architecture (mockups in `design/mockups/`)

**Rewards page — four zones.** *Now* (eyebrow "Cycle 141 · Second Distribution" · status line ·
one primary button · gas chip · four tiles · one cycle line; the first tile carries the
projection before calculation and the exact amount after, with "projected → got" beneath),
*Payments*, *Past cycles* (grouped by cycle, two distribution rows each, expand → payments),
*Accounting*. *Projection details & accuracy* is a collapsed disclosure under the Now card.

**Primary button logic.** Collect & distribute (both outstanding → one run) · Distribute ·
Collect · Run calculation (overdue only) · Finish Bitcoin payouts (retire + return, named in the
confirm). Confirm sheet: what happens to the money, transaction count, estimated gas, fee
locked/locks now, "another caller may finish some of this first", "you can close this page".

**Quiet state.** "Nothing to do — accruing for the next distribution"; the last completed cycle on
one line with *View cycle*; Past cycles shows the just-finished cycle first.

**Banners (dismissable, persisted server-side).** *No gas wallet yet* (permanent dismiss,
re-enable in Settings) · *Gas wallet too low for the next run* (dismiss until the next due action).

**Overview card** — one card whose **title and CTAs are state-specific**; its *Collect & distribute*
opens the **same Rewards confirm component with the same draft/recipe**, never a second
confirmation implementation. Titles:: *Rewards — ready to
distribute* with *Collect & distribute* + *Review payments*; *Rewards — accruing* with *View
projection*; *Rewards — distributing* with *View progress*; *Rewards — complete* with *Review
payments*. **Settings › Gas wallet**
— address, balance, "≈ N transactions", fund instructions, backup note, banner toggle,
dedicated-key check, and the not-yet-created state.

## 7. Gas wallet

### 7.1 Creation and activation

Settings → *Create gas wallet*: the server generates a key (`randomPrivateKey`), writes it
atomically to the fixed internal path `<data-dir>/gas-wallet.key` (mode `0600`, owner = process
user, **refuses to overwrite**), stores the public principal + compressed key + path + `createdAt`
+ `source: "generated"` in runtime settings, and returns the address. The key never transits the
API, logs, Activity, or the support bundle. Existing keys keep the env file-path configuration.
**Enabling is a deliberate second step** (*Enable operator-run*), and S2 must implement **safe hot
activation** — construct and validate the signer under the engine lock, with the `is-admin` and
signer-principal refusal checks — or, if that proves unsafe, require and clearly prompt a Sidekick
restart. Either way the behaviour is explicit and tested.

### 7.2 Surface

Address, STX balance, "≈ N transactions at current fees", fund instructions, key-file note (host
backups; losing it loses only gas), last run cost, and **Sweep remaining STX** (§7.6). Overview
attention when the balance cannot cover the next due run.

### 7.3 Modes

`SIDEKICK_ENGINE_MODE`: `observe` (**default**, unchanged) · `operator-run` (gas wallet may sign
on explicit per-run operator approval; no attestation) · `autopilot` (future; attestation +
standing authorization). `assist` is retired: startup fails with a message pointing to
`operator-run` (Assist never shipped, so no live deployment depends on it).

### 7.4 Controls

Blast radius is the gas balance: every call is permissionless and moves none of the caller's
assets; deny-mode post-conditions guarantee it. Dedicated key only — **before every run** Sidekick
checks and refuses to sign if `is-admin(gas-wallet)` is currently true on the manager, if the
address equals the signer principal, or if it is a contract principal (the manager could grant
admin later; "never" is not claimable, a per-run check is). Per-run explicit approval with gas budget and bounded batch; per-transaction
fee cap; balance must cover the next fee; blocking "fund ≈ N STX". Byte-exact reviewed manager
source remains required for manager calls. Support bundle carries only public identity, balance,
and run history.

### 7.5 Failure modes

Secret unreadable / tampered / wrong perms → signing disabled, banner + Overview attention, runs
cannot start, wallet fallback stays available. Balance too low mid-run → run halts with "fund ≈ N
STX and resume". Key deleted on disk → as unreadable; identity stays until the operator removes it.

### 7.6 Sweep remaining STX (owned by S2, gate S2b)

Settings → *Sweep remaining STX*: the operator enters a destination address; Sidekick shows the
amount (balance minus the network fee) and a confirm naming amount and destination; on Go the gas
wallet signs one STX transfer. Sweep is **not a reward adapter**: it has its own sealed
`gas-wallet-sweep` plan and authorization variant (§8.4) that seals destination, exact transfer
amount, fee cap, network, nonce policy, and expiry, signed only by `signGasWalletSweepPlan`.
Controls: the destination must be a **standard principal on the configured network** (never a
contract); the amount is exactly balance − fee, with a deny-mode **exact STX postcondition from
the gas wallet**; the action is **blocked while a run is active** (one active authorization per
gas wallet, §8.5); the approval has the same 30-minute start window; it is recorded in Activity
and the support bundle. This is the only signer method that moves the gas wallet's own asset —
still bounded by the gas balance, the accepted blast radius. After a sweep, runs are disabled
until the wallet is funded again (banner + Settings state).

## 8. Execution engine

### 8.1 Current → target

Today: one adapter, one signer method, per-job approval bound to precomputed intent hashes, single
in-flight nonce, attestation-gated `assist`, process-local recovery, signer constructed at runtime
start. Target: a closed registry of five code-backed adapters, one explicit signer method per
adapter, **recipe-scoped runs** as the unit of authorization and progress, sequential successive
jobs, durable run cursor, a versioned authorization schema with attestation confined to the
(future) standing envelope. This is ADR 0009 Phase 4 pulled forward and trimmed.

### 8.2 Adapter registry

`ExecutionAdapter` (closed union of **reward** adapters): `calculate-rewards`, `claim-rewards`
(existing), `claim-staker-rewards`, `settle-accepted-withdrawal`, `reclaim-failed-withdrawal`.
The gas-wallet sweep is a separate sealed plan type (§7.6), not a registry entry. Each provides
`buildProposal` (reuse the sealed wallet-path proposals for the first three; build small ones for
settle/reclaim), `plan`, `revalidate`, `postConditions`, `completionPredicate`, `reconcile`.
`api-service.ts`'s hard asserts become registry lookups.

### 8.3 Signer

One explicit method per adapter (`signPox5CalculateRewardsPlan`, `signClaimStakerRewardsPlan`,
`signSettleAcceptedWithdrawalPlan`, `signReclaimFailedWithdrawalPlan`,
`signGasWalletSweepPlan`; `signManagerClaimRewardsPlan` kept), each revalidating its sealed plan.
No generic signing.

### 8.4 Proposals and the authorization schema

The neutral proposal core is unchanged. The sealed plan/authorization schema is **versioned**:
v2 defines a closed `authorization` union — `{kind: "operator-run", runId, recipeSha256}` (no
`attestationDigest`), `{kind: "gas-wallet-sweep", sweepId, destination, amountUstx, feeCapUstx,
expiresAt}`, and `{kind: "standing", attestationDigest, …}` (future). v1 manager-claim
plans remain readable; the planner stops injecting an accepted attestation for operator-run.

### 8.5 Run = sealed recipe

A run approves a **recipe**, not precomputed child hashes, because the first collect is what locks
the fee and payments cannot be prepared until the fee is proven locked. The recipe binds: manager,
network, cycle, distribution; the allowed operations in order (e.g. `claim-rewards` then
`claim-staker-rewards`); the **exact `(staker, cycle, bucket)` account set** and, for each, the
**maximum gross entitlement** derived at approval (using the locked fee, or the configured fee
when it will lock at this collect); the **reviewed total and payment count** shown in the confirm;
`maxTransactions`, per-transaction fee cap, `gasBudgetUstx`; fixed recipient and asset semantics
(payouts only to the named staker; assets only from the manager); adapter ids/revisions and source
fingerprints. After the collect job is included and the fee snapshot is proven, Sidekick
**materializes each payment proposal**. A child **may disappear, shrink, or be skipped** (another
caller acted; the fee locked lower) but the run **never adds a recipient or increases an approved
account's amount**; a child that would exceed its bound halts with an explanation. Every child
still passes exact last-moment revalidation before signing.

Lifecycle: `draft → awaiting_approval → approved → running → (paused) → completed | halted |
cancelled | expired`. **One active authorization per gas wallet** (run or sweep) — never two
distributions against the same nonce stream; creation and approval are idempotent; child ordering is stored explicitly; `cursor` = next child. **Approval must be used
within 30 minutes** (start window); a started run has a **maximum runtime of 6 h**; raising the
fee cap always requires a new approval. The per-run cap (default 200 transactions) is honest in
the UI: "Distribute 200 of 640 payments now · 440 more in the next run."

### 8.6 Execution loop

One transaction in flight: reserve nonce → sign → broadcast child *k*; on inclusion of *k*
(finality tracked asynchronously), materialize/revalidate and reserve *k+1*. Before each child:
anchor canonical/descendant, nonce owned, fee ≤ cap, balance ≥ fee, gas budget remaining, account
still has something to pay and its fee is still locked, recipe satisfied. An account already paid
by another caller is marked *done* (provenance in ⓘ) and skipped. **External races after
broadcast are normal**: a predictable contract abort (`ERR_NO_CLAIMABLE_REWARDS`) plus proven
desired post-state completes the child as externally performed, not as a failure. Post-conditions:
calculate none; collect exact PoX-5→manager sBTC; payment exact manager→out sBTC (the full
entitlement leaves the manager; on the Bitcoin route the Bitcoin fee budget goes to the sBTC
protocol); settle none; **reclaim exact manager→staker sBTC refund (`amount + max-fee`)**. No
retry, no blind replacement; `ambiguous` / `noncanonical_reobserve` halt the run with an exact
resume count. Pipelined nonces are a later optimisation.

Policy rules (closed in review): **fees under congestion** — use the current network fee while it
stays within the approved per-transaction cap and total budget; halt above either. **Bitcoin
payments below the fee budget** (`entitlement < max-fee`) — skip with an exception row that tells
the operator the staker must update or remove their Bitcoin payout preference; Sidekick cannot
override a route and offers no fake one-click fix. **`rewards-paused` mid-run** — halt new
collects; continue already-collected payments only where the relevant fee snapshot is proven
locked.

### 8.7 Admission deltas

Attestation checks apply only to `authorization.kind === "standing"`. New blocks:
`run-approval-missing | run-approval-invalid | run-start-window-expired | run-runtime-exceeded |
child-not-in-recipe | gas-budget-exceeded | nothing-to-pay | fee-not-locked | gas-wallet-is-admin |
gas-wallet-is-signer`. Run admission lives in the reward-run service; the single-job `admission.ts` was
retired with the legacy path in S3.1.

### 8.8 Activity / Overview / API

A run is one Activity group (`engine-run:<id>`) with children as timeline entries; Overview shows
"Distributing… k of N" as in-progress and a halted run as needs-attention with *Resume*. API:
`POST /api/v1/rewards/runs` (draft from current facts), `POST …/runs/:id/approve` (= Go),
`…/pause`, `…/resume`, `…/cancel`, `GET …/runs/:id`; legacy `/api/v1/engine/*` remain for
single jobs. Gas wallet: `POST /api/v1/settings/gas-wallet` (create), `POST …/enable`, `GET`
(public identity + balance), `POST …/dismiss-banner`, `POST …/sweep` (draft) and
`POST …/sweep/:id/approve` (Go).

## 9. Accounting exports

Mirrors `/api/v1/pool/roster.{csv,json}`. Integer sats; every row carries block, verification
source, and **distinct transaction-ID columns**; who/when present in exports even though hidden on
the page. CSV cells are sanitised against formula injection.

- `distributions.{csv,json}[?cycle=]` — cycle · distribution (1|2) · bucket · calculated_at ·
  calculation_txid · calculated_pool_sats · collected_sats · fee_bips · fee_locked_at ·
  collect_txid · collect_by · payments_made · payments_rolled_forward · distributed_sats ·
  outstanding_sats · operator_fee_sats · coverage.
- `payments.{csv,json}[?cycle=&distribution=&staker=]` — cycle · distribution · bucket · staker ·
  route · gross_reward_sats · operator_fee_sats · staker_entitlement_sats · payout_sats ·
  payout_asset (sBTC|BTC) · l1_max_fee_sats · l1_actual_fee_sats · fee_refund_sats ·
  returned_sats · status · coverage · paid_at · payment_txid · by · l1_request_id · l1_status ·
  settle_or_reclaim_txid · btc_sweep_txid.
- `fees.{csv,json}` — operator fee per payment; `withdraw-fees` events; **fee refunds
  (`sweep-fee-refunds`) as a separate row type**; running balance.

Identities asserted in tests: per cycle/bucket `collected = Σ gross_reward`; per payment
`gross_reward = operator_fee + staker_entitlement`; direct route `payout = entitlement`; Bitcoin
route `entitlement = payout + l1_max_fee` and, when proven, `l1_max_fee = l1_actual_fee +
fee_refund`; rejected route `returned = entitlement`; `outstanding = Σ entitlement` of unpaid
accounts.

## 10. Implementation slices

> **Status (2026-08-22):** S0 delivered (`c94e9c2`). S1 delivered on `codex/reward-forecast-and-overview-clarity`
> (ledger + exports; commit pending). S2 core delivered (gas wallet lifecycle, `operator-run` mode, `assist`
> retired, hot activation, refusal checks, banners) and S2b delivered (sealed `gas-wallet-sweep` plan, signer
> method, approve/broadcast/settle, run-exclusion). Evidence reads now keep the **newest** rows when a long
> history exceeds the per-stream limit and report an explicit `evidenceWindow` (older cycles become
> `historical-coverage-incomplete`). **S5 delivered** (Rewards page rebuilt per the mockups: Now card with the
> status line, one primary button and the gas chip, projection details disclosure, payments with status tabs /
> staker search / integer-sats sorting, past cycles paged with lazy payments, accounting exports + fee ledger,
> banners, confirm sheet bound to the §8.8 run routes; state-specific Overview card; Settings › Gas wallet with
> sweep; browser-wallet fallback kept behind "Distribute with your wallet"). **S5 is bound to the S3 run
> contract** (`packages/api-contracts/src/reward-runs.ts`, copied verbatim from the S3/S4 worktree): prepare with
> the button's operations, approve with `recipeSha256`, recipe-based confirm sheet (grouped children, reviewed
> totals, gas budget, approval deadline, draft reuse/discard), progress from `run.progress`/`children`,
> pause/resume/cancel, run discovery via `GET /rewards/runs` so progress shows from any tab/Overview. S3/S4 in
> **S3/S4 merged** (2026-08-22): durable reward runs (`bf9e3f5` + review fixes), five sealed adapters, run
> routes, regtest round-trip, Devnet calculate + collect run; the dashboard reads the real run contract
> (recipe `truncated` / `eligibleTransactions` / `remainingTransactions`). **S3.1 delivered** (2026-08-22):
> the attestation-gated single-job engine path is retired — assist coordinator, nonce policy, admission,
> attestation controller/trust store, the legacy `signManagerClaimRewardsPlan` signer method, the
> `/engine/jobs/:id/approval[/invalidate]` routes + contracts, and the dashboard Approve/Invalidate controls
> are gone; the engine is observe-only (jobs stay reviewable, `approvalWindow` always reports the retired
> reason) and `SIDEKICK_COMPATIBILITY_*` env vars now fail startup. Pending: one Devnet run of the
> extended harness (distribute ≥2 payments incl. Bitcoin route + Finish Bitcoin payouts); S3.2 (below); S6
> docs. **S1.1** (below) is queued.

### 10.0 S3/S4 integration checklist (branch `codex/reward-operations-s3-s4` → this branch)

Reviewed 2026-08-22 against this plan. The S3/S4 work (uncommitted in its worktree, based on
`3e5147e`) adds: `packages/protocol/reward-operation-plan` (five sealed adapters, deny-mode
post-conditions, rebuild-before-sign), `packages/api-contracts/reward-runs` (recipe, run, child,
prepare/approve requests), migration v37 (`gas_wallet_authorizations` lease shared with sweeps,
`transaction_runs`, `_children`, `_attempts`), `RewardRunRepository`, `RewardRunService`
(sealed recipe, one-in-flight cursor loop, 30-min approval / 6-h runtime, per-signature refusal,
skip-when-done-by-another-caller, halt on ambiguity, restart recovery), `LiveRewardRunDriver` +
facts (anchored node reads, fee selection, registry status), explicit signer methods, run routes,
regtest adapter round-trip, Devnet gas-wallet calculate+collect scenario. It does not touch
`apps/dashboard`, so it composes with S5 without conflicts.

Done (merged 2026-08-22): 1 commit `bf9e3f5` + staged review fixes applied; 2 `draft` removed, one
refusal check at the signature boundary; 3 per-child observation reads removed (kept only for the
calculate adapter's first-cycle fact); 4 recipe carries `eligibleTransactions` / `truncated` /
`remainingTransactions`; 5 registry status reused from the operator service; 6 harness extended
(distribute ≥2 incl. Bitcoin route, then settle + reclaim) — **one Devnet run of the extended scenario
still to pass**; 7–10 dashboard bound to the contract (prepare with operations, approve with
`recipeSha256`, recipe-based sheet incl. draft reuse and truncation copy, run discovery/polling,
pause/resume/cancel, lifecycle e2e). Remaining: the Devnet run above; the "runs not available" copy
stays as the graceful message for builds without the engine.

Done (S3.1, 2026-08-22): the legacy attestation-gated single-job engine path is retired now that recipe
runs replace it — deleted `manager-claim-assist-coordinator.ts`, `nonce-policy.ts`, `admission.ts`,
`attestation-controller.ts`, `attestation-trust-store.ts` (+ tests); `runtime.ts` lost the recovery pass,
approval refresh, attestation loading and coordinator wiring (observation is always `requestedMode:
"observe"`, `attestation: null`); `api-service.ts` lost `approve`/`invalidateApproval`; `server.ts` +
`api-contracts` lost the approval routes/schemas; the dashboard review card is read-only; the signer kept
only sealed reward-operation and sweep methods; `runtime-config` rejects the attestation env vars.
Historical approvals still render (repository approval/attestation tables untouched).

Later (S3.2, cleanup only — no behaviour change): prune the observation service's assist-only branches
(`revalidateApprovedJob`, approval/attestation blocks), the repository approval/attestation persistence
that nothing writes any more, and the block-reason guidance strings that still say "review and approve
it"; consider renaming `maximumApprovalMinutes` (it is the run approval-start window).

### 10.1 S1.1 — scale follow-ups (queued, additive)

Findings from the 1-staker/cycle-2 vs 150-staker/cycle-50 review (2026-08-22). None change the data
model; all are additive to the ledger builder and API:

- Window evidence reads by reward cycle / block range instead of one global newest-N limit; build the
  current and recent cycles fully and summarize older cycles compactly; then drop the 10k payment cap.
- Summary mode for `GET /rewards/ledger` (cycles + current distribution only) and a paged payments
  endpoint (`?cycle=&distribution=&cursor=`) so the dashboard never loads the whole payment history.
- Stream CSV exports instead of building the whole ledger in memory.
- Gas estimate: show a recent-actual-fee estimate alongside the fee-cap estimate (150 × cap overstates).
- S3 knob: bounded N-in-flight after sequential v1; surface run progress for long distributions.

S5 acceptance additions — small and large pools must both look right:

- Payments load per selected distribution (server filter), never the unfiltered ledger; cycles page in
  small groups with jump-to-cycle; staker search uses the server-side prefix filter.
- Scale chrome disappears for tiny pools: no "Showing N of M" footers under a short table, no empty
  "Past cycles" section, singular copy ("1 staker"), Accruing/quiet states front and centre, and the
  fee-locks-on-first-collect explanation visible for pools that have not collected yet.

| # | Slice | Scope | Gate |
| --- | --- | --- | --- |
| S0 | **Commit the design** | This document in `docs/product/` (done); ADR 0010; rewrite #34; re-scope #6 | Design agreed |
| S1 | **Ledger + exports** (read-only) | Distributions-inside-cycles projection, seam rule, coverage values, capability matrix, corrected fresh-install promises, per-anchor cache + invalidation; three exports with distinct txid columns | Acceptance 1; identities hold; no engine changes |
| S2 | **Gas wallet** | Atomic key creation at the fixed internal path; explicit enablement; hot activation or documented restart; per-run `is-admin`/signer refusal; balance + estimate; banners; redaction tests; `operator-run` mode, `assist` retired; **S2b: `gas-wallet-sweep` sealed plan, authorization variant, signer method, confirm, run-exclusion** | Key never in API/logs/bundle; refusal/tamper tests; activation test; sweep tests |
| S3 | **Engine** (manager claim as only tenant) | Closed registry; per-adapter signer abstraction; versioned authorization schema; recipe-scoped runs with full lifecycle; sequential nonce sequencing; durable cursor; coordinator parameterised | All existing engine tests green; Devnet collect via gas wallet as a run of one; restart/ambiguity/reorg gates |
| S4 | **Adapters** | `calculate-rewards` → `claim-staker-rewards` (child materialization after collect) → settle/reclaim with the reclaim refund post-condition; external-race completion | Acceptance 2–3 on Devnet from the released binary |
| S5 | **UI** | Rewards page, Overview card, Settings panel per `design/mockups/`; e2e fixtures; a11y; mobile | Browser suite green desktop + mobile |
| S6 | **Docs + security review as a gate** | Operator docs; `transaction-engine.md`; operation contracts (+ settle/reclaim rows); README wording; **scoped security review (§13) must pass before mainnet operator-run is enabled** | Review complete |

Order: S0 → S1 ‖ S2 → S3 (critical path) → S4 → S5 (after design) → S6 (review gates release).

## 11. Test strategy and acceptance

1. **Visibility, zero involvement:** a fresh install pointed at a pool that has run for months
   without Sidekick shows every past distribution's calculate/collect/distribute/fee state and
   **every payment within the recovery boundary for current members**, with transaction IDs;
   departed members and pre-boundary history are marked `historical-coverage-incomplete` on the
   page and in exports; exports reconcile to the explorer.
2. **First distribution on Devnet** (released binary): calculate → Collect & distribute (mixed sBTC
   + Bitcoin routes) → Finish Bitcoin payouts (one settled retired; one rejected → the full entitlement returned to the
   staker in sBTC with the exact post-condition; the staker's route unchanged), via the gas wallet, with the browser closed mid-run; then another actor
   pre-empts the calculation and pays half the stakers before broadcast **and** one more after
   broadcast — Sidekick marks all of them done-by-another-caller, no duplicate or failed
   children; then payments are left until after the next calculation — "rolled forward" /
   "includes First Distribution" render and the cycle roll-up ties out.
3. **Gas wallet:** create → enable (hot activation) → fund → run; admin key → refused; low balance
   → blocked before the run; key tampered → refused; reorg/ambiguity mid-run → halts, exact
   resume; restart mid-run resumes at the cursor; approval older than 30 min cannot start; a
   run exceeding 6 h halts; **sweep** to an entered address empties the wallet minus the fee,
   refuses a contract or other-network address, and is blocked while a run is active.
4. **Accounting identities** hold on Devnet data; exports open in a spreadsheet without cleanup.
5. **Rendering vs value:** sorting a payments column that mixes `sats`, `sBTC`, and `BTC`
   renderings orders by integer sats; filters and thresholds compare exact values; no test asserts
   on a formatted string.

Layers: protocol vectors; regtest lifecycle (`test/integration/regtest/lifecycle.test.ts` already
covers calculate L731, claims/payments L319/L812, L1 reclaim L390, below-fee L454, settle L507 —
extend with gas-wallet runs); Devnet harness; dashboard e2e fixtures for every status line and
banner; api-contracts strictness; security tests.

## 12. Config, storage, migration

- Env: `SIDEKICK_ENGINE_MODE=observe|operator-run` (`autopilot` reserved; `assist` rejected);
  `SIDEKICK_GAS_PAYER_*` kept for imported keys; `SIDEKICK_ENGINE_MAXIMUM_FEE_USTX`,
  `SIDEKICK_ENGINE_FINALITY_DEPTH` kept; new `SIDEKICK_ENGINE_RUN_START_MINUTES` (30),
  `SIDEKICK_ENGINE_MAX_RUN_HOURS` (6), `SIDEKICK_ENGINE_MAX_RUN_TRANSACTIONS` (200).
- Runtime settings: `gasWallet` identity + `enabled`; banner dismissals.
- Migration v37 (additive; v35 `gas_wallet` and v36 `gas_wallet_sweeps` are taken): `transaction_runs`
  (recipe, lifecycle, cursor, child order);
  `run_id` + `child_index` on `transaction_jobs`; authorization schema version on jobs.
- Backward compatibility: deployments without a wallet unchanged; legacy single jobs continue.

## 13. Security review scope (a gate before mainnet operator-run)

New signer methods and sealed-plan revalidation per adapter; recipe binding and child
materialization (no child outside the sealed account set, and no amount above its bound, can be
signed); the `gas-wallet-sweep` variant; versioned authorization schema; key
generation, atomic file handling, and hot activation; `is-admin` / signer-principal refusal;
deny-mode post-conditions per adapter including the reclaim refund; the sweep path (recipient
validation, exact STX postcondition, run-exclusion, confirm); sequential nonce sequencing,
pause/halt/resume, ambiguity; absence of key material in API/logs/bundle/Activity; export endpoints.

## 14. Open questions

None outstanding. The congestion, below-fee, `rewards-paused`, and Overview-confirm questions were
closed in review and are recorded in §8.6 and §6.

## 15. Governance

ADR 0010 — *Operator-run execution envelope*: permissionless reward calls may be machine-signed by
a dedicated, Sidekick-generated gas wallet on explicit per-run operator approval of a sealed
recipe, without issuer attestation, under §7.4 and §8; ADR 0009 invariants stand, its Phase 2–5
sequencing is replaced by §10; #6 re-scoped to unattended Autopilot; the §13 review gates mainnet
enablement. Rewrite issue #34 to §10. Update `transaction-engine.md`, ADR 0009 status note,
`recurring-operation-contracts.md` (+ settle/reclaim rows with the refund post-condition),
`reward-outlook.md`, `overview-attention-model.md`, `scope-and-decisions.md`, `system-model.md`,
ADR 0003 (gas wallet is not custody of signer/admin keys), operator docs, README wording.

## 16. Out of scope / later

Autopilot; pipelined nonces; per-half sats attribution in the UI; xlsx; selective "distribute only
these payments" (v1 distributes all outstanding, per-bucket filter at most); public staker UI;
admin operations (fee changes, fee withdrawal, refunds) — manager-admin wallet actions that appear
only in accounting.
