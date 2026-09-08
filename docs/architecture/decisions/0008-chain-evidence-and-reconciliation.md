# ADR 0008: Node-authoritative event reconciliation

- Status: Accepted; transaction-execution policy amended 2026-09-07–08
- Date: 2026-08-16

## Decision

The configured Stacks node is authoritative for current chain state. Indexed APIs supply discovery
and history; the configured API may also prove submitted execution under the binding rules below.
This is operational trust in that API, not cryptographic execution proof. No API may override a
positive node-proved conflict. Optional-source failure degrades its domain, not unrelated work.

### Callbacks and history

The private listener commits bounded callbacks to a durable inbox before acknowledgement. A worker
checks the claimed Nakamoto block against a stable local-node anchor and accepts only byte-identical
canonical evidence. Malformed, conflicting or forged claims are quarantined. Burn-block callbacks
remain trigger-only where the node cannot supply an equivalent proof.

Verified callbacks trigger focused refreshes; embedded events are not domain history. Indexed
manager and calculation events require node-proved transaction inclusion at the exact canonical
height and index-block hash, using the optional transaction index or canonical block bytes.
Idempotent replay, source-scoped cursors and periodic anti-entropy repair gaps and reorgs.
Current projections refresh without an open browser.

### Exact binding before execution

| Submission | Binding required for configured-API execution during node unavailability |
| --- | --- |
| Locally signed run child | Revalidated sealed plan and persisted signing-time txid, matching the run/recipe authorization, child, sender, network, nonce and fee |
| Gas-wallet sweep | Saved approval and broadcast identity, sealed plan, signing-time txid, sender, network, nonce, fee, recipient and amount |
| Browser wallet | Persisted exact node-mempool verification for this same immutable intent, manifest and txid |

The dedicated signer rebuilds the sealed plan, constructs and signs the transaction, and computes
its txid. Runs and sweeps persist that identity before broadcast; raw signed bytes are not stored.
Observation revalidates the saved binding. API payload summaries cannot create it.

Browser wallets return only a txid. Node index or block bytes pass the full verifier: sender,
network, authorization, signature, exact call/arguments, deny mode and every postcondition.
When the index cannot answer, the block walk must consume the whole canonical block; malformed
bytes cannot yield partial proof.

A wallet's retained mempool observation links that exact verification to its sealed manifest.
Reading it validates the stored sender, network/version, authorization shape, call, argument digest
and postcondition count; the original byte verifier proved the signature and each postcondition.
Old API-summary or canonical-only records do not qualify. Missing or mismatched binding waits for
node bytes. Later missing observations and restart do not erase the original proof.

### Canonical execution and conflicts

The receipt must match the network and txid and contain a terminal status, canonical transaction
and coherent canonical block. Pending/dropped statuses, absence, source lag, timeouts and malformed
records never become success or abort. Abort receives the same identity/canonical checks as success.
This receipt policy requires canonical inclusion, not an additional confirmation-depth wait.
`SIDEKICK_ENGINE_FINALITY_DEPTH` belongs to legacy engine jobs, not reward runs or sweeps.

Positive node disagreement—an orphaned receipt or absence from the claimed canonical block—is a
conflict. Runs halt; wallets reobserve without replacement from that conflict; sweeps retain their
authorization. Transport failure and a node behind the claimed height are unavailable, not conflicts.
Persisted conflicts survive missing/pending observations, restart and resume; API-only evidence
cannot clear them. Positive node-backed verification is required to resolve them.

Canonical execution is not always action completion. Exact successful registration, admin/fee
updates and staker claims remain historical facts after later settings changes or new accrual.
Calculation checkpoints, historical engine-job bindings and asset-semantic checks still apply.
Known execution with an unavailable extra check remains pending completion. An API abort is not
lost if an optional external-completion read fails.

A BTC-route claim proves creation of the Stacks withdrawal request, not Bitcoin delivery.
Arrival and retirement require separate evidence under [ADR 0009](0009-evidence-first-reward-distribution.md).

### Observation does not grant signing authority

Once operational startup has succeeded, the read-only observation accessor accepts cached node
unavailability but rejects unchecked connections and positive identity/network refusals.
Authenticated, same-origin manual refresh may observe an already-submitted ID during an outage.
Preparation, submission recording, replacement, role checks, broadcast and the next child's fresh
materialization keep their connected-node gates. Cold boot still needs an accepted connection
before operational workers start; the control-plane health collector is independent.

Existing maintenance observes submitted wallets and broadcast sweeps independently of browser
presence or gas-key enablement. Reads coalesce; shutdown drains them. Observation never signs,
replaces or automatically resumes a halted run. See [Operations](../../operator/operations.md#transaction-observation)
for cadence and recovery. A missing ambiguous sweep keeps its authorization; it cannot expire into
permission to submit another.

### Persistence and limits

Execution provenance is `node`, `api-with-node` or `api`; legacy unknown provenance remains null.
Migration 40 adds run/sweep source columns and carries legacy halted-run diagnostics onto broadcast
children. Those unclassified diagnostics conservatively veto API-only completion until node proof.
Wallet provenance uses existing extensible observation metadata and preserves the older strict
verification object; no raw-byte store or third approval artifact is added.

Terminal history is not periodically revalidated. Explicit refresh retains terminal execution
during unavailability but can revise it on positive contradiction. The accepted-withdrawal cache's
known-reorg display limitation remains deferred. No terminal poller, nonce-proof sweep abandonment
or cold-boot observation bypass is implied.

## Consequences

Browser closure and transient node outages do not erase submitted work. Completion has one exact
binding policy with explicit provenance; current-state signing, callbacks and history keep their
node-proof boundaries. Preserve the database and compatible backup across upgrades and rollback.
