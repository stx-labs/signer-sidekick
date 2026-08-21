# Transaction engine safety contract

Sidekick launches in Observe mode. Assist is a future, release-gated execution envelope for
code-backed adapters; it is not a wallet, generic contract caller, or workflow engine. The current
implementation and release scope remains one reviewed PoX-5 manager-claim operation. Any expansion
follows [ADR 0009](decisions/0009-evidence-first-reward-distribution.md) and the existing Assist
release gates.

## Authority

- **Observe** may plan, display, hand off an exact request to an external wallet, and reconcile its
  effect. It cannot reserve a nonce, sign, or broadcast.
- **Assist**, in the current implementation, may sign and broadcast only the code-backed
  `reference-manager-claim-rewards` adapter after fresh, exact operator approval. No future adapter
  is authorized merely by being described in an ADR or issue.
- Signer and manager-admin keys never enter Sidekick. Assist may hold one dedicated, low-balance
  gas-payer key for that fixed adapter only. See
  [ADR 0003](decisions/0003-operator-auth-and-custody.md).

## Chain authority and admission

Every plan binds one canonical anchor: Stacks height and index block hash, Bitcoin height, reward
cycle and position, phase, and reward-calculation checkpoint. The configured node is authoritative
for actionable contract, account, and PoX state. The Stacks API provides indexed enumeration and
history; it cannot override node state. SQLite is durable evidence and coordination state, not
transaction authority.

Sidekick therefore keeps two chain positions separate. Current setup, manager, reward, and wallet
facts use a stable local-node anchor. Indexed roster, event, history, and canonical-ancestry reads
use the newest stable API anchor that the node can still read. An API that is behind or unavailable
degrades only those indexed capabilities. A local node that is behind the API or its observed peers
fails readiness, while Assist remains fail-closed whenever an API-specific completeness proof is
unavailable.

An Assist plan and its pre-broadcast recheck must agree on:

1. the completed reward calculation and its exact checkpoint;
2. the accepted reference-manager source/profile and, for the Assist envelope, compatibility
   attestation;
3. the complete applicable manager reward-bucket set and each bucket's fee snapshot;
4. claimable, unpaused rewards;
5. the gas payer's current nonce, sufficient balance, and bounded fee; and
6. the fixed call, arguments, deny-mode postconditions, recipient, outflow cap, and expected
   post-state for the adapter revision.

Changing authoritative facts supersedes uncommitted work. A bucket that changes between approval
and broadcast invalidates the plan. An approval binds the exact plan and policy hashes to a bounded
expiry; it cannot authorize a replan, another checkpoint, or another adapter.

## Durable execution

Jobs progress through planning, preflight, approval, nonce reservation, broadcast, confirmation,
and reconciliation. The following invariants are intentional:

- Duplicate observations create at most one active logical job.
- Observe never reaches approval, nonce, signing, or broadcast state.
- The job transition, nonce reservation, signed attempt, and txid are committed before the single
  broadcast request.
- Submission acceptance is not confirmation, and confirmation is not business success.
- A timeout, reset, conflict, or other uncertain submission is ambiguous: no new nonce or
  replacement transaction is created until the attempt is reconciled.
- A noncanonical confirmation returns to observation before finality.
- A matching external completion reconciles as success without creating a duplicate local effect.

PoX-5 can calculate rewards twice for one reward cycle, while manager and staker claims settle
cycle/bucket accumulations rather than independently claimable checkpoints. Manager-claim proposals
bind their calculation-checkpoint evidence even though the contract call uses the reward cycle.
Staker settlement is tracked at `(staker, cycle, bond-index)` with checkpoint attribution as an
accounting overlay. The evidence model is defined in
[ADR 0009](decisions/0009-evidence-first-reward-distribution.md).

## Review and release

The executable behavior is defined by the adapter, transaction-engine code, typed schemas, and
tests under `apps/sidekick/src/transaction-engine` and `packages/protocol`. Before any Assist
canary or mainnet use, complete the
[Assist release gates](https://github.com/stx-labs/signer-sidekick/issues/6). Additional operations
require the single-tenant engine refactor in ADR 0009, a separately reviewed code-backed adapter,
an adapter-specific signer capability, standing-policy or exact-approval review, and a release plan.
