# Reward outlook and calculation contract

- Status: Implemented product and calculation contract
- Parent: [Scope and decisions](scope-and-decisions.md)
- Related: [Recurring operation contracts](recurring-operation-contracts.md)

## Purpose

Rewards answers four separate operator questions without mixing network-wide money with this pool's
money:

1. How much sBTC has PoX-5 accrued network-wide since the last reward calculation?
2. If rewards were calculated at the current anchor, how much would this pool, its stakers, and its
   operator receive?
3. What range is projected for the next protocol checkpoint, and how well has that model performed?
4. Is the permissionless calculation, manager claim, or a staker payout ready for action?

Every amount names its scope: **network-wide rewards**, **this pool's gross reward**, **operator fee**,
or **net for this pool's stakers**. The UI does not use unqualified labels such as “global accrued,”
“pool share,” or “actionable claim.”

## Authority and estimates

The configured local node is authoritative for current PoX-5 state. Sidekick reads one stable chain
anchor and keeps these values distinct:

- **Accrued so far:** exact `get-new-rewards` network-wide accrual.
- **If calculated now:** a contract-exact simulation at the current anchor, not a forecast. It is
  omitted unless the complete STX share state, every active Bitcoin-bond bucket, reserve state, and
  manager shares are available at that anchor.
- **Projected next allocation:** a run-rate range for the next first-half or second-half checkpoint.
  It is an estimate and always carries its sample window, assumptions, and confidence.
- **Realized calculation:** a node-verified `calculate-rewards` event and its actual pool allocation.

The simulator follows the vendored PoX-5 contract's exact bond ordering, integer-division order,
precision, reserve allocation, cumulative reward-per-share updates, and Clarity uint behavior.
Golden vectors execute the real contract for STX-only and mixed STX/Bitcoin-bond distributions.
Production calculation events are replayed from their parent anchor; a same-block state change that
prevents proving identical inputs is retained as canonical network evidence but not scored as a pool
forecast realization.

## Forecast model

The point forecast uses cumulative accrual since the prior calculation. The low and high bounds use
the slowest and fastest observed interval rates. Each global bound is passed through the exact pool
simulator at the same current share, bond, and reserve anchor; Sidekick never estimates the pool by
multiplying the global total by a simple percentage.

A forecast is available only after:

- at least three distinct observations spanning at least six Bitcoin blocks after a completed
  calculation; or
- at least 24 Bitcoin blocks of observed deltas before PoX-5's first calculation, because there is no
  trustworthy zero-accrual starting anchor.

Sampling confidence is:

- `low` after the minimum three observations and six-block span; and
- `developing` after at least six observations spanning at least 24 Bitcoin blocks.

Non-monotonic accrual, incomplete anchored inputs, or simulation failure omits the forecast instead
of substituting a stale or proportional estimate.

## Calibration

Model revisions have independent calibration histories. Sidekick evaluates the latest eligible
forecast made 144 through 156 Bitcoin blocks before each calculation so a last-minute observation
cannot make the model appear artificially exact.

`calibrated` requires all of the following for the current model revision:

- six node-verified realizations across at least three reward cycles;
- at least four non-zero pool outcomes;
- at least five of the six actual allocations inside their forecast ranges;
- median absolute point error no greater than 15%;
- median normalized range width no greater than 50%;
- a current `developing` forecast no more than 144 Bitcoin blocks from its checkpoint.

Until enough history exists, calibration is `collecting`. Enough history that misses the accuracy
limits is `failing`. Either result leaves the sampling confidence at `low` or `developing`; forecast
calibration is not a signer-health finding.

The typed thresholds and model revision live in `apps/sidekick/src/reward-calibration.ts`. A model or
threshold change starts a new calibration window and requires updated golden vectors and operator
documentation.

## Operator fee estimates

PoX-5 pool allocation remains available without manager-specific fee support. Operator-fee amounts
appear only when the manager's fee behavior matches a reviewed capability adapter and Sidekick has
the complete authoritative roster and per-staker share inputs.

The reference-like adapter applies the manager's per-staker, per-bucket integer rounding. An existing
cycle fee snapshot is authoritative. Before the manager has pinned that snapshot, the configured fee
is shown as an explicit assumption. Sidekick never substitutes `pool total × fee percentage` and
states the exact omission reason when fee semantics or inputs are unavailable.

## Calculation readiness

`calculate-rewards` is a permissionless protocol action. A newly eligible checkpoint is ordinary
**awaiting calculation** state, not immediately an operator alert. The wallet-signed action becomes
`action-required` only after both:

- ten minutes since Sidekick first proved eligibility; and
- 24 newer canonical Stacks blocks.

The node must still be advancing and every action witness must be current. A stalled chain or stale
witness produces an evidence-specific `needs-attention` result without offering a transaction.
Future unattended Assist remains independently release-gated and cannot become eligible before 30
minutes and 120 canonical Stacks blocks.

The calculation plan binds the exact PoX-5 profile, anchor, target cycle/checkpoint, prior calculation
height, global accrual, complete ordered active-bond set, and deterministic one-argument contract
call. Canonical completion requires the expected calculation height in PoX-5 state; if another caller
wins the permissionless race, Sidekick records the canonical outcome rather than asking for a
replacement transaction.

## Recovery and history

A bounded, resumable anti-entropy scan recovers PoX-5 calculation prints from the indexed API and
verifies canonical transactions against the local node. It persists the realization and cursor
atomically, revalidates the calibration window for reorgs, and retains an explicit reason when the
historical node cannot prove the pool inputs needed for scoring. This contract-wide calculation scan
is distinct from pool-member history: joins and exits are recovered only through current-member
principal streams as described in [Fresh-install data recovery](fresh-install-data-recovery.md).

Rewards, Overview, Activity, and the support snapshot consume the same persisted calculation,
forecast, fee, calibration, and evidence records; the browser does not recompute them.
