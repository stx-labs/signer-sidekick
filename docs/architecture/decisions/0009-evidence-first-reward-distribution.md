# ADR 0009: Evidence-first reward accounting

- Status: Accepted
- Date: 2026-08-22
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

An operation record cannot answer whether every account for a distribution has been delivered or
financially reconciled. Transaction ownership is also the wrong lifecycle authority when external
callers are expected.

## Decision

### Chain evidence is the lifecycle authority

A reward distribution is a projection of canonical chain evidence, not a workflow Sidekick
executes. Sidekick continuously derives calculation, manager-pull, account-settlement, withdrawal,
and exception state regardless of who submitted each transaction.

Wallet intents and reward runs remain execution and audit records. They may contribute
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

The ledger is a read-time projection over calculation realizations, manager events, staker-account
reads, withdrawal evidence, wallet intents, and reward runs. Typed repositories keep each evidence
source durable; no second mutable workflow owns financial state.

The projection preserves these rules:

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
unclaimed bucket while applying an absent fee as zero. Every wallet intent and operator-run child
preserves this client-side solvency and fee invariant.

Exact checkpoint allocations require the reward-index delta and the account's shares at the
calculation anchor. Sidekick performs best-effort backfill, but never invents unavailable history.
Allocation coverage is explicit:

- `exact`: checkpoint shares and index delta are proved at the canonical anchor;
- `combined`: the on-chain account/delivery is proved but checkpoint amounts cannot be separated;
  or
- `historical-coverage-incomplete`: required evidence is outside the recovery boundary.

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

## Consequences

Historical displays may be `combined` or `historical-coverage-incomplete`; that is preferable to
inventing exact money values. Financial state remains independent from browser-wallet or
operator-run availability. Execution safety is defined by
[ADR 0010](0010-operator-run-execution-envelope.md).
