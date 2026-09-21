# Operator-run signing-path review

Changes to the operator-run signing path land through the repository's required pull-request
review (a second person must approve every merge to `main`). There is no runtime application-release
attestation gate. Reviewed contract/source identities and sealed-plan checks still apply. The
contract fixes payout recipients and amounts, and the gas wallet holds no admin or signer authority;
review must keep its authority narrow.

## Review scope

When a pull request touches any of the following, review it against this list before approving:

- gas-wallet generation, storage, activation, refusal checks (never the signer key, never a manager
  admin), and sweep;
- recipe bounds (never add a recipient, never increase an amount), approval expiry,
  transaction/gas caps, and one-active-run exclusion;
- every adapter's anchored inputs, exact signer method, deny-mode postconditions, and completion
  proof — there must be no generic signing or contract-call path;
- one-in-flight nonce handling, external completion, ambiguous broadcast, restart, and resume;
- CSRF/auth boundaries and exclusion of keys or signed bytes from APIs, logs, Activity, and support
  exports; and
- scheduled approval: explicit opt-in bound to deployment identity, no adoption of manual
  preparations, exact recipe hash, restart/disable races, durable stop on halted/expired work,
  unresolved-attempt protection, and truthful Activity attribution;
- regtest/Devnet coverage for calculate, collect, distribute, settle, reclaim, pause, and recovery.

Paths that usually carry these changes: `apps/sidekick/src/transaction-engine/**`,
`apps/sidekick/src/gas-wallet*`, `apps/sidekick/src/reward-schedule*`,
`packages/protocol/src/reward-operation-plan.ts`, and the
adapter sources under `packages/protocol/src/`.
