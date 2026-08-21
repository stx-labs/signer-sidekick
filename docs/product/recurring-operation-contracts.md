# Operator action contracts

Status: Implemented product contract. This document defines Sidekick's wallet-signed operator
actions. The executable routing table is
`apps/sidekick/src/wallet-operation-contracts.ts`; reviewed manager capability evidence remains the
gate for constructing new transactions.

## Lifecycle boundary

Sidekick starts with a deployed signer-manager. Its action surface covers signer-key
registration/rotation, manager administration, manager reward collection, staker settlement, and
fee/refund withdrawal. Manager deployment and first-time staking belong to the external setup path.

Capability review is a **new-work gate**. Sidekick checks it while preparing a transaction and again
while an unsigned prepared intent remains active. Once a transaction is submitted, Sidekick keeps
observing that exact immutable transaction and job binding even if the current manager source can no
longer be reviewed. A capability loss blocks new preparation; it does not erase canonical evidence.
Current network and chain-ID routing remain mandatory throughout observation.

## Action matrix

| Action | Reviewed capability | Authority | Anchored inputs | Transaction safety | Completion evidence and test vector |
| --- | --- | --- | --- | --- | --- |
| `register-self` | `register-self` | Current manager admin plus unused signer-key grant | Manager, PoX-5 contract, signer key, auth ID, signature, grant digest, used-grant map | Deny mode; no asset transfer | Canonical registration reports the exact signer key and a valid grant. Tests cover consumed grants, stale authorization, sender/admin checks, and exact key completion. |
| `add-admin` / `remove-admin` | `update-admin` | Current manager admin | Actor, target admin, anchored `is-admin` state | Deny mode; no asset transfer; self-removal refused | Canonical `is-admin` equals the requested state. Tests cover both directions, no-op refusal, sender mismatch, and re-observation. |
| `update-fees` | `update-fees` | Current manager admin | Actor, current fee, requested basis points | Deny mode; no asset transfer | Canonical `fees-bips` equals the target. Tests cover no-op refusal, exact call, and post-state completion. |
| `withdraw-fees` | `withdraw-fees` | Current manager admin | Actor, recipient, requested amount, earned fees, sBTC asset | Deny mode plus exact manager sBTC outflow postcondition | Canonical transaction bytes prove the exact asset outflow; reviewed adapter semantics attest the fee deduction. Tests cover amount bounds, recipient/sender binding, postcondition tampering, and custom-source conservative status. |
| `sweep-fee-refunds` | `sweep-fee-refunds` | Current manager admin | Actor, recipient, manager balance, earned fees, withdrawal liability, unclaimed staker rewards | Deny mode plus exact unreserved manager sBTC outflow | Canonical transaction bytes prove the exact asset outflow; reviewed adapter semantics attest the sweep. Sweep-specific tests cover zero sweep and reserved-balance math; shared transaction verification covers postcondition tampering and unreviewed-source refusal. |
| `claim-rewards` | `reference-reward-claims` | Permissionless fee payer | Fresh anchored reward checkpoint, every participating bucket and fee snapshot, reviewed source fingerprint, and expected PoX-5 sBTC effect (`sealed-wallet-proposal`); legacy Observe jobs remain supported when a job ID is supplied | Deny mode plus exact PoX-5-to-manager sBTC postcondition; call is reconstructed from the sealed wallet proposal or legacy engine job | Node-verified canonical inclusion of the byte-bound transaction proves direct wallet completion; API-only fallback observations remain pending. The legacy path additionally reconciles the exact engine job. Tests cover byte/proposal/job binding, all-bucket arguments, source review before signing, post-broadcast review loss, supersession, and canonical completion. |
| `claim-staker-rewards` | `reference-reward-claims` | Permissionless fee payer; payout is fixed to the named staker | Staker, cycle, optional bond index, earned bucket, payout preference, fee snapshot, unclaimed balance, sBTC asset | Deny mode plus exact manager sBTC outflow; one bucket per transaction | Canonical bucket reads back with zero earned rewards. Tests cover non-admin callers, STX-only and bond buckets, missing manager claim, L1 fee/dust refusal, exact outflow, and re-observation. |
| `calculate-rewards` | Reviewed PoX-5 network profile and protocol adapter | Permissionless fee payer | Exact PoX-5 source/profile, one chain anchor, target cycle/checkpoint, prior calculation height, global accrual, complete ordered active-bond set | Deny mode; no asset postconditions; exact one-argument PoX-5 call | Canonical PoX-5 state records the bound calculation height. Tests cover source refusal, pre-wallet revalidation, real-contract STX-only and mixed-bond vectors, exact transaction verification, canonical completion, and another caller winning the permissionless race. |

## Readiness model

Operation readiness is not setup progress. It has four independent layers:

1. **Control plane** — local node, network, PoX-5, and optional indexed-source health.
2. **Manager attachment** — configured manager exists and satisfies the universal PoX-5 trait.
3. **Signer registration** — the manager is registered with a signer key and its grant is valid.
4. **Execution engine** — the adapter needed for a particular operation is available.

The readiness API reports manager and signer checks. Per-action capability availability remains on
the manager snapshot because a manager may support one operator action and not another.
