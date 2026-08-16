# ADR 0003: Operator auth and custody boundary

- Status: Accepted
- Date: 2026-08-16

## Decision

V1 is a single-operator service. It listens on loopback by default. Remote access uses an SSH
tunnel, an operator-controlled private network, or an authenticated TLS reverse proxy; unauthenticated
HTTP is not a public deployment mode.

Sidekick never receives a signer key, manager-admin key, mnemonic, signed transaction bytes, or
generic signing request. Manager administration, signer registration, and Observe reward claims
are expressed as sealed, expiring wallet intents. The browser wallet signs and submits them; the API
receives only the transaction ID and independently verifies the canonical transaction and expected
poststate.

Assist may read one dedicated, deliberately low-balance gas-payer key from an explicit absolute
file path. That key can sign only fixed transaction vectors implemented by reviewed adapters. The
main configuration loader rejects private-key environment variables, and private keys are never
stored in SQLite.

## Consequences

Browser-wallet integration grants neither custody nor arbitrary transaction authority. Assist is a
narrow execution mode, not embedded operator-wallet custody. Multiple users, delegated roles,
embedded signer/admin signing, or any broader custody model require a separate threat model and
architecture decision.
