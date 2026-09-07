# Unreleased

## Active-run read recovery (R3a, first commit)

- Typed upstream unavailability, rate limits and retryable anchor capture no longer halt an
  already-running reward run. The existing tick retries reads within the original runtime cap;
  cached connection unavailability remains distinct from hard identity/network refusal.
- Preparation-anchor proof stays before each child is materialized, but no longer runs during
  every submitted-child observation. Transaction confirmation requirements remain unchanged.
- Concurrent recovery ticks coalesce; shutdown drains in-flight work. After slow role checks,
  the signature boundary rechecks expiry, run state and emergency controls. Unknown exceptions,
  positive preparation-anchor mismatch and potentially ambiguous submission still halt.
- No automatic halted-run resume, replacement transaction, database migration or infrastructure
  change. Exact wallet fallback verification, typed API conflicts and background wallet/sweep
  observation remain the next R3a commit; node-unavailable/API-supported completion remains R3b.

## Background recovery and dashboard refresh (R2)

- Connection assessment now retries without an open browser, using the existing bounded,
  single-flight assessor and background loop. Transient unavailable results and asynchronous
  worker-start failures back off; positive deployment/network refusals still block startup.
- `/health/operational` returns HTTP 503 with `operational-startup-pending` until operational
  workers finish starting, including during background startup retries. Liveness and readiness
  stay available for diagnosis; a connected node and retained snapshot alone do not prove startup.
- Rewards, its Overview card, Pool rows, and reward-run Settings use bounded visible-page polling
  and focus refreshes. Parent snapshot timestamps no longer cancel slower resource reads. Public
  gas-wallet status is shared only within the same credential/network/manager context; credentials
  are not persisted in that cache.
- Open payment history retries on focus, reopening, changed distribution evidence, or an explicit
  retry. Refresh errors retain existing payment rows. Resource-specific errors stay visible instead
  of converting an unavailable read into an empty table or zero balance.
- Acknowledged Settings saves remain successful if subsequent status revalidation fails. External
  gas-wallet funding is picked up without manually reloading Settings.
- Prepared browser transactions stay accessible by an `intentId` action URL and through Activity,
  including terminal transactions. Changing balances or snapshot freshness no longer removes that
  view. Fresh preparation/signing gates and server-side pre-sign revalidation still apply.
- Activity day headings use the event occurrence time. Terminal reward runs have no actionable
  deadline; their original approval expiry and runtime cap remain in the detail timeline.
- Distribution calculation notes label paid-fee subtotals as **known paid fee**, including mixed
  known/unknown fee evidence. No fee accounting rule changes in this slice.

### Freshness and recovery limits

`sidekick_operator_snapshot_fresh` now measures the retained snapshot's generation age, not the
worker's last completion time or absence of errors. The added
`sidekick_operator_snapshot_refresh_in_progress` gauge (and support-bundle `refreshInProgress`
field) separates an ongoing refresh from failure. Existing age, failure and last-success metrics
remain. Update consumers that treated the old freshness gauge as a universal health verdict.

With current defaults, connection and snapshot retry timers together can delay recovery by about
ten minutes, plus request/startup time after upstream recovery. An already-halted run
is not automatically resumed. R2 alone did not change active-run error handling; the R3a read-recovery
change above adds bounded waiting for typed transient errors, not transaction submission retries. No database
migration, node-indexing requirement, infrastructure change, or new signing authority is introduced.

## Manager compatibility and reward truth (R1)

- Reviewed managers may match the pinned source exactly or through the existing canonical
  recognition. Required functions, execution-version restrictions and independently rendered
  reference-program checks remain; transaction adapters still bind the deployed raw source hash.
- Manager history replays after vocabulary changes, including downgrade and re-enable, using
  existing event upserts rather than a new history store.
- Missing interpretation, live reads or incomplete recovery no longer appear as completed,
  zero-payment distributions. Historical membership departures and truncated evidence stay
  coverage labels, without reopening completed distributions that have payment evidence.
- Reward allocations sum actual account fees instead of treating a pool remainder as income.
  Reconciliation prefers actual collected amounts and accepts bounded contract rounding, even
  when the pool simulation is missing. Rounding is shown separately and is not earned fees.
- Overview separates current accrued rewards from the pending one-week distribution forecast.
  Cycle totals are explicitly labeled as cycle totals; the mobile fee forecast is one-week only.

### API and export compatibility

- **Breaking response rename:** manager verification `sourceReview.exactReviewed` is now
  `sourceReview.reviewed`. Update REST and support-bundle consumers; the old property is no
  longer emitted. `reviewed` includes exact and canonical recognition, not semantic equivalence.
  Consumers needing exact byte-match provenance must also inspect `sourceReview.match`.
- Ledger distribution status adds `interpretation-unavailable`. Distribution paid-fee totals,
  cycle earned-fee totals and the indexed earned-fee amount may be null when evidence is missing.
  Cycle totals do not silently count an unknown paid fee as zero. Unknown CSV values are blank.
- Optional distribution `allocation` contains row-derived amounts, amount coverage and estimated
  fee state. Its optional `roundingSats` and `poolBasis` fields describe bounded rounding and
  whether reconciliation used `collected` or `simulation` amounts. Existing allocation responses
  without these fields remain accepted. Rounding never increases `operatorFeeSats`.
- Distribution CSV appends `allocation_rounding_sats` and `allocation_pool_basis`. Consumers
  should resolve columns by header; existing columns retain their names and ordering.
- Overview adds optional `accruedPoolRewardSats`. Clients must not substitute an end-of-period
  forecast for a missing accrued value.

This slice does not change transaction-completion evidence, signing permissions, node indexing
requirements, run retry policy, infrastructure, or the database schema.
