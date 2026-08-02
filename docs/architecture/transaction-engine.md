# Transaction engine safety contract

Sidekick launches in Observe mode. Assist is a future, approval-gated capability for one reviewed
PoX-5 operation; it is not a wallet, generic contract caller, or workflow engine.

## Authority

- **Observe** may plan, display, hand off an exact request to an external wallet, and reconcile its
  effect. It cannot reserve a nonce, sign, or broadcast.
- **Assist** may sign and broadcast only the code-backed
  `reference-manager-claim-rewards` adapter after fresh, exact operator approval.
- Signer and manager-admin keys never enter Sidekick. Assist may hold one dedicated, low-balance
  gas-payer key for that fixed adapter only. See [ADR 0003](decisions/0003-local-auth-and-keys.md).

## Chain authority and admission

Every plan binds one canonical anchor: Stacks height and index block hash, Bitcoin height, reward
cycle and position, phase, and reward-calculation checkpoint. The configured node is authoritative
for actionable contract, account, and PoX state. The Stacks API provides indexed enumeration and
history; it cannot override node state. SQLite is durable evidence and coordination state, not
transaction authority.

An Assist plan and its pre-broadcast recheck must agree on:

1. the completed reward calculation and its exact checkpoint;
2. the accepted reference-manager source/profile and compatibility attestation;
3. a complete current manager roster with no bond participation;
4. claimable, unpaused rewards and the expected manager fee snapshot;
5. the gas payer's current nonce, sufficient balance, and bounded fee; and
6. the fixed call, arguments, deny-mode postconditions, recipient, outflow cap, and expected
   post-state for the adapter revision.

Changing authoritative facts supersedes uncommitted work. An approval binds the exact plan and
policy hashes to a bounded expiry; it cannot authorize a replan, another checkpoint, or another
adapter.

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

PoX-5 can calculate rewards twice for one reward cycle. Each claim therefore includes its
calculation-checkpoint identity, not only the reward-cycle number.

## Review and release

The executable behavior is defined by the adapter, transaction-engine code, typed schemas, and
tests under `apps/sidekick/src/transaction-engine` and `packages/protocol`. Before any Assist
canary or mainnet use, complete the [Assist release gates](https://github.com/stx-labs/signer-sidekick/issues/6).
Additional operations require a separately reviewed code-backed adapter and release plan.
