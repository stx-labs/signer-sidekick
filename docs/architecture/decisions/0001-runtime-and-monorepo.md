# ADR 0001: TypeScript monorepo and runtime

- Status: Accepted
- Date: 2026-07-14

## Decision

Use a pnpm workspace with strict TypeScript, Node.js 24.18.0 LTS, Fastify for the local service,
and React/Vite for the operator dashboard. Keep protocol and domain boundaries in internal
workspace packages until a second consumer proves a public package boundary.

Use SQLite in WAL mode with one active writer for v1. The exact typed query layer is deferred
until the first persistence slice, when Drizzle will be evaluated against migration and
replay requirements.

## Consequences

The default installation remains one container and one persistent volume. Horizontal scaling,
Postgres, and independently versioned internal packages are outside v1.
