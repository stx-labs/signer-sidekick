# ADR 0003: Local operator auth and key separation

- Status: Accepted
- Date: 2026-07-14

## Decision

V1 is a single-operator service. The supplied deployment publishes on loopback by default; remote
access requires an operator-managed authenticated reverse proxy. Sidekick may hold only one signing
key: a dedicated, deliberately low-balance gas payer.

Signer and manager-admin private keys stay outside Sidekick. Deployment and `register-self`
operations are emitted as reviewable artifacts or call arguments for external signing and broadcast.

## Consequences

OIDC, multiple users, roles, and embedded signer/admin signing are deferred. Any future custody
expansion requires a new threat model and ADR.
