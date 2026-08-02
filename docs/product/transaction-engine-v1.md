# Transaction engine and Assist

This document defines the controlled Assist release track. V1 launches with externally signed
Observe workflows; Assist remains blocked until its [rollout gates](#rollout-gates) are complete.

## Release boundary

The transaction engine turns one reviewed PoX-5 permissionless operation into a durable, auditable
job. It is not a wallet, a general contract caller, or a workflow platform.

The executable adapter is:

- `reference-manager-claim-rewards`, revision 1, calling only reference-manager `claim-rewards`;
- STX staking only, with positive proof that the manager has no sBTC bond participation;
- one deterministic contract call and fixed Deny-mode postconditions;
- anchored preflight, exact operator approval, one-shot submission, and authoritative
  reconciliation.

Runtime configuration accepts only these modes:

| Mode | Authority |
| --- | --- |
| Observe | Plan, block, supersede, and reconcile. Signing and broadcast are unreachable. |
| Assist | Perform the same observations, then require a fresh exact approval before the fixed adapter may sign and broadcast. |

Observe is the default and needs no engine key or attestation files. V1 has no Automate switch.

Observe may hand an existing preflighted job to the external wallet-intent boundary. This does not
enable engine signing or broadcast: the job is not replanned and never enters approval, nonce, or
attempt state. The engine completes it only through normal reconciliation of the external effect.

## Authority and key boundary

Sidekick may use one dedicated, low-balance gas-payer key for the fixed permissionless call. It must
never receive:

- the Stacks signer consensus private key;
- a manager-admin private key;
- an operator wallet mnemonic;
- a generic transaction-building or arbitrary contract-call capability.

The gas payer only signs a code-backed transaction vector and pays its bounded fee. Deployment,
signer grants, registration, fee administration, reward pause, fee withdrawal, and other privileged
operations remain external operator ceremonies.

The gas-payer signer accepts a raw private key only from an absolute, owner-restricted regular file.
Runtime configuration contains the file path and matching public principal/key, never the private
value. The secret and signed transaction bytes are excluded from SQLite, logs, metrics, API/UI
responses, support bundles, browser storage, and container layers. One key belongs to one active
Sidekick instance; unexplained account nonce activity blocks new broadcasts.

## Chain and compatibility authority

Every plan is derived from one canonical chain anchor containing the Stacks height and index block
hash, Bitcoin height, reward cycle, cycle position, phase, and reward checkpoint.

- The configured Stacks node is authoritative for actionable contract state, account state, and
  `/v2/pox` timing.
- The Stacks API supplies complete enumeration, indexed history, and enrichment. It cannot override
  node state.
- Inputs that cannot be pinned are fenced by anchor checks. Tip, cycle, checkpoint, or prepare-state
  movement discards the observation.
- SQLite is durable evidence and coordination state, never the sole authority for a transaction.
- Broadcast requires a current signed compatibility attestation whose exact network, PoX-5, sBTC,
  manager source, issuer revision, and digest match the live plan.

Attestation signatures are V1-domain-separated. Acceptance verifies the network and network ID
against the configured instance before changing durable accepted state.

Profiles and attestations are data. They cannot install an adapter, change executable call
semantics, relax postconditions, or grant generic transaction authority.

Assist requires an exact reference source/profile on every network. A production-approved manager
profile is an additional mainnet-only gate; non-mainnet Assist still requires the attestation,
approval, and admission checks in this document.

## Reference-manager reward claim

The adapter plans a job only after all of these facts agree at one anchor:

1. PoX-5 has completed an externally observed reward calculation for the exact half-cycle
   checkpoint.
2. The reproduced reference-manager source and manager principal match the accepted attestation.
3. The current manager roster is complete, every active staker was observed in the same run, and
   the manager has no bond participation.
4. Claimable sBTC rewards are positive, rewards are not paused, and the expected insert-only manager
   fee snapshot is known.
5. The dedicated gas payer has a current account nonce, sufficient balance, and an estimated fee at
   or below the configured cap.
6. The deterministic call, arguments, recipient, outflow cap, postconditions, and reconciliation
   predicate match adapter revision 1.

The logical identity distinguishes both reward calculations in one reward cycle. For cycle `C`,
the first calculation is observed in the second half of `C` at `cycle-start + half-length - 1`;
the second is observed in the first half of `C + 1` at the final burn block of `C`. Both claims
target `C`, but each carries its own calculation-checkpoint identity and approval review.

Positive `get-earned` remains actionable even when the insert-only fee snapshot already exists; the
plan uses the snapshotted fee rather than a later configured fee. Reconciliation marks the durable
same-scope job complete only when earned rewards are zero and the matching fee snapshot is present.
It reuses that job's stored no-bond predicate instead of requiring a new roster crawl. Paused rewards
remain a circuit breaker, not a retry condition.

## Durable lifecycle

```text
prepared -> preflighted -> awaiting_approval -> nonce_reserved
         -> broadcast -> confirmed -> reconciled

side states: blocked, superseded, ambiguous, noncanonical_reobserve
```

The database records immutable intent and policy hashes, adapter revision, exact anchor and
attestation digest, approval history, nonce reservations, every transaction attempt, precomputed
txids, submission evidence, and reconciliation observations.

Important invariants:

- Duplicate observations create at most one active logical job.
- Changed authoritative facts supersede work before signed commitment and invalidate its approval.
- Observe cannot reserve a nonce, sign, or broadcast.
- The job transition, nonce reservation, signed attempt, and txid commit atomically before the
  one-shot network request.
- Submission acceptance is not confirmation; confirmation is not business success.
- A noncanonical confirmation returns to observation before finality.
- Another permissionless caller completing the same effect is reconciled as external success; it
  does not create a retrospective job or a duplicate local effect.

## Admission and approval

Planning creates a sealed job only after the adapter's authoritative checks pass. Immediately before
broadcast, Assist revalidates compatibility, manager source, chain anchor, checkpoint, prerequisites,
fee state, approval, gas identity, nonce ownership, and deterministic blockers. The isolated signer
then rebuilds the fixed call and postconditions and requires an exact match before signing. An
aggregate health color, peer count, latency, or indexer lag never grants authority.

The Operations page displays the exact network, manager, adapter revision, contract/function,
arguments, checkpoint, anchor, recipient, asset-outflow cap, fee snapshot, maximum fee,
attestation digest, and expected post-state. Approval binds the displayed intent and policy hashes
to a bounded expiry. Refreshing the page, restarting the process, changing chain facts, expiring the
window, forcing Observe, or disabling the adapter cannot recreate or extend an approval.

Approval submission is idempotent for the same exact document. It does not authorize another job,
adapter revision, fee policy, checkpoint, or replanned transaction.

## Nonce, submission, and recovery

V1 allows one unresolved nonce per gas payer. Before reservation, the engine reconciles the public
principal, anchored node account nonce, local attempts, and observed transaction state. It commits
the nonce and signed-attempt reference before one broadcast request; the network client does not
hide retries.

Mempool admission and recovery use two consecutive bounded global enumerations and normalize both
origin and sponsor nonces. Pagination drift, changed rows, exceeded bounds, or an unavailable API
blocks Assist rather than asserting absence. This check detects existing foreign use; the dedicated
one-instance gas-key rule remains the primary ownership invariant because a transaction can arrive
after any completed observation.

A timeout, reset, server failure, nonce conflict, malformed rejection, or response that may follow
acceptance becomes `ambiguous`. Only a parseable HTTP 400 with the expected txid and a non-nonce
reason in the fixed code-owned allowlist is deterministic. For ambiguity, the engine searches the
precomputed txid, unconfirmed and indexed transaction state, authoritative account nonce, and
expected contract post-state before taking further action. It never allocates a new nonce for an
ambiguous attempt. V1 does not construct, sign, or broadcast replacement transactions. An attempt
that cannot be reconciled remains unresolved and requires manual intervention.

During submission uncertainty, signing and broadcast must stop while observation and reconciliation
continue. Do not retry manually, replace the database or key, or restore a pre-broadcast backup while
a nonce is unresolved.

## Emergency controls

The authenticated Operations surface and `/api/v1/engine` API expose engine status, jobs, exact
approvals, attempts, txids, and reconciliation evidence.

- **Force Observe** is a persistent, one-way emergency control for that database. It invalidates
  active approvals and prevents new signing, broadcasts, and Sidekick-initiated wallet claims.
- **Disable adapter** is a persistent, one-way circuit breaker for the selected adapter. It
  invalidates that adapter's approvals and prevents new jobs and broadcasts.
- **Invalidate approval** withdraws only that exact approval and cannot restore it.

These controls do not erase an in-flight attempt. Observation and reconciliation continue because
abandoning a submitted nonce would make recovery less safe.

Wallet-intent expiry and Force Observe cannot revoke a request already disclosed to an external
signer or cancel its broadcast. Sidekick therefore records matching late txids and reconciles their
effects without granting new signing authority.

## Rollout gates

Complete these gates in order. Mainnet Assist is permitted only after all seven. Public-network
broadcasts before then are limited to the explicitly reviewed canaries in gates 4 and 7.

1. Record owners and accepted answers for the broadcast-critical items in
   [Open technical questions](open-technical-questions.md), including trust-root governance,
   manager no-bond proof, and finality.
2. Complete independent security review of attestation verification, gas-key isolation, transaction
   vectors, nonce recovery, approval binding, and artifact redaction.
3. Run repeated clean released-Devnet passes from genesis against the exact candidate image,
   including restart, outage, ambiguity, external race, and reorg cases.
4. Complete public-testnet Observe over a full runtime-derived reward cycle and one explicitly
   reviewed Assist manager-claim canary.
5. Exercise backup and recovery with an in-flight transaction and preserve evidence across restart.
6. Produce and verify the SBOM, provenance, checksums, and signed release image.
7. Run mainnet Observe through the required soak, then approve one explicit mainnet Assist canary.

## Future scope

Each additional operation requires a scoped
[issue](https://github.com/stx-labs/signer-sidekick/issues) and separate code-backed adapter with
authoritative enumeration, a fixed vector, reconciliation predicate, security review, and rollout
plan. Protocol decisions belong in [Open technical questions](open-technical-questions.md).
