# Signer Sidekick scope and decisions

- Status: Living reference. The original slice-by-slice implementation plan and its dated checkpoints
  are in git history; this doc keeps only the durable product boundary and the recorded decisions.

## Decision summary

Signer Sidekick is the stateful operations companion for one running, registered PoX-5 signer and
its signer-manager. It continuously reconciles the operator's on-chain and signer reality, preserves
an auditable history, explains what changed, identifies what needs attention, and safely prepares the
recurring operations of running a signer or pool.

It does not deploy a signer-manager, install or manage node/signer infrastructure, or host a
staker-facing application:

- [stx.fan Zero to Signing](https://stx.fan/zero_to/signing/) provides the general, one-time,
  wallet-signed path from no manager to a registered and staked signer.
- [StacksUp](https://github.com/stx-labs/stacksup) owns service installation, configuration,
  lifecycle, chainstate, logs, and commands that must execute inside a node or signer container.
- Sidekick owns durable PoX-5/operator state, manager-capability operations, rewards, alerts,
  protocol-level signer health, transaction evidence, and the support snapshot.

Sidekick does not require a recognized signer-manager source version before it can attach, observe,
or explain the operator's core PoX-5 state. The manager trait standardizes only `validate-stake!`, so
broader operations cannot be inferred from trait compliance alone. Sidekick exposes a manager-neutral
PoX-5 baseline for every attached manager and adds normalized manager interactions only when runtime
capabilities satisfy a reviewed behavioral adapter. Executable adapter admission requires the deployed
source to match an immutable source fingerprint reviewed for that capability; this is an execution
gate, not a manager-version, attachment, or observation gate. The initial mainnet contract census and
the compatibility layers are documented in [Manager compatibility baseline](manager-compatibility-baseline.md).

The design is **event-driven but not event-trusting**. Stacks Core callbacks make Sidekick react
promptly even when no browser is open, but a callback is a trigger and evidence, not the final
authority: current state is still proved with anchored local-node reads, and periodic reconciliation
plus API backfill cover gaps and reorgs.

Assist remains a future execution mode, not the product definition. The useful product exists in
Observe with wallet-signed operations; Assist may later automate the same reviewed plans after its
release gates are met.

## Product test

“Does it need memory?” is a useful first test but not sufficient. Route a proposed feature by:

1. Does it create, configure, upgrade, restart, back up, or inspect a daemon/container? → StacksUp.
2. Is it a general one-shot wallet flow reconstructable from current public chain state, with no
   operator history? → an stx.fan dApp.
3. Does it need operator-specific durable state, reconciliation, provenance, alerting, recurring
   scheduling, transaction ambiguity handling, signer diagnosis, or a contract-capability safety
   policy? → Sidekick.
4. Is it a public surface for a staker rather than the operator? → not Sidekick.

This deliberately leaves some superficially stateless actions in Sidekick: updating a manager fee or
submitting a reward claim can be done by a static dApp, but Sidekick is the primary path when it can
bind the action to reconciled state, preview exact bytes and post-conditions, record the result, and
warn about races. The static dApp is the break-glass fallback.

## Operator jobs to be done

An operator should answer these without assembling contract calls or opening several monitoring
products. The Overview answers “what needs attention now?”; other pages explain and operate one domain
(normative rules in the [Overview attention model](overview-attention-model.md)).

- Is the network signing normally, and are my node, signer, registration, grant, and current/next
  eligibility okay?
- If signing is unhealthy, is the evidence most consistent with my node, my signer, a source/API
  problem, a network-wide problem, or not enough evidence yet?
- What changed since I last looked, what supports it, and is any source stale?
- Who is in my pool now and in future cycles (STX-only and Bitcoin-bond), and which joins, exits, or
  unlocks need attention?
- What rewards are accruing, when is the next calculation, and what fees am I likely to earn?
- Which operation is due now, what will it do, who must sign it, and did it reach canonical finality?
- If something breaks, can I export one redacted record that lets Stacks Labs reconstruct node,
  signer, Sidekick, chain-source, and transaction state?

## Product boundaries

### In scope

- One network, signer, and signer-manager per deployment.
- Durable manager, signer, pool, rewards, transaction, and protocol-health observations.
- A manager-neutral PoX-5 baseline for every attached contract satisfying the network's
  signer-manager trait, without a recognized-source/version requirement.
- Runtime ABI/source inspection and capability reporting; normalized interactions only through
  reviewed capability adapters. Unknown custom features stay visible as custom contract activity but
  do not acquire executable behavior automatically.
- Local-node-first current state with explicit provenance and domain-specific freshness; indexed
  roster/history discovery followed by local-node verification wherever the protocol exposes a proof.
- Current and future pool membership, signer-set eligibility, prepare-window, and unlock visibility for STX-only
  positions and the STX side of Bitcoin bonds.
- Reward calculation state, accrual, projections, manager fees, staker claims, withdrawals, and
  permissionless calculation readiness.
- Signer registration/key rotation and any manager admin, fee, withdrawal, claim, payout, or recovery
  operation whose detected capability has a reviewed adapter.
- Wallet-signed transaction plans with deterministic bytes, post-conditions, anchored preflight,
  durable observation, ambiguity handling, and audit history.
- Signer-protocol health from node RPC, signer monitoring, calibrated metrics, and independent
  network-reference evidence, without overstating certainty.
- Actionable alerts and a comprehensive redacted support snapshot.
- Observe as the default mode; Assist only through the existing explicit release gates.

### Out of scope

- Fresh signer-manager deployment or first-time staking.
- Public pool pages, public wallet connections, or staker transaction submission.
- Node, signer, Bitcoin, API, database, Docker, systemd, or host lifecycle management.
- Host CPU, memory, disk, logs, backups, or general observability.
- Signer private keys, manager-admin private keys, wallet custody, or a Docker socket.
- Bond creation, Bitcoin L1 lock creation, SPV proof submission, early exits, or rollovers.
- Contract-source or contract-version allowlists that block otherwise provable baseline behavior.
- Multi-tenant or hosted control-plane behavior.

## Still open

- Operational-latency validation for the observer path.
- Assist execution mode (release-gated; ownership and incident response decided before it ships).
- A non-reference executable capability adapter, which requires the adapter approver plus the
  source-fingerprint review process.
- Removal of the remaining setup-era compatibility internals after the legacy database and support-
  artifact boundary is fixed, including dormant onboarding schemas, `deploy-manager` history types,
  the unmounted Manager page, and manager-generation helpers.
- Removal of the legacy `/api/v1/status` alert projection after every remaining consumer has an
  independent page contract.
- Continued calibration of the closed Signer Health rule catalog against real incidents. This may
  tune thresholds but does not reopen the evidence-authority or external-reference decisions.

## Recorded product decisions

- **Signer-health confidence and retention:** local node/signer evidence is sampled every five
  seconds and distinct API references every 30 seconds, with 72 hours of raw evidence, 90 days of
  five-minute rollups, and findings recorded as durable episodes. A single API is comparison evidence
  only. Exact thresholds and contracts are normative in [Signer Health v2](signer-health.md), and the
  authority/attribution/external-reference boundaries in the
  [Signer Health diagnosis model](signer-health-diagnosis-model.md). Sidekick does not require the
  Hiro Signer Metrics API or build a signer-cohort explorer for routine local diagnosis.
- **Support-artifact seam:** the support bundle is the complete protocol, manager, signer, observer,
  and Sidekick record. It carries a correlation window and requests an optional StacksUp/operator
  infrastructure companion artifact; Sidekick gains no host control, and a missing companion does not
  block bundle generation.
- **External first-time setup boundary:** Sidekick treats `https://stx.fan/zero_to/signing/` as the
  preferred replaceable day-zero handoff, not a Sidekick-owned dependency. Support begins once a
  trait-compatible manager is deployed and the operator supplies its principal. The manual fallback
  links the pinned upstream reference-manager source and official Stacks contract-deployment guidance.
- **Manager census cadence:** refresh the checked-in anchored census before a capability-adapter
  change, after a PoX/Stacks Core upgrade, when monitoring finds a new source/interface, and at least
  monthly while the deployed population changes. Census evidence prioritizes review but never grants a
  runtime capability. See [research/signer-manager-census](../../research/signer-manager-census/README.md).
- **Capability deployment identity:** source bytes alone do not identify executable semantics (the
  same source deploys under multiple Clarity versions). Capability evidence binds exact source
  SHA-256, Clarity version/epoch, and canonical callable-interface SHA-256; token hashes remain
  research evidence only.
- **Frozen operator navigation:** Overview, Pool, Rewards, Activity, Signer Health, Settings. Manager
  and Operations were removed after their actions/history moved; old URLs get no redirects; action
  workspaces are contextual routes. Normative contract:
  [Activity and action workspace](activity-and-action-workspace.md).
- **Reward-calculation and Assist timing:** the Rewards page shows a newly eligible calculation as
  normal `awaiting calculation`; Overview adds an action only after ten minutes and 24 newer canonical
  Stacks blocks with an advancing node and current witnesses. Unattended Assist stays separately gated
  and cannot become eligible before 30 minutes and 120 blocks. Forecast sampling, calibration,
  contract simulation, fee semantics, and recovery are normative in
  [Reward outlook and calculation](reward-outlook.md).
- **Browser delivery:** node callbacks and periodic anti-entropy update server-owned projections
  without a browser. A visible dashboard reads those cached projections every 15 seconds. SSE or
  WebSockets may be added only if measured operator latency justifies the extra proxy and connection
  lifecycle; browser push is not required for event-driven reconciliation.
- **Domain-specific freshness:** Sidekick has no deployment-wide `fresh` bit. A local node that is
  current remains authoritative when an indexed API is behind; only the API-dependent domain is
  delayed. The 30-minute roster reconciliation is an anti-entropy/display baseline, never permission
  to prepare an action from 30-minute-old inputs. Every money-moving plan obtains its own anchored,
  action-specific witnesses immediately before it is sealed.
