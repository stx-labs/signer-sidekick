# Epoch 4.0 regtest/devnet harness

`pnpm test:regtest` runs the self-contained Clarinet simnet suite used by normal CI and the
production-image build. It activates Epoch 4.0, overrides the PoX-5 boot contract with the pinned
Stacks 4.0.0 source, verifies Clarinet's preloaded sBTC token and registry against the pinned
sources, deploys the pinned sBTC withdrawal and rendered reference-manager contracts, and executes
the STX-only v1 contract lifecycle.

The suite covers signer grant and registration, stake and early unstake, reward calculation,
manager and staker claims, pool fees, direct and L1 payouts, accepted-withdrawal settlement and fee
dust, rejected-withdrawal reclaim, admin authorization, and revoked-grant rejection. It requires no
remote node, API, signer, or credentials.

`pnpm test:regtest:external` is a separate opt-in smoke test for an externally provisioned
stacks-node and Stacks API. Configure the URLs and expected Epoch 4.0 network state described in
`smoke.test.ts` before running it. That external run remains a Phase 1 release exit gate because it
validates the released binaries and indexing behavior that Clarinet does not model.

The mnemonics in `settings/Devnet.toml` are Clarinet's public deterministic test fixtures. Never
reuse them outside this in-memory harness.
