# ADR 0009: Evidence-first reward distribution and settlement

- Status: Accepted
- Date: 2026-08-20
- Tracking: [#34](https://github.com/stx-labs/signer-sidekick/issues/34)

## Context

PoX-5 reward distribution is not one transaction workflow owned by Sidekick. Reward calculation,
manager reward collection, staker reward claims, and Bitcoin-withdrawal retirement are
permissionless. Another caller may complete any step, and a canonical external transaction is
ordinary progress rather than an exceptional or superseding path.

The protocol also exposes two different units that must not be collapsed:

- a **distribution** is one reward-cycle calculation checkpoint (`first-half` or `second-half`);
  there are normally two per cycle; and
- a **settlement account** is the on-chain `(staker, reward-cycle, bond-index)` tuple accumulated
  and cleared by `claim-staker-rewards`.

Both checkpoints write to the same cycle/bucket account. An account can be settled after the first
calculation, accrue again after the second, and be settled again. Conversely, one catch-up claim can
settle value attributable to both checkpoints. A checkpoint cannot therefore be modeled as an
independently claimable on-chain obligation.

The existing transaction engine and wallet intents correctly preserve operation evidence, but an
operation record cannot answer whether every account for a distribution has been delivered or
financially reconciled. Transaction ownership is also the wrong lifecycle authority when external
callers are expected.

## Decision

### Chain evidence is the lifecycle authority

A reward distribution is a projection of canonical chain evidence, not a workflow Sidekick
executes. Sidekick continuously derives calculation, manager-pull, account-settlement, withdrawal,
and exception state regardless of who submitted each transaction.

Wallet intents and transaction-engine jobs remain execution and audit records. They may contribute
evidence to the projection, but the projection never requires local ownership of an operation.
`external` is operation provenance, not a health or failure state.

Distribution status is derived at read time from independently persisted evidence axes:

1. calculation evidence and timeliness;
2. manager-pull evidence per participating reward bucket;
3. settlement-account balances and deliveries;
4. Bitcoin-withdrawal cases and terminal exceptions; and
5. fee and historical-attribution coverage.

The UI may summarize those axes as awaiting calculation, action required, in progress, wallets
paid, financially reconciled, complete with exceptions, or needs attention. A stored summary badge
is never authoritative.

### Durable reward model

Phase 2 adds five durable object types behind typed repository boundaries in `SidekickStore`.
These are additive to the existing wallet-intent, transaction-engine, calculation-realization,
manager-event, and activity records.

| Object | Identity and purpose |
| --- | --- |
| Distribution | One chain source/network, manager, reward cycle, checkpoint, and protocol calculation height. Carries canonical calculation transaction/anchor evidence and realized reward-index deltas. |
| Settlement account | One chain source/network, manager, staker, reward cycle, and nullable bond index. Carries anchored current earned value and a history of deliveries; it deliberately has no single permanent `paid` flag. |
| Distribution allocation | An accounting overlay joining a distribution to a settlement account. Carries best-effort checkpoint gross, fee, and net attribution plus explicit fee and coverage quality. It is not independently claimable. |
| Settlement operation | A canonical local-wallet, Assist, or external operation and its links to the allocations/accounts it satisfied. One operation may cover multiple allocations, and one allocation may be reconciled through more than one observation or operation. |
| Withdrawal case | One Bitcoin-L1 withdrawal request linked to its settlement operation/account, including manager and sBTC-registry states, Bitcoin sweep evidence when available, and terminal exception classification. |

The distribution and allocation layers answer weekly accounting questions. Settlement accounts
drive transaction counts and action safety because they match the contract's settleable unit.

Schema and projections must preserve these rules:

- `bond-index = null` names the STX bucket; each bond period is a distinct account.
- Two checkpoints in one cycle remain separate distributions even though their allocations may be
  delivered by the same account claim.
- A distribution's `wallets paid` result is distinct from `financially reconciled`. Missing fee or
  attribution evidence cannot be converted to zero.
- Reorgs revise canonical evidence and derived projections rather than creating a second green
  history.
- Administrative fee withdrawal and refund sweeping do not participate in distribution
  completeness.

### Fee truth and historical coverage

The first manager claim for a cycle/bucket pins its fee snapshot with `map-insert`. Before that
claim, allocation fee and net values use the current configured fee only as an explicit projection.
Every allocation therefore carries `provisional` or `pinned` fee evidence. Provisional net values
must not be rendered as settled financial truth.

A staker payout remains unavailable until Sidekick proves that the raw fee-snapshot entry exists
for the exact cycle/bucket. The contract otherwise permits one pooled manager balance to fund an
unclaimed bucket while applying an absent fee as zero. Every manual queue and Assist adapter must
preserve this existing client-side solvency and fee invariant.

Exact checkpoint allocations require the reward-index delta and the account's shares at the
calculation anchor. Sidekick performs best-effort backfill, but never invents unavailable history.
Allocation coverage is explicit:

- `exact`: checkpoint shares and index delta are proved at the canonical anchor;
- `combined`: the on-chain account/delivery is proved but checkpoint amounts cannot be separated;
  or
- `unattributed`: settlement is proved but historical allocation inputs are unavailable.

The ledger can therefore start producing exact forward records immediately while retaining honest,
useful older settlement history.

### Withdrawal truth

Bitcoin-L1 payout state is not complete when the manager emits a withdrawal request. Sidekick tracks
the request through manager and registry evidence: pending, accepted or rejected, accepted awaiting
manager retirement, settled, or reclaimed. When the registry exposes completed sweep data, the case
retains the Bitcoin sweep transaction ID and evidence anchor.

Reclaimed, below-fee, and dust outcomes are exceptions rather than successful payouts. They are
shown per distribution. Sidekick may explain that a staker payout preference must change, but it
does not infer that a future distribution has already failed.

### Protocol breakers and timing

`rewards-paused` blocks only new PoX-5 manager claims. It does not block calculation, payouts from
funds the manager already pulled, or withdrawal settle/reclaim operations. Each derived stage
continues independently and explains the exact blocked boundary.

Late calculation has two urgency levels:

- delay within the current calculation window blurs checkpoint attribution and can change the bond
  waterfall, so the existing time/block grace produces the normal action escalation; and
- approaching the next half-cycle boundary risks crediting accrued value to a different holder set,
  so the projection emits a harder boundary-risk escalation.

Another caller winning the permissionless calculation race is successful external completion and
is absorbed by the same distribution.

### One neutral proposal, two execution envelopes

The sealed wallet-intent manifest pattern is the shared neutral proposal core; Sidekick does not add
a third competing plan artifact. A proposal binds anchored facts, the exact adapter/call/arguments,
deny-mode postconditions, expected effects, source identity, and completion predicate without
granting execution authority.

The execution envelopes are:

- **Manual/Observe:** the browser wallet owns payer selection, fee, nonce, signing, and broadcast.
  A compatibility attestation is not required. Sidekick independently verifies the returned
  transaction and canonical effect.
- **Assist:** a current compatibility attestation, dedicated adapter-specific signer capability,
  nonce reservation, fee policy, and explicit authorization bind the same proposal before signing.

Completion is evidence-driven in both modes. A matching external transaction may satisfy the work
without either envelope.

### Assist expansion remains separately gated

This ADR supersedes the assumption that every future Assist operation must be implemented inside
the single manager-claim adapter. It does **not** enable Assist, authorize another adapter, or relax
the current manager-claim safety contract.

Before additional Assist operations can ship, the engine is generalized with the existing manager
claim as its only tenant:

1. a closed code-backed adapter registry replaces hard-coded manager-claim routing;
2. the signer exposes an explicit method per reviewed adapter, never generic transaction signing;
3. nonce handling remains one transaction in flight initially but supports successive jobs without
   manual reset;
4. recovery uses durable bounded cursors rather than a process-local scan position; and
5. recurring authorization becomes a separately reviewed security object with operation switches,
   manager/network binding, value and fee caps, time-window budgets, expiry, pause, and revocation.

Per-transaction approval remains available. A standing policy cannot authorize a replan outside its
closed operation/cap/budget set, and every broadcast still receives last-moment authoritative
revalidation.

After that single-tenant refactor is proven, adapters are added in increasing value-transfer risk:

1. `calculate-rewards` (time-critical and no asset transfer);
2. manager `claim-rewards`;
3. `claim-staker-rewards`; and
4. withdrawal settlement and reclaim cleanup.

Issue #6 remains the authoritative Assist release gate, and issue #17 remains its technical and
governance companion. Independent security review, issuer ownership, Devnet/testnet evidence,
recovery exercises, Observe soak, and an explicit mainnet canary decision remain mandatory.

### Delivery phases

- **Phase 0 — delivered:** truthful reward UI and execution-neutral manual all-bucket manager
  claims, including repair of the legacy Observe wallet handoff.
- **Phase 1 — this decision:** architecture, safety invariants, and the implementation epic.
- **Phase 2 — read-only ledger and UI:** durable evidence objects, best-effort backfill,
  registry-aware withdrawal cases, and distribution/account projections. Approved UI mockups are
  the entry gate before Phase 2 implementation begins.
- **Phase 3 — manual completion:** withdrawal settle/reclaim intents, a server-persisted per-account
  settlement queue, sign-next flow, remembered signing account, and recovery guidance.
- **Phase 4 — single-tenant engine generalization:** registry, signer capabilities, nonce sequencing,
  and durable recovery with no new executable operation.
- **Phase 5 — release-gated Assist:** standing authorization and adapters in the order above.

## Consequences

The most valuable operator result—the truthful, externally reconciling ledger—ships before new
transaction authority. Manual and future Assist modes cannot drift into separate business
lifecycles because both consume the same proposals and the same chain-derived completion model.

The schema is more explicit than a single workflow table: weekly allocations, settleable accounts,
operations, and Bitcoin withdrawal cases are separate. That complexity reflects irreducible
protocol boundaries and prevents false one-to-one mappings between checkpoint money and
transactions.

Historical displays may say combined or unattributed. This is preferable to reconstructing exact
money values without anchor evidence. Full automation also remains intentionally deferred until its
new standing-policy authority and broader engine recovery model pass the existing release gates.
