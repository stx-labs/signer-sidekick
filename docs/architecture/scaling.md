# Scaling and retained evidence

V1 targets one pool with hundreds of participants and many years of reward cycles on SQLite. The
test suite exercises 500 active stakers, 96 forecast cycles, thousands of claims, and hundreds of
withdrawals. These are fixtures, not hard limits.

## Bounded work

- API discovery is cursor-paginated and restartable.
- Node verification and transaction enrichment use fixed concurrency limits.
- Forecast reads are processed in cycle batches.
- Reconciliation and operator snapshots are single-flight.
- Dashboard collections are independently paginated and exportable.

The exact limits and accepted query parameters live with their configuration and route schemas.

## Evidence model

Current projections are separate from historical evidence:

- Current stakers, positions, and cycle memberships drive the operator view.
- Append-only observations preserve what the node reported at each tip.
- Per-cycle snapshots distinguish authoritative current state from projections.
- Canonical chain events retain reorg-aware source evidence.
- Normalized manager activity supports unbounded claim and withdrawal history.
- Reward snapshots are replaced within a cycle rather than appended on every read.

Historical rewards use membership retained for the requested cycle, not the current active roster.
Forward migrations create an online backup before changing an on-disk database.

## Regression contract

Scale-sensitive changes must demonstrate:

1. Correct pagination beyond former in-memory limits.
2. Concurrency bounds under a large roster.
3. No repeated enrichment after known event overlap.
4. No page-level horizontal overflow at desktop or mobile sizes.
5. Independent pagination for large reward and withdrawal histories.

The storage and browser tests are the authoritative executable specification.
