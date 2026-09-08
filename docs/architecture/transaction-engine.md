# Transaction engine safety contract

Sidekick starts in **Observe** mode. Browser-wallet actions use sealed, expiring intents; Sidekick
never accepts wallet credentials or signed bytes from the browser. It fetches transaction bytes
independently when needed for verification. **Operator-run** is an explicit
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

Recipe preparation is a durable background job. The API returns its ID immediately; the dashboard
polls it, duplicate requests reuse it, and startup requeues an interrupted preparation. The
30-minute approval window begins only after one stable node anchor has been read and the recipe is
sealed:

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

- For reward runs and gas sweeps, the sealed plan and precomputed transaction ID are persisted
  before the single broadcast attempt. Raw signed bytes are not stored.
- Submission is not confirmation. Completion requires exact canonical successful execution and
  any adapter-specific checkpoint proof, not a repeated read of later mutable settings/balances.
- A reset or timeout during submission, conflicting nonce, reorg, or uncertain submission outcome
  halts without replacement. Typed upstream/read failures and retryable anchor capture instead wait
  on the existing maintenance tick, bounded by the original runtime cap. Unclassified exceptions
  still halt; transport recovery is not a catch-all retry policy.
- Materialization re-proves the preparation anchor before each child. Reconciliation checks the
  submitted transaction, without re-reading the preparation block on every poll. Locally signed
  run children and sweeps can use coherent configured-API execution evidence during a node outage,
  only with the retained signing-time txid/plan binding and no unresolved conflicting diagnostic.
  `executionSource` records node, API with node corroboration, or API evidence; legacy source is null.
  Observation allows cached transport unavailability, while all fresh signing access stays gated.
  Browser wallets may use the same execution source only with persisted exact mempool verification
  for the same sealed intent/txid. Additional checkpoint, legacy-job and asset-semantic checks
  remain. See ADR 0008 for the operational API trust boundary and retained-conflict rules.
- Slow reads do not overlap recovery ticks. Shutdown drains in-flight work, and the signature
  boundary rechecks run state, expiry and emergency controls after role reads finish.
- Broadcast-child reconciliation uses the bounded
  [submitted-observation cadence](../operator/operations.md#transaction-observation).
  Source Retry-After cannot silence future checks or extend the run deadline. Pacing is
  recorded after an actual read (including a throw), keyed by transaction ID, and pruned against
  retained running broadcast children. Explicit Resume resets only that child's cooldown;
  restart resets all in-memory pacing.
  The coordinator tick still checks expiry, and the next child still requires fresh
  materialization, role checks and authorization. No new timer, durable scheduling or evidence state.
- Resume first reconciles the existing attempt. It never blindly signs the next nonce.
- A predictable contract abort plus the already-proved target state is external completion.
- Restart resumes from the durable cursor and never re-signs an existing attempt.
- Cancel releases work that has not been signed; it cannot undo a broadcast transaction.
- The existing maintenance tick observes submitted wallets and broadcast sweeps without a browser
  or enabled gas signer. It grants no signing, replacement or automatic halted-run-resume authority.
  Submitted-work scans are paced independently of run recovery. Missing/unavailable results or
  read errors back off without retiring the transaction. Observed results
  reset to the normal cadence, except unchanged canonical-success wallet observations whose extra action
  check remains pending: the existing observation-row deduplication identifies these for backoff.
  This in-memory pacing is not evidence, resets on restart, and is pruned
  against the durable active set.
  Manual refresh bypasses the due-time check and still coalesces with an in-flight read.
  Positive sweep conflicts retain the wallet authorization; ambiguous missing transactions never
  expire into permission to submit another sweep.

The executable contract is the typed schemas and tests under `apps/sidekick/src/transaction-engine`,
`packages/protocol`, and `packages/api-contracts`. Operator recovery is in
[Operations](../operator/operations.md); operation-specific effects are in
[Operator action contracts](../product/recurring-operation-contracts.md).
