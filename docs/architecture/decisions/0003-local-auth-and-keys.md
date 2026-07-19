# ADR 0003: Local operator auth and key separation

- Status: Accepted
- Date: 2026-07-14

## Decision

V1 is a single-operator service. The supplied deployment publishes on loopback by default. Remote
access may use an SSH tunnel, an operator-controlled private network, or an authenticated TLS reverse
proxy. Direct HTTP is supported only on a trusted private network; it is unsafe on an untrusted or
public network. Sidekick may hold only one signing key: a dedicated, deliberately low-balance gas
payer.

Signer and manager-admin private keys stay outside Sidekick. Sidekick may prepare deployment,
`register-self`, admin membership, fee, fee-withdrawal, fee-refund-sweep, and an already-preflighted
Observe reward-claim request for an external wallet or manual signer. Its API receives only the
txid and independently verifies the transaction and poststate. Browser execution requires the
exact configured Sidekick network key; Sidekick verifies the observed chain ID. Manual signing
remains available.

## Consequences

OIDC, multiple users, roles, and embedded signer/admin signing are deferred. Browser-wallet
invocation grants no custody or generic transaction authority. Any custody expansion requires a new
threat model and ADR.
