# Reward operations delivery status

- Status: S0–S5, S3.1, and S3.2 implemented; S6 awaits independent mainnet review.
- Branch: `codex/reward-forecast-and-overview-clarity`
- Mockups: `design/mockups/`

This file tracks delivery only. Current behavior is defined by:

- [ADR 0009](../architecture/decisions/0009-evidence-first-reward-distribution.md) — reward
  evidence, accounting, and historical coverage;
- [ADR 0010](../architecture/decisions/0010-operator-run-execution-envelope.md) — gas-wallet and
  sealed-run authority;
- [Transaction engine](../architecture/transaction-engine.md) — signing and recovery invariants;
  and
- [Operator action contracts](recurring-operation-contracts.md) — adapter effects and completion
  proofs.

## Delivered

| Slice | Result |
| --- | --- |
| S0 | Vocabulary, evidence-first model, and execution boundary recorded |
| S1 | Distribution ledger, coverage states, accounting exports, and bounded history |
| S2 | Generated gas wallet, refusal checks, balance, enable/disable, and exact sweep |
| S3 | Durable recipe runs, one-in-flight execution, pause/resume/cancel, and restart recovery |
| S3.1 | Superseded single-job signing authority removed; historical records remain read-only |
| S3.2 | Retired-engine remnants removed (planner create path, approval and attestation writes, browser-wallet job binding); Force Observe and adapter disable now gate reward runs; the read-only history path is covered by seeded-history tests |
| S4 | Calculate, collect, distribute, settle, and reclaim adapters with exact effects |
| S5 | Rewards, Overview, Activity, Settings, responsive flows, and recipe approval UI |
| S6 | Concise operator docs and exact-source review gate implemented; approval still pending |

## Release gates

Before mainnet operator-run:

1. run the extended Devnet scenario through calculate, collect, at least two payouts including the
   Bitcoin route, settle, reclaim, browser closure, and restart recovery — passed 2026-08-22 on
   `141eb8c` (artifact `1787449724061-64391`) and again on the S3.2 tree (artifact
   `1787455273537-89556`), full `pnpm e2e:devnet:test` suite;
2. complete the independent review in
   [security/operator-run-mainnet-review.md](../../security/operator-run-mainnet-review.md); and
3. keep `pnpm check`, `pnpm test:coverage`, `pnpm test:regtest`, and the dashboard browser suite
   green on the approved fingerprint.

Observe and non-mainnet evaluation remain available while the review is pending.

## Scale follow-ups

The current model is bounded and tested at 150 stakers across 50 cycles. Add cycle-windowed evidence
queries, paged payment endpoints, streamed CSV, and recent-fee gas estimates when measured production
cost justifies them; none changes the ledger or recipe model.

Unattended execution, pipelined nonces, public staker UI, signer/admin key custody, and selective
recipient runs remain out of scope.
