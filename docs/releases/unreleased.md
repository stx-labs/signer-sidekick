# Unreleased

## Operator changes

- Reviewed managers accept exact or canonical program matches, including supported comment and
  whitespace variants. Execution environment and required functions still match; sealed actions
  retain the deployed raw source hash. Changed interpretation replays retained history, including
  after downgrade and re-enable.
- Missing reward interpretation or live evidence no longer appears as a completed, zero-payment
  distribution. Departed members and truncated history remain coverage labels. Fees use account
  evidence; bounded contract rounding is reported separately, never invented as income. Overview
  separates current accrual from the pending one-week forecast.
- Connection and worker-start failures recover without an open browser. Running reward runs wait
  through typed transient read failures within their original deadline; ambiguous broadcasts,
  positive conflicts and hard refusals still halt.
- Submitted wallets and gas sweeps are observed after browser closure and restart. Sweeps save
  their txid before broadcast and keep authorization while the outcome is ambiguous.
- Runs/sweeps may use coherent configured-API execution during node unavailability when their saved
  signing-time binding revalidates. Wallets need retained exact mempool verification for the same
  intent/txid, otherwise node bytes. Positive conflicts veto API-only completion. Details show the
  source; additional action checks and Bitcoin arrival remain distinct from execution.
- Pending/dropped API records no longer prevent node-mempool verification. Dropped does not mean
  an on-chain abort or automatic replacement.
- Transaction checks normally run every 30 seconds. Unavailable reads back off to five minutes;
  wallet/sweep absence and unchanged pending extra checks also back off. Active-run Retry-After
  is capped at five minutes. Manual refresh/resume remains immediate; no deadline is extended.
- Slow page reads finish without parent-timestamp cancellation. Refresh failures retain useful
  data and offer retry; acknowledged Settings saves stay successful. External gas-wallet funding
  appears without a page reload. Saved wallet intents remain accessible by ID.
- Activity groups by occurrence time and pages history in SQLite, without the former 10,000-row
  history window. Selective searches can return an empty page with **Next**. Overview reads only
  active authorities; terminal runs have no actionable deadline.
- Health and observer reads reuse retained results. No-op synchronization keeps warm projections;
  changed evidence, replay and reorgs invalidate them. History/callback batches yield to HTTP work.
  Raw callback payload pruning retains receipt identities and duplicate/conflict evidence.
- Compatible indexed/comparison API status reads share a 30-second advisory result. Advisory
  rate limits use bounded cooldowns without nested retries; distinct credentials on one origin
  are not independent health witnesses. Fresh preflight/transaction reads remain uncached.
- Support downloads use retained, timestamped diagnostics and mark missing sections unavailable,
  with bounded collection rather than new upstream probes.

These changes add no infrastructure prerequisite, signing authority, automatic replacement or
unattended-run mode. Local benchmark and deterministic request budgets are not a daily traffic
guarantee; measure each instance with [Operations](../operator/operations.md).

## Upgrade and recovery

Back up the database, gas-wallet key and deployment configuration as one protected restore set.
Migration **40** adds nullable run/sweep execution provenance and preserves legacy halted-run
diagnostics; **41** adds ten read indexes without rewriting financial rows. On-disk upgrades take
an automatic pre-migration backup. Older binaries refuse newer schemas: rollback needs a compatible
database, and restoring must not discard a newer submission. Follow [Operations](../operator/operations.md#upgrade).

`/health/operational` returns 503 `operational-startup-pending` until workers start; failed startup
retries automatically. Liveness/readiness remain diagnostic surfaces. Snapshot freshness now uses
generation age with a 60-second default budget; monitor age, failures, in-progress and last success
separately. Recovery timers can combine to about ten minutes plus request/startup time.

Cold boot still waits for a connected node to start operational workers. Halted runs require explicit
resume; a permanently missing ambiguous sweep needs investigation, not another sweep. The
accepted-withdrawal cache's known-reorg display limitation remains. See
[completion policy](../architecture/decisions/0008-chain-evidence-and-reconciliation.md).

## API and export compatibility

- **Breaking rename:** `sourceReview.exactReviewed` → `sourceReview.reviewed` in REST/support
  output. Inspect `sourceReview.match` when exact-byte provenance matters.
- Ledger status adds `interpretation-unavailable`. Paid-fee/cycle/indexed earned totals can be
  null; unknown CSV values are blank, not zero.
- Optional distribution `allocation` reports row-derived coverage and estimated fees.
  `roundingSats` and `poolBasis` (`collected` or `simulation`) describe reconciliation, not
  additional fees. CSV appends `allocation_rounding_sats` and `allocation_pool_basis`; use headers.
- Overview adds optional `accruedPoolRewardSats`; a forecast is not a substitute for missing accrual.
- Run/sweep `executionSource` and wallet `verification.executionSource` retain evidence provenance.
  Older history has no guessed source. The snapshot `refreshInProgress` support field and
  `sidekick_operator_snapshot_refresh_in_progress` gauge distinguish work from failure.
