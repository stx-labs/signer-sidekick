# ADR 0003: Local operator auth and key separation

- Status: Accepted
- Date: 2026-07-14

## Decision

V1 is a single-operator, loopback-bound service. Remote access is deployed behind an operator-
managed authenticated reverse proxy. Sidekick may hold only a dedicated, deliberately
low-balance gas-payer key.

Signer and manager-admin keys stay outside Sidekick. Admin-only operations are represented as
transparent unsigned call manifests that the operator signs and broadcasts externally.

## Consequences

OIDC, multiple users, roles, and embedded signer/admin signing are deferred. Any future custody
expansion requires a new threat model and ADR.
