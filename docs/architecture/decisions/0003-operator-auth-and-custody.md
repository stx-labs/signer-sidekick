# ADR 0003: Operator auth and custody boundary

- Status: Accepted
- Date: 2026-08-16

## Decision

Sidekick is a single-operator service and listens on loopback by default. Remote access uses an SSH
tunnel, private network, or authenticating TLS proxy. Browser mutations remain protected against
cross-site requests when authentication is supplied ambiently by Basic auth or a trusted header.

Sidekick never receives a signer key, manager-admin key, mnemonic, signed browser transaction, or
generic signing request. Wallet actions are sealed, expiring intents; the API receives only a txid
and independently verifies the canonical transaction and expected state.

Operator-run may hold one Sidekick-generated, low-balance gas-wallet key. It is stored outside
SQLite with owner-only permissions and signs only reviewed recipe operations through explicit
adapter methods. The configuration loader rejects private-key environment values. The key is never
returned by the API, logged, or included in Activity or support output.

## Consequences

The gas wallet is fee-payer custody, not signer or administrator custody. Its authority is bounded
by its STX balance, the sealed recipe, postconditions, and the one-active-run nonce lease. Multiple
operators, delegated roles, or broader signing authority require a new threat model and ADR.
