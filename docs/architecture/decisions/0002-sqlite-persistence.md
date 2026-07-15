# ADR 0002: Built-in SQLite with a narrow typed repository

- Status: Accepted
- Date: 2026-07-14

## Context

Milestone 3 needs a durable read model, per-provider cursors, replayable raw chain evidence,
forward-only migrations, and automatic pre-migration backups. The runtime is already pinned to
Node.js 24.18.0, which includes [`node:sqlite` and its online backup
API](https://nodejs.org/download/release/v24.18.0/docs/api/sqlite.html).

ADR 0001 deferred the query-layer choice until this persistence slice. Drizzle now documents a
[native `node:sqlite` driver](https://orm.drizzle.team/docs/sqlite/connect-node-sqlite), but that
driver and its setup tooling are still distributed on the Drizzle release-candidate track. Adding
it here would place another pre-stable layer above a small schema and would not remove the need to
review the actual SQL used for cursor and replay behavior.

## Decision

Use the pinned Node.js `node:sqlite` driver directly behind a narrow, typed `SidekickStore`
repository for v1. Do not expose `DatabaseSync` outside the storage module.

The storage boundary must:

- Enable WAL mode for file databases, foreign keys, a busy timeout, and defensive defaults.
- Apply ordered, checksummed, forward-only migrations transactionally.
- Refuse a database newer than the running build or one whose applied migration checksum changed.
- Back up an existing file before applying a newer migration.
- Store raw chain evidence separately from decoded projections.
- Scope cursors to a stable hash of network and API base URL.
- Preserve first-seen evidence while allowing canonicality and decoded data to be updated during
  overlapping replay.
- Keep protocol integers as canonical decimal strings inside JSON/projection fields.

## Consequences

The application has no native addon or ORM dependency in this slice, and the SQL responsible for
replay, uniqueness, and reorg handling stays explicit. Repository methods and Zod schemas provide
the typed boundary.

`node:sqlite` is release-candidate functionality in Node.js 24, so the exact Node patch remains a
release invariant and file-backed migration/backup behavior stays in CI tests. Re-evaluate Drizzle
when its `node:sqlite` support reaches a stable release or when query complexity grows enough to
justify it. The schema uses ordinary SQLite tables and constraints, so adopting Drizzle later does
not require a database-format migration merely to change the query layer.
