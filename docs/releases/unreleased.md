# Unreleased

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
