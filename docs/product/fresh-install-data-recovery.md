# Fresh-install data recovery

- Status: Implemented
- Date: 2026-08-15
- Parent: [Scope and decisions](scope-and-decisions.md)

## Product promise

A fresh Sidekick database attached to an existing signer manager reconstructs the operator's
current pool state before it claims historical completeness. It then imports the history needed to
explain that current pool without scanning all PoX-5 activity for every signer.

Signer-health history begins when this Sidekick installation starts observing the signer. Sidekick
does not imply that earlier runtime telemetry was reconstructed from chain data.

## Authority and coverage

Current state and historical coverage are independent:

1. **Local-node authority** is `current`, `catching-up`, or `unknown`. Cycle-sensitive state is
   actionable only while authority is `current`. A definitive behind signal demotes authority
   immediately. Recovery requires repeated synchronized observations at or above the highest
   previously proved current tip so one flapping peer observation cannot reopen actions.
2. **Roster coverage** becomes current only after the indexed roster is completely enumerated at a
   stable API anchor and every candidate is read from the local node at that same anchor. A fenced,
   canonical zero-result enumeration is an authoritative empty roster even on the first run.
3. **History coverage** is reported separately for manager, current-member pool, and reward
   history. Imported records may be shown while coverage is reconstructing, but the UI must not
   imply that the visible list is complete.

A conclusion is current only when local-node authority is current and that conclusion's domain
coverage is current. Money-moving paths fail closed on the same invariant. Deadline-bearing facts
may remain visible while authority is unavailable, but stale state-derived conclusions and repair
instructions do not.

## Recovery sequence

### Phase 1: establish current truth

1. Bind the existing deployment identity after the existing network, PoX-5, and universal manager
   trait checks pass.
2. Observe local-node synchronization authority.
3. Capture one stable shared node/API anchor.
4. Enumerate the current signer roster from the indexed API.
5. Verify every STX position, cycle membership, and active bond membership from the local node at
   the captured anchor.
6. Persist the authoritative current roster, including a canonical empty roster.

No history import is required to answer who is currently in the pool.

### Phase 2: recover relevant history

- **Manager history:** backfill the configured manager contract's prints to its deployment height.
  This is manager-specific rather than a global PoX-5 scan.
- **Current-member pool history:** for each principal in the authoritative current roster, page the
  indexed API's principal-transaction stream, fetch transaction events, retain only decoded PoX-5
  prints that involve both the current member and configured manager, and independently verify the
  transaction against the local node. Persist the transaction's Stacks block time as occurrence
  time; the backfill run time is observation metadata, not the activity date.
- **Reward history:** recover calculate-rewards facts for the cycles relevant to the current roster
  and manager. Persist the emitted realization even when a pruned node cannot replay historical
  contract state; label forecast-versus-actual evaluation unavailable for that anchor.

The official indexed endpoints used for member-scoped discovery are:

- `GET /extended/v3/principals/{principal}/transactions`
- `GET /extended/v3/transactions/{tx_id}/events`

See the Hiro API references for
[principal transactions](https://docs.hiro.so/en/apis/stacks-blockchain-api/reference/transactions/get-principal-transactions)
and [transaction events](https://docs.hiro.so/en/apis/stacks-blockchain-api/reference/transactions/get-transaction-events).

Departed members are not recovered by default. Their past activity did not contribute to the
freshly reconstructed current state, and omitting it avoids an unbounded global-contract scan. A
future explicit archival export may broaden that scope without changing the first-run promise.

## Scheduling and backpressure

- Live observer verification and current-state reconciliation always outrank historical work.
- Backfill is bounded, resumable, idempotent, and restart-safe.
- Each pass has page, transaction, and wall-clock budgets and honors source-provided retry delays.
- Work is fair across current members; one long-lived principal cannot starve the rest.
- A periodic anti-entropy pass resumes incomplete history without requiring an open browser.
- Historical records near the live tip remain provisional and are revalidated. Deep records are
  still node-witnessed when imported, but do not consume continuous reorg polling forever.

## Evidence levels

Every imported event carries one required evidence level:

- `node-index-verified`: the node transaction index proved canonical inclusion at the exact height
  and index-block hash.
- `canonical-block-correlated`: the API transaction was absent from the local transaction index,
  but the local node proved the API's exact canonical block. This is useful historical evidence but
  must not be described as transaction-index verified.
- `indexer-reported`: discovery evidence only; it cannot authorize current state or an operation.

Evidence may be upgraded when stronger local proof later becomes available. It is never silently
downgraded.

## Acceptance tests

- A synced fresh node plus an existing non-empty pool reconstructs the current roster before
  historical import completes.
- A stable, anchored zero-result roster is authoritative on first install.
- A catching-up or unknown node never produces a state-derived action or money-moving plan.
- Authority flapping does not repeatedly reopen and close current-state conclusions.
- Current-member history resumes after restart without duplicate events and stays inside its API
  budget.
- Unrelated PoX-5 activity does not trigger or enter this pool's history.
- A reorg during backfill invalidates or replaces affected provisional records.
- Support output distinguishes monitoring start time, current-state authority, and each history
  domain's coverage.
