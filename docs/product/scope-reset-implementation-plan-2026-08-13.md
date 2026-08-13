# Scope-reset implementation plan

- Status: Active planning and implementation
- Date: 2026-08-13
- Parent: [Signer Sidekick scope reset](scope-reset-plan-2026-08-13.md)
- Evidence: [Deployed signer-manager baseline](../reviews/deployed-signer-manager-baseline-2026-08-13.md)

## Delivery rule

The setup-removal milestone and the V2 operations roadmap are related but distinct.

- **Scope-reset milestone:** land the node-first foundation; make attachment and baseline
  observation manager-neutral; extract recurring operations; delete setup and public-staker
  surfaces; replace the product documentation.
- **V2 roadmap:** event ingestion, broader manager adapters, reward projection, durable
  network-versus-local diagnosis, richer support handoff, and eventually Assist.

Do not hold setup deletion for every V2 feature. Do not add a new subsystem during the reset unless
it is required to remove the old boundary safely.

## Invariants across every slice

1. A trait-compliant manager attaches and receives the PoX-5 baseline without a known product
   version or source profile.
2. A money-moving capability executes only when the deployed byte-exact source matches a fingerprint
   reviewed into that capability's code-owned adapter.
3. Editable configuration, an ABI name match, or an observer callback cannot grant execution
   authority.
4. The local node remains authoritative for current chain state; APIs discover candidates/history
   and provide independent comparison.
5. STX-only and bond-derived STX positions both contribute to signer membership, weight, rewards,
   and support evidence. Sidekick never creates or manages the Bitcoin bond.
6. Signer keys and wallet/admin private keys never enter Sidekick.
7. Removing setup must not weaken anchored reads, deterministic transaction bytes,
   post-conditions, post-state verification, ambiguity handling, or audit evidence.

## Scope-reset milestone

### Slice 0: land the substrate

Purpose: make the current node-first/background-refresh work the stable base.

- Reconcile the branch with current `main` without losing staged scope documents.
- Retain node-first domain degradation, background snapshot/roster refresh, support snapshot,
  responsive navigation, and trusted-header authentication.
- Prove a healthy local node remains usable during API lag while indexed-only domains show bounded
  stale evidence.

Gate:

- existing unit/browser/container checks pass;
- local-node-only current status remains available when the reference API is behind or unavailable;
- a high-risk action still fails closed when one of its own witnesses is missing or stale.

### Slice 1: manager-neutral attachment and capability inventory

Purpose: remove the current reference-manager interface as a product-wide attachment gate without
loosening execution.

Implementation:

- Validate the exact PoX-5 signer-manager trait shape for `validate-stake!` from the node ABI.
- Set `attachAllowed` from network match, deployed-contract presence, and trait compatibility only.
- Preserve deployed source/structure fingerprints and provenance as evidence.
- Report observed public/read-only functions and capability-specific missing requirements.
- Persist every manager print event as raw evidence, but apply the reference-manager event
  vocabulary and durable claim/admin/withdrawal projections only through a byte-exact reviewed
  event adapter. Version event cursors by vocabulary so classification changes force a replay and
  remove projections that are no longer justified.
- Replace the global “unsupported manager” finding with a precise trait/deployment failure.
- Represent existing reference administration/reward behavior as reviewed capabilities whose
  execution additionally requires an exact reviewed source match.
- Hide or disable each existing manager action when its capability is absent; do not claim that an
  unknown manager's actions are safe merely because similarly named functions exist.
- Keep Assist eligibility separate from wallet-signed capability availability.

Primary code areas:

- `apps/sidekick/src/manager-verification.ts`
- a new capability module under `apps/sidekick/src/`
- `packages/api-contracts/src/v1.ts`
- `apps/sidekick/src/operator-service.ts`
- dashboard action availability and manager/settings presentation
- manager verification, operator alert, API contract, and dashboard tests

Gate:

- a contract exposing only the exact trait can attach and render baseline state;
- a wrong-network, missing, or trait-incompatible contract cannot attach;
- a full but unreviewed reference-shaped ABI cannot prepare an existing manager action;
- a custom event that resembles a reference-manager print remains generic and cannot populate
  normalized operator history;
- a reviewed reference source retains its current wallet-signed operations;
- source recognition changes do not hide PoX-5 registration, signer-set, pool, or health state.

### Slice 2: extract recurring operations

Purpose: separate valuable day-2 operations from onboarding before deleting onboarding code.

The retained action contract, authority, and evidence matrix is maintained in
[Recurring operation contracts](recurring-operation-contracts-2026-08-13.md).

- Move generic wallet-intent lifecycle, canonical transaction observation, signer registration/key
  rotation, manager administration, and reward actions out of onboarding modules.
- Split action construction by capability adapter.
- Rename setup readiness to manager/operation readiness.
- Remove navigation and state dependencies on Fresh/Attach activation plans.

Gate:

- each retained action has an explicit capability, authority, inputs, post-conditions, expected
  event/post-state, and test vector;
- no retained operation imports a Fresh deployment/rendering module;
- operator snapshots and support artifacts remain backward-readable through an intentional schema
  migration.

### Slice 3: delete setup and public-staker surfaces

Purpose: complete the actual complexity reset.

- Remove contract rendering/deployment, first-time grant/registration, setup wizard/progress,
  activation plans, Initial Setup page, public pool page, enrollment artifacts, and setup-only
  commands/routes/persistence/tests.
- Replace the first run with configured-manager connection, trait, signer identity, registration,
  eligibility, participant-type, and source-coverage checks.
- Point an unattached operator to the maintained Zero to Signing experience.
- Rewrite README, deployment, architecture, testnet, and Devnet acceptance around an already-running
  signer and manager.

Gate:

- no runtime setup/public-staker route or artifact remains;
- a new deployment reaches a useful operator screen without offering deployment;
- the Zero to Signing ownership/support decision is recorded;
- the attach/observe/action Devnet acceptance path replaces the setup acceptance path.

## V2 roadmap

### Slice 4: registration-derived manager census and adapters

- Enumerate registered managers and current/next signer sets at a recorded node anchor.
- Supplement with checksummed `by_trait` deployment discovery and observed activity.
- Classify active, historical, not-yet-registered, test/unused, and unknown contracts.
- Generate structural/semantic diffs and transaction/event fixtures.
- Prioritize reusable capability adapters by active usage, not deployment count.

The census is research/test input. It must not become a product-wide attach allowlist.

### Slice 5: authenticated-by-verification event pipeline

- Add a private bounded callback listener and durable inbox.
- Persist callbacks as `observer-claimed`; acknowledge only after the inbox commit.
- Confirm referenced canonical transaction/block/event through an anchored local-node read before
  promoting an entry to permanent `node-verified` history.
- Quarantine/expire forged, malformed, noncanonical, or unverifiable claims with reasons.
- Add idempotency, coalescing, gap/reorg recovery, API backfill, anti-entropy, metrics, and support
  evidence.

Gate:

- callback loss, duplication, reordering, restart, and reorg converge;
- a forged callback never reaches permanent activity history or current projections;
- cheap event-affected projections meet the two-second p95 target under normal load.

### Slice 6: reward outlook

- Persist exact `get-new-rewards` global accrual and the next calculation checkpoint.
- Build the integer simulator with golden vectors generated by executing the real vendored PoX-5 in
  Clarinet simnet over synthetic STX/bond states.
- Add ranges, confidence/calibration, explicit assumptions, realized-error history, and omission
  when inputs are incomplete.
- Prepare/observe wallet-signed `calculate-rewards`; leave unattended execution behind Assist.

### Slice 7: signer/network diagnosis and support handoff

- Persist cheap five-second node/signer evidence and useful rollups.
- Calibrate identity, registration, signer-set, proposal receipt/response, latency,
  acceptance/rejection, chain progression, and comparison-source findings.
- Classify likely local node, likely local signer, source disagreement, suspected network-wide, or
  insufficient evidence with the evidence window attached.
- Add observer/capability/source-comparison/incident context to the support snapshot.
- Define a time-correlated StacksUp or operator-observability companion artifact without adding host
  control or unrestricted logs to Sidekick.

### Slice 8: Assist re-evaluation

- Re-run independent security review on the reduced action surface.
- Require reviewed capability fingerprints, attestation, nonce/finality/retry policy, revocation,
  fallback, audit, and incident ownership per operation.
- Enable capabilities independently; never infer Assist eligibility from broad manager recognition.

## Cross-slice validation

Every implementation slice should run the narrowest focused tests first, then:

```sh
pnpm check
pnpm test
pnpm test:coverage
pnpm test:regtest
pnpm build
```

Run browser, live Devnet, and container checks when the slice changes routes, operator workflows,
contract behavior, or deployment. Preserve the repository's signed-commit workflow and stage only
the reviewed slice for operator signing.

## Decisions required before their slice

- Capability adapter approver and source-fingerprint review process: before adding a non-reference
  executable adapter.
- Zero to Signing organizational ownership: before Slice 3 completes.
- Census refresh cadence: before automating Slice 4.
- Network reference/confidence rules and signer-health retention: before alerting in Slice 7.
- Support-artifact seam: before claiming single-artifact incident handoff.
- Reward confidence and permissionless-calculation policy: before presenting forecasts/actions as
  operational recommendations.
- Assist ownership and incident response: before Slice 8 can ship.
