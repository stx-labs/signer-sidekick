# Scaling and retained evidence

Plan for one pool with about 100 stakers and many years of reward cycles on SQLite. The
test suite exercises 500 active stakers across 12 cycles and more than 2,000 persisted claims;
browser fixtures cover hundreds of claims and dozens of withdrawals. These are fixtures, not hard
limits.

## Bounded work

- API discovery is exact-tip-fenced, cursor-paginated, and persisted by page. A sealed roster is
  then verified against its pinned node anchor and revalidated before commit.
- Node verification and transaction enrichment use fixed concurrency limits.
- Forecast reads are processed in cycle batches.
- Reconciliation and operator snapshots are single-flight. Reconciliation runs in the background
  with process-local progress; persisted discovery can resume after a restart.
- Dashboard roster, reward, withdrawal, and job collections paginate independently; roster data is
  exportable as CSV or JSON.
- Reward history selects cycles before loading their evidence. `beforeCycle` pages older cycles;
  explicit cycle requests do not compete with newer payments for a global window. Accounting
  downloads walk the cycle pages, with bounded per-period safety limits and honest partial labels.
- Historical fee totals are cached independently of snapshot freshness. Payment/replay/reorg writes
  and external database commits invalidate them; ownership reads use only the selected txids.
- Pending Bitcoin withdrawal display reads share a 30-second request/anchor result. Retained payout
  proof wins; transaction checks remain fresh. Submitted-wallet scans hydrate only due work.
- Activity applies cursors and limits inside each source query, retaining transaction grouping and
  global ownership exclusion. No copied Activity ledger or new database service is needed.

The exact limits and accepted query parameters live with their configuration and route schemas.

## Evidence model

Current projections are separate from historical evidence:

- Current stakers, positions, and cycle memberships drive the operator view.
- Pool/position detail keeps a 21-day troubleshooting window. Older samples retain position changes
  and observations bracketing actual cycle/half-cycle boundaries, plus first/latest state. Position
  comparisons include bond details and per-cycle memberships, not only aggregate STX amounts.
- Unknown legacy anchors, incomplete reads, quality/source changes and observed rewinds are kept
  conservatively. Boundaries retain their actual sample time/height, not an invented exact checkpoint.
- Per-cycle snapshots distinguish current values from projections; unchanged anchored values do
  not rewrite the same snapshot. Collection freshness comes from the published operator snapshot.
- Canonical chain events retain reorg-aware source evidence.
- Normalized manager activity retains paginated claim and withdrawal history without the former
  in-memory ceiling.
- Payments, calculations, transaction binding/completion/conflict evidence, and active authorities
  have no age-based deletion. Observer receipt identities are outside this snapshot policy.

Historical rewards use membership retained for the requested cycle, not the current active roster.
Forward migrations create an online backup before changing an on-disk database.
Snapshot compaction examines at most 250 old rows per table every five minutes on the existing
background loop. Retained markers survive restart; each batch is transactional. It never runs on
callback admission, transaction preparation or startup. Freed SQLite pages are reused, not vacuumed.

## Regression contract

Scale-sensitive changes must demonstrate:

1. Correct pagination beyond former in-memory limits.
2. Concurrency bounds under a large roster.
3. No repeated enrichment after known event overlap.
4. No page-level horizontal overflow at desktop or mobile sizes.
5. Independent pagination for large reward and withdrawal histories.
6. Live-tip advancement does not invalidate pinned roster verification, while a reorged anchor does.

The storage and browser tests are the authoritative executable specification.
After building, `node scripts/benchmark-history-reads.mjs [checkout]` compares retained reads on
isolated synthetic databases. It measures SQLite work, not production RPC or page latency.
