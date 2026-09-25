# Autopilot: scheduled reward runs

Tracking: [#6](https://github.com/stx-labs/signer-sidekick/issues/6).
Implementation branch: `codex/scheduled-reward-runs`, based on v2.2.0 (`09dcef3`).
Not deployed or enabled.

## Scope

Replace repeated reward-button clicks with an opt-in interval scheduler. The transaction engine,
adapters, signer and authorization format remain unchanged. Decisions and safety boundaries are
canonical in [ADR 0011](../architecture/decisions/0011-scheduled-reward-runs.md);
operator controls are in [Operations](../operator/operations.md#automatic-reward-runs).

## Delivery

- [x] Shared UI/server action selection; persisted, non-overlapping scheduler using existing
  preparation, exact-hash approval and status methods.
- [x] Default-off settings, interval, status and Activity provenance; existing API auth/CSRF.
- [x] Tests for restart, duplicate ticks, manual-run contention, disable during preparation,
  identity changes, stopped/expired work and unresolved attempts.
- [x] Existing-engine integration: both distributions, collect followed by bounded payout chunks.
- [x] Short ADR, operator instructions and signing-path review checklist.
- [x] Browser and contract regression verification: 257 browser tests passed (4 skipped),
  13 regtest contract tests passed; check/build and all unit suites passed.
- [x] Live Devnet with seeded network calculation: automatic collect, three payouts, and later
  Bitcoin acceptance/rejection finalization; all runs completed without browser approvals.
  Ledger registry discovery corrected; regression tests cover custom networks and missing preflight.
- [ ] Live Devnet automatic calculation and payout chunking. Calculation fixtures must account
  for the 30-minute roster refresh and grace (ten minutes and 24 canonical Stacks blocks);
  accelerated cycles alone do not validate this path.
- [x] Independent code review of the automatic-approval boundary; cancelled-run unresolved-attempt
  guard corrected and regression-tested. Required human PR approval remains outstanding.
- [ ] Explicitly approved mainnet canary, then deployment validation.

Do not expand this work into new engine retry/replacement behavior, an authorization issuer,
aggregate budgets or automatic admin actions. Any blocking engine defect is a separate finding.
