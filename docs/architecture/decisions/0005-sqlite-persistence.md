# ADR 0005: SQLite behind a typed repository

- Status: Accepted
- Date: 2026-07-14

## Decision

Use Node's built-in `node:sqlite` behind typed repositories composed by `SidekickStore`. Database
handles and SQL do not cross the storage-module boundary. Transaction-engine, wallet-intent,
health, observer-inbox, deployment-identity, runtime-settings, manager-trust, and chain-cursor
queries have separate repository boundaries; `SidekickStore` owns the shared connection and
lifecycle.

File databases use WAL with `synchronous=FULL`, foreign keys, a busy timeout, checksummed
forward-only migrations, and an automatic pre-migration backup. The store separates raw chain
evidence from projections and scopes ingestion cursors to their network/API source.

## Consequences

V1 has one SQLite writer and no ORM or native addon. Replay, uniqueness, and reorg behavior remain
explicit and testable. Reconsider a query layer or Postgres only when demonstrated query or scaling
needs justify it.
