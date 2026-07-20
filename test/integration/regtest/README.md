# PoX-5 contract harness

`pnpm test:regtest` runs the deterministic Clarinet lifecycle used by CI and the production-image
build. It uses pinned PoX-5, sBTC, and generated reference-manager sources and requires no external
node, API, signer, or credentials.

The lifecycle covers registration, STX position changes, reward calculation and claims, direct and
L1 payouts, withdrawal settlement/reclaim, permissionless races, prepare-phase rejection, and grant
revocation. The tests and fixture metadata are the authoritative scenario definition.

`pnpm test:regtest:external` is a separate read-only smoke test for a supplied node and API. Its
environment contract is defined in `smoke.test.ts`. Set `SIDEKICK_NETWORK_ID` only for a private
network; adding `SIDEKICK_MANAGER_PRINCIPAL` enables manager, registration, and grant checks.

Clarinet mnemonics under `settings/` are public deterministic fixtures and must never be reused.
