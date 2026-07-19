# Signer Sidekick V1 scope

This is the stable product and safety contract. It omits code-level schemas and delivery status; use
[the documentation index](../README.md) for implementation pointers.

## Product decision

PoX-5 makes the signer-manager the pool primitive: stakers select it directly, positions may span
many cycles, and rewards have multiple calculation, claim, payout, and withdrawal stages. Sidekick
therefore provides a new reconciliation-focused operator control plane rather than porting the
PoX-4 delegation loop from `degen-lab/stacker-flow-automation`.

## Scope

| Decision | V1 |
| --- | --- |
| Pool | STX-only |
| Deployment | One network and signer-manager per instance |
| Manager automation | Independently reproduced pinned reference source only |
| Existing setup | Attach without redeployment |
| New setup | Prepare, execute, and verify manager deployment and registration |
| Runtime authority | Dedicated low-balance gas payer for the fixed manager-claim adapter |
| Manager admin | External wallet or manual signer; Sidekick prepares fixed allowlisted calls |
| Signer private key | Remains on the signer host |
| Packaging | One OCI container, embedded UI, SQLite |
| License | GPL-3.0-only |

The product should answer:

1. Is the manager deployed, granted, registered, and eligible?
2. Which STX positions belong to it now and in upcoming cycles?
3. Which reward and withdrawal operations remain incomplete?
4. What action, if any, should the operator take?

### Explicitly out of scope

- Installing or controlling `stacks-node` or `stacks-signer`.
- Host/process resource monitoring, log collection, durable health history, and notifications. V1
  does include the direct node and signer signals described in
  [Signer Health](signer-health.md).
- End-user wallet connection, pool selection, or stake submission.
- PoX-4 migration tracking.
- sBTC bond pooling and bond-member operations.
- Multiple managers in one process.
- Automation for arbitrary custom manager contracts.
- Multi-user RBAC, tax reporting, or fiat accounting.

## Operator journeys

### Attach

The operator supplies the deployed manager and endpoints. Sidekick verifies the network, manager
source/interface, registration, signer grant, eligibility, and indexed history. Attach never
redeploys or changes the manager and always begins in Observe mode.

Compatible managers may use fixed externally signed actions when the configured target, required
interface, and node/API network routing agree. Source and profile trust are warnings on that path.
Assist requires an independently reproduced reference source and never follows from ABI similarity.

### Fresh setup

Sidekick validates the connected network, renders a reviewable manager artifact, verifies public
signer-grant output, prepares `register-self` arguments, and confirms the resulting on-chain state.
A supported browser wallet or manual tool owns fee, nonce, signing, and broadcast.

Node and signer setup remain upstream responsibilities. See the
[operator deployment guide](../operator/deployment.md).

### Normal operation

The dashboard summarizes registration, cycle timing, current and projected pool membership,
reward checkpoints, payout progress, withdrawals, and required actions. Large collections are
paginated and exportable.

Sidekick also generates static or live pool-information artifacts for the operator to host. It
does not expose a public pool route or collect staker inputs.

## Functional requirements

### Registration and pool state

- Verify manager source, signer registration, live grant, and revocation.
- Show current and next-cycle signer-set membership and threshold margin.
- Enumerate STX positions, changes, expiration, and deferred unlock state.
- Distinguish contract-authoritative state from indexed history and local projections.
- Detect unsupported bond positions without treating them as STX pool principal.

### Rewards and withdrawals

- Track both reward-calculation checkpoints and manager claims.
- Preserve the fee snapshot effective for each reward cycle.
- Track per-staker direct-sBTC and Bitcoin L1 payout state.
- Reconcile accepted-withdrawal settlement and rejected-withdrawal reclaim.
- Account for held funds separately from outstanding withdrawal liabilities.
- Treat permissionless races as reconciliation outcomes, not necessarily failures.

Sidekick may prepare fixed admin-membership, fee, fee-withdrawal, and fee-refund-sweep calls for any
technically compatible configured manager. A browser wallet or manual tool reviews, signs, and
broadcasts; Sidekick never signs an admin transaction. For custom sources, Sidekick verifies the
exact call and observable postconditions without attesting custom contract semantics.

### Application operations

- Resumable ingestion and reconciliation across restart and provider changes.
- Explicit freshness, source, disagreement, and degraded-state reporting.
- In-product alerts for registration, threshold, reward, withdrawal, gas, ingestion, and transaction
  risks.
- Health endpoints, metrics, structured redacted logs, backups, and support bundles.

## Trust and authority

Sidekick must never accept the signer consensus private key, a manager-admin private key, an operator
mnemonic, or generic transaction authority. V1 supports Observe and approval-gated Assist, and every
deployment starts in Observe. Assist may use one dedicated, low-balance gas-payer key only for the
fixed code-backed adapter; V1 has no Automate mode.

Browser-wallet execution is separate from Assist. Sidekick seals one expiring, server-derived
request; the browser discards any returned signed bytes and submits only the txid. The server
independently decodes the node-fetched transaction and verifies canonical poststate before
completion.

Browser-wallet actions support every configured Sidekick network when the wallet supports its exact
network key. Sidekick verifies the observed chain ID. Custom-network wallet support varies; manual
handoff always remains available.

Observe may expose the fixed claim adapter's existing preflighted job through this external path.
It does not replan the job or create an Assist approval, nonce reservation, or attempt. The job
retains the exact reference-manager profile and attestation gates.

Network and manager profiles identify deployments, guide Fresh setup, and gate Assist; they do not
gate fixed externally signed manager administration or registration. Assist also requires a
matching authenticated compatibility attestation and independent security review. Mainnet
additionally requires a production-approved manager profile; non-mainnet networks do not. Unsafe
conditions stop new broadcasts; observation and reconciliation continue for durably committed
attempts. The
[transaction-engine contract](transaction-engine-v1.md) defines the complete authority, admission,
and recovery rules; see also
[ADR 0007](../architecture/decisions/0007-release-independent-network-compatibility.md).

## Data and architecture

The local node is authoritative for current actionable state and cycle boundaries. The Stacks API
provides enumeration, history, and transaction enrichment. SQLite is a projection and audit trail,
never the sole authority for a broadcast decision.

If the API is unavailable, Sidekick preserves node-derived current state and pauses work that needs
complete enumeration. If the node is unavailable or disagrees materially with the API, Sidekick
does not plan or broadcast state-changing work.

The default deployment is one container with one active worker and SQLite writer. Horizontal
scaling and Postgres are outside V1. Cross-cutting decisions are recorded in the
[architecture index](../architecture/README.md).

## Acceptance

V1 is complete when:

- Attach and Fresh setup work without Sidekick receiving a signer or manager-admin private key.
- Browser-wallet setup, fixed manager administration, and Observe reward claims send only sealed
  requests, accept only a txid, independently verify completion, retain the manual path, and pass
  released-wallet tests at the deployed origin. PoX-5 Testnet binds chain ID `0x80000005`, never
  ordinary testnet.
- Wrong network or interface blocks external actions; untrusted source clearly warns and blocks
  Assist only. Revoked grants, unsupported bonds, and insufficient threshold are clear.
- Relevant manager history can be rebuilt and reconciled.
- Current and future STX membership, deadlines, rewards, and withdrawals are visible and exportable.
- The generated pool artifact contains only reviewed public information.
- The fixed manager-claim adapter satisfies every
  [transaction-engine rollout gate](transaction-engine-v1.md#rollout-gates).
- State changes are authenticated and auditable, complete only after intended effects reconcile, and
  fail closed on data disagreement or policy violations.
- External-node OCI/Compose deployment, migration, backup, and restore are tested; security and
  supply-chain reviews are resolved; and release artifacts and operator documentation are published.

## Deferred

Post-V1 capabilities require separately scoped
[issues](https://github.com/stx-labs/signer-sidekick/issues). Automate and custom-manager automation
also require reviewed code-backed adapters; Assist approval authorizes neither. Protocol decisions
still needing confirmation remain in [Open technical questions](open-technical-questions.md).

## References

- [SIP-045](https://github.com/stacksgov/sips/blob/main/sips/sip-045/sip-045-pox-5-bitcoin-staking.md)
- [Contract provenance](../../contracts/PROVENANCE.md)
