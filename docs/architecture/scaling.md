# Scale and longitudinal data design

Signer Sidekick is intended to remain usable after a pool has operated for many reward cycles,
not only during its first enrollment window. The v1 implementation has been exercised with a
synthetic pool containing 500 active stakers, a 96-cycle forecast, 4,000 claim events, and 400 L1
withdrawal requests.

These are validation fixtures, not product ceilings. The persistent event and observation tables
do not impose those limits.

## Reconciliation bounds

- Signer-staker discovery remains cursor-paginated and restartable. Up to four stakers are
  node-verified concurrently by default, with a validated range of 1 through 16. Exact cycle
  membership reads remain batched within each staker.
- Forecast contract reads process eight reward cycles at a time. Local memberships are grouped by
  cycle once, avoiding a full membership scan for every forecast column.
- Manager log transaction enrichment is limited to eight concurrent requests. A completed scan
  stops at a page of known overlap without fetching the same transaction metadata again.
- Operator snapshot loads and manual reconciliations are single-flight: concurrent browser
  requests share the same in-progress operation instead of multiplying node/API traffic.

## Durable evidence

SQLite schema version 6 separates current projections from longitudinal evidence:

- `stakers`, `stake_positions`, and `cycle_memberships` are the current operator view.
- `staker_position_observations` records the node-verification result and position at each observed
  burn/Stacks tip pair. A changed or missing position does not erase the earlier observation.
- `pool_cycle_snapshots` records local and contract totals for every observed reward cycle. The
  history API returns the most recent observation for each cycle while retaining the underlying
  observations for audit work.
- `chain_events` remains the reorg-aware raw evidence ledger.
- `manager_activity_events` is a normalized, indexed projection of claims and withdrawal
  resolutions. Reads are no longer limited by the former 2,000-event reducer ceiling.
- `reward_cycle_snapshots` and `staker_reward_cycle_snapshots` retain the latest computed ledger
  for each manager/cycle pair. Rows are replaced within a cycle rather than appended on every
  dashboard read, bounding storage to the number of cycles and participating stakers.

Forward database migrations create an online backup before modifying an existing on-disk store.
The normal deployment backup/restore procedure remains the operator's disaster-recovery path.

## Bounded operator APIs

All large dashboard collections are authenticated and independently paginated:

| Endpoint | Collection | Default / maximum page |
| --- | --- | --- |
| `GET /api/v1/pool` | current roster, with principal search | 50 / 200 |
| `GET /api/v1/pool/history` | latest observation per historical cycle | 50 / 200 |
| `GET /api/v1/rewards` | current per-staker reward state | 50 / 200 |
| `GET /api/v1/rewards/history` | retained reward-cycle summaries | 50 / 200 |
| `GET /api/v1/activity` | claim and withdrawal ledgers | 50 / 200 each |

The status response contains collection totals and summary values instead of embedding the full
roster and reward ledger. Full CSV/JSON roster exports remain explicit authenticated downloads.

Offsets are accepted up to 10,000,000. That is ample for the expected operator scale; if a future
deployment reaches millions of events, manager activity should gain opaque keyset cursors while
retaining these offset parameters for compatibility.

## Dashboard behavior

- Roster, per-staker rewards, claim history, and withdrawal history render at most 50 rows each.
- Claim history can be filtered across the current and previous 95 reward cycles.
- A long forecast scrolls inside its card and cannot widen the page.
- At tablet/mobile widths the desktop sidebar becomes a page picker, tables scroll inside their
  own containers, and pagination controls remain within the viewport.

## Regression expectations

Scale-sensitive changes should keep the following checks green:

1. A normalized manager ledger can retrieve pages beyond event 2,000 with the correct total.
2. The current roster verifier demonstrates concurrent reads without exceeding its worker bound.
3. Known manager-log overlap performs no transaction enrichment calls.
4. At 500 stakers and 96 cycles, the pool page renders 50 roster rows and has no document-level
   horizontal overflow at 1440px or 375px.
5. At 4,000 claims and 400 withdrawals, each rewards table renders 50 rows and exposes independent
   pagination.
