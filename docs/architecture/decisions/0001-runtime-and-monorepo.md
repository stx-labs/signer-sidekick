# ADR 0001: TypeScript monorepo and runtime

- Status: Accepted
- Date: 2026-07-14

## Decision

Use a pnpm workspace with strict TypeScript, Node.js 24.18.0 LTS, Fastify for the local service,
and React/Vite for the operator dashboard. Keep protocol and domain boundaries in internal
workspace packages until a second consumer proves a public package boundary.

## Consequences

The default installation remains one container. Internal packages share its release cadence until a
second consumer justifies independent versioning. Persistence is governed by
[ADR 0005](0005-sqlite-persistence.md).
