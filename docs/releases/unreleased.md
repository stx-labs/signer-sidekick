# Unreleased

## Dependency security

- Update Fastify to 5.12.1, fast-uri to 3.1.6/4.1.3, Vitest to 4.1.11, PostCSS to
  8.5.23 and Nano ID to 3.3.18. Transitive overrides preserve each major version;
  no operator configuration changes.
- Two dashboard wallet-chain advisories remain: `decode-uri-component`
  ([GHSA-vcc3-ghjq-m6fr](https://github.com/advisories/GHSA-vcc3-ghjq-m6fr)) needs a compatible
  SDK update because its patched release is ESM-only but its caller uses CommonJS;
  `elliptic` ([GHSA-848j-6mx2-7j84](https://github.com/advisories/GHSA-848j-6mx2-7j84)) has no
  patched release. Neither alert is suppressed; this update is not a clean security audit.

## Operator changes

- Mobile Rewards keeps expanded projection values inside their card and stacks the network
  reward label above its value. Populated accuracy tables and copy feedback stay inside the card.
- Overview labels estimates with their own weekly distribution, not the last completed calculation.
  Pending work stays first; completed history is no longer labelled as accruing.
- Pool/position snapshots keep 21 days of detail, then retain meaningful changes and actual
  cycle/weekly-distribution boundary samples. Unclassifiable legacy rows stay; financial evidence
  and observer receipt identities are not pruned. Identical anchored snapshots avoid repeat writes.
- Rewards can page older cycles and export payments across retained cycles without a global
  newest-payment window. Historical fees reuse unchanged evidence; different views share pending
  Bitcoin withdrawal reads. Activity seeks by its cursor and submitted-wallet scans load only due
  manifests. No new dependencies, service or transaction authority.
- Observer metrics/status no longer rescan lifetime delivery history after every callback.
  Committed inbox changes update disposable counters; queue/gap checks use indexed live reads.
  History, admission limits and verification rules are unchanged; no migration or configuration change.
- Event-inbox overflow no longer stalls the node: Sidekick acknowledges and discards excess
  notifications, then catches up through normal verified reconciliation. Overflow warnings and catch-up
  requests are limited to once per minute; retained callbacks and financial records are unchanged.
- Background reward/forecast collection reuses identical anchored contract reads and limits its
  concurrent reads to eight. Observer-gap checks reuse recent health samples. Explicit preparation,
  canonical verification, five-second health sampling and callback freshness targets are unchanged.
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
- Superseded wallet checks honor their own cadence; API failure no longer prevents independent
  node-mempool verification. Calculate uses the sealed checkpoint in its canonical receipt.
- Unknown calculated amounts remain unknown. Acknowledged emergency controls survive older page
  reads, and refresh errors stay visible alongside retained payments.
- Ledger requests share concurrent work and carry page timing/calculation context. Pending cards
  avoid unnecessary payment reads; Activity, maintenance and ownership reads avoid unused detail.
  Manager cache size is bounded, empty observer polls retain cached status, and reused advisory
  failures cannot extend cooldowns.

These changes add no infrastructure prerequisite, signing authority, automatic replacement or
unattended-run mode. Local benchmark and deterministic request budgets are not a daily traffic
guarantee; measure each instance with [Operations](../operator/operations.md).

## Upgrade and recovery

**Existing event-observer deployments:** set `disable_retries = true` in the Stacks node's
Sidekick-specific `[[events_observer]]` entry, then apply a coordinated node restart. Leave the
signer's own observer and other consumers unchanged. Upgrading Sidekick does not edit node TOML.
The CLI and Settings now generate this value. A bounded nonblocking dispatcher can still block
when full; disabling retries also protects node progress while Sidekick is offline. Missed
notifications are recovered by polling once the node and indexed API are available.

Back up the database, gas-wallet key and deployment configuration as one protected restore set.
Migration **40** adds nullable run/sweep execution provenance and preserves legacy halted-run
diagnostics; **41** adds ten read indexes, **42** indexes settings revisions, and **43** adds
snapshot retention metadata and history-read indexes without rewriting financial rows. On-disk
upgrades take an automatic pre-migration backup. Older binaries refuse
newer schemas: rollback needs a compatible
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

- Ledger accepts `beforeCycle` and returns optional `pagination.nextBeforeCycle`. Follow the cursor
  for older cycles; `scope=all` ledger reads are paged. CSV/JSON downloads traverse the cycle pages
  before declaring completeness. Per-period safety limits still produce partial downloads, and
  optional `fees.refundsTruncated` identifies the existing bounded refund-event list.
- **Breaking rename:** `sourceReview.exactReviewed` → `sourceReview.reviewed` in REST/support
  output. Inspect `sourceReview.match` when exact-byte provenance matters.
- Ledger status adds `interpretation-unavailable`. Paid-fee/cycle/indexed earned totals can be
  null; unknown CSV values are blank, not zero.
- Optional distribution `allocation` reports row-derived coverage and estimated fees.
  `roundingSats` and `poolBasis` (`collected` or `simulation`) describe reconciliation, not
  additional fees. CSV appends `allocation_rounding_sats` and `allocation_pool_basis`; use headers.
- Overview adds optional `accruedPoolRewardSats`; a forecast is not a substitute for missing accrual.
- Ledger adds optional `context` with retained Bitcoin timing and calculation realizations.
- Run/sweep `executionSource` and wallet `verification.executionSource` retain evidence provenance.
  Older history has no guessed source. The snapshot `refreshInProgress` support field and
  `sidekick_operator_snapshot_refresh_in_progress` gauge distinguish work from failure.
