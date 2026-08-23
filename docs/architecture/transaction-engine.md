# Transaction engine safety contract

Sidekick starts in **Observe** mode. Browser-wallet actions use sealed, expiring intents; Sidekick
never receives wallet credentials or signed transaction bytes. **Operator-run** is an explicit
deployment mode for the permissionless PoX-5 reward calls. It uses only the dedicated gas wallet
and the recipe-run API defined by [ADR 0010](decisions/0010-operator-run-execution-envelope.md).

## Authority

- Signer and manager-admin keys never enter Sidekick.
- The generated gas-wallet key is owner-readable only, is absent from SQLite and support output,
  and pays network fees only. Its one self-transfer capability is an operator-approved sweep.
- Every executable operation has a code-backed adapter and one explicit signer method. There is no
  generic signing or contract-call API.
- Manager source, PoX-5 source, network, chain ID, and contract principals must match reviewed
  capability evidence. A data profile cannot add executable behavior.

## Sealed runs

Preparing a run reads one stable node anchor and seals:

- manager, network, cycle, distribution, adapter revisions, and source fingerprints;
- ordered operations and at most 200 children;
- the exact `(staker, cycle, bond bucket)` account set and maximum gross amount per account;
- reviewed payment count and total, per-transaction fee cap, and total gas budget; and
- fixed recipient, asset, and expected-effect semantics.

Approval binds the recipe hash. A payment child is rebuilt only after any preceding collect is
confirmed and the fee snapshot is proved. It may disappear, shrink, or be skipped when another
caller completed the work; it may never add a recipient or exceed the approved amount.

Immediately before every signature Sidekick rechecks the stable chain anchor, source identities,
gas-wallet nonce and balance, fee and budget, account state, recipe bounds, and that the gas wallet
is neither a contract, manager admin, nor signer. The signer reconstructs the transaction from the
sealed material and enforces deny-mode postconditions, including the exact manager-to-staker refund
for `reclaim-failed-withdrawal`.

## Execution and recovery

One run or sweep owns the gas wallet at a time, with one transaction in flight. Runs are durable:
`awaiting-approval → approved → running → paused → completed | halted | cancelled | expired`.
Approval must be used within 30 minutes; a started run expires after 6 hours.

- Signed bytes and txid are committed before the single broadcast attempt.
- Submission is not confirmation; confirmation is not completion until the expected state is
  proved.
- A reset, timeout, conflicting nonce, reorg, or uncertain response halts without replacement.
- Resume first reconciles the existing attempt. It never blindly signs the next nonce.
- A predictable contract abort plus the already-proved target state is external completion.
- Restart resumes from the durable cursor and never re-signs an existing attempt.
- Cancel releases work that has not been signed; it cannot undo a broadcast transaction.

The executable contract is the typed schemas and tests under `apps/sidekick/src/transaction-engine`,
`packages/protocol`, and `packages/api-contracts`. Operator recovery is in
[Operations](../operator/operations.md); operation-specific effects are in
[Operator action contracts](../product/recurring-operation-contracts.md).
