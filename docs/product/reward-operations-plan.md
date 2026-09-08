# Reward operations delivery status

- Status: S0–S6 implemented.
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
| S6 | Concise operator docs and the signing-path review checklist; review happens in the repository's required PR review |
| S5.1 | Rewards page v2: Earning card for the accruing cycle, one Distribute card per open distribution (paged payments, ₿ marker with the registered L1 address), a past-cycles ledger with distribution tabs, rolled-forward reasons joined from run history, and exports next to the data; one fee-ledger card exports the whole history |

## Release gates

Before mainnet operator-run:

The dated Devnet results below record original workflow acceptance, not a test of every later
release. Re-run affected scenarios for changes to execution or recovery.

1. run the extended Devnet scenario through calculate, collect, at least two payouts including the
   Bitcoin route, settle, reclaim, browser closure, and restart recovery — passed 2026-08-22 on
   `141eb8c` (artifact `1787449724061-64391`) and again on the S3.2 tree (artifact
   `1787455273537-89556`), full `pnpm e2e:devnet:test` suite;
2. review signing-path changes against
   [security/operator-run-mainnet-review.md](../../security/operator-run-mainnet-review.md) in the
   pull request that ships them (the repository requires a second approver for every merge); and
3. keep `pnpm check`, `pnpm test:coverage`, `pnpm test:regtest`, and the dashboard browser suite
   green on the released commit.

## Scale follow-ups

Ledger fixtures cover 150 stakers across 50 cycles. Activity uses storage-level pagination and
reward runs use the node's fee estimate within a configured band. Measure remaining cycle-window,
payment-query and CSV costs before adding another projection or changing the ledger/recipe model.

Unattended execution, pipelined nonces, public staker UI, signer/admin key custody, and selective
recipient runs remain out of scope.
