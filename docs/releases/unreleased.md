# Unreleased

## Cheaper retained reads and background work (R4, combined remainder)

- Overview reads active operation authorities without loading terminal Activity history. Activity
  selects page keys in SQLite, then hydrates at most 200 historical groups per request. Older
  history remains reachable beyond the former 10,000-record window. A selective search may return
  an empty page with **Next**; transaction grouping and operation ownership precede pagination.
- Health pages reuse the collector's published diagnosis. Observer diagnostics reuse unchanged
  database results, and payload pruning skips the expensive retention pass while within the
  existing limits. Callback receipt rows, deduplication markers and financial history are retained.
  Full callback batches and history API pages yield to HTTP work between bounded batches.
- Genuine no-op synchronization no longer discards warm projections. Replay, roster/coverage
  changes, partial failures and reorgs still invalidate them. Ordinary changes retain explicitly
  stale data during refresh; known noncanonical data is dropped. A pre-change in-flight load
  cannot republish its old projection after invalidation.
- Compatible indexed/comparison API status reads share a 30-second advisory observation with its
  original timestamp. Endpoint, network and effective credentials determine sharing; different
  credentials on the same host are not independent health witnesses. Advisory rate limits honor
  bounded cooldowns, without nested client retries. Fresh preflight and transaction reads remain
  uncached. Deployment capability checks no longer invalidate just because a height or check time
  advanced; their existing one-minute expiry and explicit recheck remain.
- Focus refreshes are coalesced and spread over 100–499 ms; initial/manual reads remain immediate.
  The snapshot freshness gauge uses a 60-second generation-age budget, accommodating a 30-second
  interval plus collection time. Snapshot maintenance consults the existing cached connection
  assessor. Repeated run-wait warnings are logged on reason changes rather than every tick.
- Support downloads use retained diagnostics and mark unobserved sections unavailable, without
  starting live balance, connection, health or operator collection. Each asynchronous section has
  a two-second collection bound. This is a last-known diagnostic export, not a fresh preflight.
- Migration **41** adds read/retention indexes only. File-backed upgrades take the normal automatic
  backup; older binaries refuse the newer schema, so rollback requires the matching older database
  backup. No copied summary tables, receipt deletion, new scheduler, dependency change, signing
  authority, completion-policy change or new infrastructure requirement is introduced.

Local synthetic before/after and deterministic request budgets are review evidence, not a claim
about whole-instance daily traffic or live browser latency. See the measurement procedure in
[Operations](../operator/operations.md#local-read-performance-check).

## Bounded transaction observation (R4, first slice)

- Active runs check broadcast receipts every 30 seconds instead of every five-second recovery
  tick. Unavailable reads and transient read errors back off through five minutes; Retry-After
  from the active-run receipt path is capped at the same five-minute maximum. Oversized hints
  cannot stop observation for the rest of the run. The original runtime cap is still
  checked every tick, and the next child keeps every fresh pre-sign check.
- Unchanged canonical-success wallet observations whose additional action check is still pending
  now back off too. New evidence resets the ordinary cadence; manual refresh remains immediate.
- Reuses existing in-memory pacing and observation deduplication: no new scheduler, migration,
  evidence policy, signing/replacement permission or automatic resume. Normal run API pending/404
  responses remain on the 30-second cadence. Source outages and bounded cooldowns delay visibility of
  confirmation without inventing a failure or extending authority.

## API-supported browser-wallet execution (R3b, second commit)

- Browser-wallet actions may accept coherent configured-API execution during a node outage only
  with retained exact mempool verification tied to the same immutable intent and txid. Old API-only
  summaries do not qualify. Node bytes still use the full signature/call/postcondition verifier.
- A normal HTTP 200 pending/dropped API record no longer blocks node-mempool verification as a
  schema failure. It means no terminal API receipt, so exact node bytes can still be verified and
  retained for later API-supported completion. Dropped is not an abort or replacement permission;
  node observation and the existing missing-transaction propagation grace still apply.
- Proof survives missing observations and restart; pending/missing/unavailable reads cannot erase
  a positive conflict. One completion path handles node and API evidence, with additional
  calculation checkpoint, legacy-job and asset-semantic checks preserved. Known canonical
  execution remains visible if an extra check is unavailable; an abort is not lost to that outage.
- Manual refresh of submitted IDs works through cached node unavailability, with authentication,
  CSRF, startup and identity gates preserved. Fresh preparation, submission and replacement remain
  gated. Evidence source is shown in wallet details and Activity and saved in existing extensible
  observation metadata, without breaking the older strict verification object or adding a migration.
- No new scheduler, raw-byte storage, signing authority, automatic replacement, or infrastructure
  change. Cold boot still requires an accepted node connection. Active-run polling/backoff and
  nonce-proof sweep abandonment remain separate follow-ups.

## API-supported completion for locally signed work (R3b, first commit)

- Reward runs and gas sweeps can accept coherent configured-API canonical execution when local
  corroboration is unavailable, only with their retained signing-time txid and revalidated sealed
  plan binding. This is operational API trust, not cryptographic execution proof. API summaries
  cannot establish the byte binding. Positive node conflicts win, including retained diagnostics.
- Observation access is independent of cached node availability, but proven identity/network
  refusal and every fresh preparation/signing/broadcast gate remain. A canonical API abort is
  terminal even when the optional external-completion state read is unavailable. Nothing resumes
  a halted run automatically, signs a replacement, or abandons a missing sweep.
- Migration 40 adds nullable execution-source fields to run children and sweeps. Activity and
  sweep history display the source; old history remains unknown. Legacy halted-run diagnostics
  are preserved on submitted children and require node corroboration after explicit resume.
  File-backed databases receive the normal automatic backup before migration; rollback to an
  older binary requires the corresponding older database backup.
- Browser-wallet API-only completion is covered by the second slice above. Cold-start operational workers
  still wait for an accepted node connection. No transaction-index or other infrastructure change,
  signed-byte storage, terminal-history poller, or change to Bitcoin-delivery evidence is introduced.

## Exact wallet verification and submitted-work recovery (R3a, second commit)

- Wallets without a node transaction-index row now use exact bytes from the canonical block and
  the existing full manifest verifier. The weaker API-summary verifier is removed. Canonical
  aborts pass the same identity/inclusion checks; orphaned aborts cannot become failures.
- Positive canonical conflicts remain explicit across wallets, runs and gas sweeps. Temporary
  source unavailability preserves terminal wallet history; later mutable manager settings or
  re-accrued rewards no longer undo successful registration, admin/fee updates or staker claims.
- Existing server maintenance observes submitted wallets and broadcast sweeps after browser closure
  and restart, independently of signing readiness. Automatic dashboard polls read retained results;
  manual verification controls remain. Slow observation coalesces and shutdown drains it.
  Submitted-work scans run every 30 seconds, with per-item missing/unavailable backoff capped at five
  minutes. Missing work is never dropped; manual refresh remains immediate. This avoids perpetual
  five-second API polling for abandoned submissions without changing completion or signing rules.
- Sweeps save their locally produced txid before broadcast. Ambiguity and missing lookups retain
  the wallet authorization instead of expiring into permission to sweep again; positive conflicts
  are displayed. Concurrent approval and observation cannot duplicate broadcast or overwrite an
  observed confirmation. Permanently missing ambiguous sweeps require operator investigation.
- No database migration, signing-scope expansion or infrastructure change. Node-unavailable/API-only
  completion remains R3b; Bitcoin delivery and withdrawal retirement remain separate facts.

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
  change. The remaining R3a work is described above; node-unavailable/API-supported completion
  remains R3b.

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
