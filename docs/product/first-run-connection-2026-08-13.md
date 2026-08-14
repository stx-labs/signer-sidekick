# First-run connection contract

- Status: Implemented in the Slice 3 connection change
- Date: 2026-08-13
- Parent: [Signer Sidekick scope reset](scope-reset-plan-2026-08-13.md)

## Purpose

Removing Initial Setup must not replace it with another wizard. A new Sidekick deployment performs
a short, read-only connection assessment against one already-deployed signer manager, then opens
the ordinary operator experience. Sidekick never records setup steps, asks the operator to complete
a checklist, deploys a contract, registers a signer, stakes STX, or imports a setup artifact.

The assessment answers one narrow question:

> Can this Sidekick instance establish its baseline PoX-5 context from the configured local node
> and signer-manager principal?

Registration, eligibility, data coverage, signing health, and executable manager actions are
separate facts. A problem in one of them must not be presented as a failed Sidekick connection.

## Product handoff

The expected lifecycle is:

1. Run the node and signer with StacksUp or upstream operator procedures.
2. Complete first-time on-chain setup with
   [Zero to Signing](https://stx.fan/zero_to/signing/).
3. Deploy Sidekick with its network, local node RPC URL, signer-manager principal, and operator
   credential. API and signer-monitoring sources are optional.
4. Let Sidekick verify the public result independently from its local node.
5. Operate from Overview, Pool, Rewards, Activity, Signer Health, and Settings.

Zero to Signing may display a handoff summary containing the network, signer-manager principal,
registered signer public key, registration transaction, and initial stake transaction. Sidekick
accepts only its normal deployment configuration and rediscovers the other facts. It must not
import grant JSON, keys, transaction assertions, or a trusted `setup complete` flag.

The external dApp should not call itself "Zero To Signing Sidekick" after this boundary ships.
"Zero to Signing" or "Signer setup" avoids implying that it is this operations product.

## Configuration boundary

`SIDEKICK_MANAGER_PRINCIPAL` remains required deployment configuration. An absent or syntactically
invalid value is a startup/configuration error with an explicit message; it is not an in-dashboard
manager picker. The UI must not persistently mutate the deployment identity.

A contract missing at the configured principal is different from an absent configuration value.
The former is a valid first-run recovery state that Sidekick can explain after it reaches the local
node. Changing an environment value requires a Sidekick restart; **Recheck** only repeats public
chain reads with the configuration already loaded by the process.

## Connection gate

The minimal connection assessment uses the configured local node only and proves:

- the local node RPC is reachable;
- the node and configured Sidekick network agree and PoX-5 is available;
- the signer-manager principal belongs to that network;
- a contract exists at the principal; and
- its deployed interface satisfies the network's exact PoX-5 signer-manager trait.

These are the only connection gates. The following must not prevent connection or the universal
PoX-5 baseline:

- registration or signer-grant state;
- current or next signer-set membership, weight, or stacking threshold;
- source/profile recognition or availability of any manager action adapter;
- indexed API reachability, compatibility, or freshness;
- roster/history reconciliation;
- node metrics or signer-monitoring reachability; or
- full reward, pool, activity, or health projection completion.

A stale or lagging local node is a critical operational finding and blocks actions that require
current evidence, but it does not change the meaning of whether Sidekick connected to the intended
network and manager.

## Four independent states

The UI and API must carry these dimensions independently rather than derive one global `blocked`
or `ready` result:

| Dimension | Question | Typical states |
| --- | --- | --- |
| Connection | Can Sidekick identify the intended chain and a trait-compatible deployed manager? | checking, connected, blocked, unavailable |
| Signer readiness | Is a signer registered, authorized, and eligible for the relevant cycle? | ready, attention, blocked, not checked |
| Data coverage | Which current, indexed, historical, and telemetry sources supplied evidence? | current, delayed, unavailable, not configured |
| Action availability | Can this exact recurring operation be planned safely now? | available, stale, missing evidence, unsupported capability, unauthorized |

The unqualified words `ready`, `blocked`, `unsupported`, and `unverified` must not summarize the
whole deployment when only one dimension is affected.

The connection API must expose stable machine-readable outcomes rather than require the dashboard
to parse prose:

| Outcome code | Connection result | Meaning |
| --- | --- | --- |
| `node-unreachable` | unavailable, or last connected result marked stale | The current attempt could not read the configured local node |
| `node-network-mismatch` | blocked | The reachable node is not on the configured network |
| `pox5-unavailable` | blocked | The reachable configured network cannot supply the required PoX-5 contract context |
| `principal-network-mismatch` | blocked | The configured manager principal belongs to another network |
| `manager-not-deployed` | blocked | No contract exists at the configured principal at the proved local tip |
| `manager-trait-mismatch` | blocked | A deployed contract exists but does not satisfy the exact trait |
| `deployment-identity-mismatch` | blocked, diagnostic safe mode | Stored network/manager identity differs from current configuration |

`checking` is transient presentation state, not a persisted fact. First-run node unavailability is
`unavailable`, not proof that the configuration is wrong. When a previously proved connection
cannot be refreshed because the node is temporarily unavailable, retain its last-successful anchor
and timestamp as stale evidence rather than converting it into either a fresh success or a
configuration failure.

## Entry behavior

After authentication, a deployment without a successful current connection assessment shows one
focused page:

> **Connect Sidekick to your signer**
>
> Sidekick monitors an existing PoX-5 signer and signer-manager contract. This check is read-only.
> Sidekick will not deploy contracts, register a signer, move funds, or access private keys.

The page renders the local checks as they finish. It must not wait for a complete operator snapshot,
an indexed API, roster/history synchronization, reward reads, or signer telemetry. It has no step
numbers, Continue button, resumable workflow, completion checkbox, or setup-progress persistence.

As soon as the connection gate passes, route to Overview. Optional sources and domain projections
load independently and describe their own coverage. Returning to the app does not replay a wizard;
Sidekick simply revalidates its configured connection as part of normal operation.

## Outcome and recovery copy

### Contract not deployed at the configured principal

> **Signer manager not found**
>
> No contract was found at `<principal>` on `<network>`. If on-chain setup is incomplete, finish it
> in Zero to Signing. If this is the wrong principal, update `SIDEKICK_MANAGER_PRINCIPAL` and
> restart Sidekick.

Actions: **Open Zero to Signing**, **Copy configured principal**, and **Recheck**.

### Local node cannot be reached

> **Could not check the local node**
>
> Sidekick could not reach `<configured node URL>`, so it cannot verify this deployment yet. Check
> the endpoint and node availability, then recheck.

This is `unavailable`, not a failed manager or unhealthy signer. If Sidekick has an earlier proved
connection, show that anchor and its age explicitly while keeping evidence-sensitive actions
paused.

### Principal or node on the wrong network

> **Network configuration does not match**
>
> Sidekick is configured for `<configured network>`, but `<specific observed source or principal>`
> belongs to `<observed network>`. Correct the deployment configuration and restart Sidekick.

Show the configured and observed values. Do not suggest Zero to Signing unless the manager truly
has not been deployed.

### Deployed contract fails the trait check

> **This contract is not a PoX-5 signer manager**
>
> A contract exists at `<principal>`, but its deployed interface does not satisfy the PoX-5
> signer-manager trait required for baseline monitoring. Sidekick has not changed anything.

Show the exact missing or mismatched trait requirement and a copyable principal. Treat this as a
contract-selection/configuration problem, not a source-version or profile-recognition problem.

### Registration or grant needs repair

Connection succeeds and Overview opens:

> **Signer authorization needs attention**
>
> Sidekick connected to `<principal>`, but `<registration or grant fact>` is missing or invalid.

Offer the applicable day-2 registration/key-repair operation when its reviewed adapter is
available. Link to Zero to Signing only as secondary guidance for an operator who has never
completed the initial on-chain flow.

### Signer monitoring is not configured or unavailable

> **Runtime signer identity not checked**
>
> Configure a signer monitoring endpoint to compare the running signer key and observe signing
> participation.

Use `not checked`, not `unhealthy`, unless runtime evidence demonstrates an unhealthy signer.

### Indexed API is behind or unavailable

> **Local node live; indexed data delayed**
>
> Current local-chain monitoring remains available. Roster history and other indexed views show
> their last verified anchor or remain unavailable until the API recovers.

This is a data-coverage state, never a failed manager connection.

### Manager has only baseline support

> **Custom manager connected**
>
> Baseline PoX-5 monitoring is available. Each recurring manager action is enabled only when its
> deployed behavior matches a reviewed Sidekick capability adapter.

List availability per operation. Do not call the manager globally unsupported or unverified.

## First useful Overview

The first successful screen identifies facts without collapsing them into "signing":

- network and configured signer-manager principal;
- registered signer public key and grant validity;
- runtime signer key match, or `not checked` with the missing source named;
- registration and current/next-cycle membership, weight, and threshold status;
- STX-only and Bitcoin-bond participant coverage as those projections arrive; and
- local-chain, indexed-history, reference, and signer-telemetry coverage with source-specific age.

Preferred summary form:

> **Monitoring `<principal>`**
>
> Signer key `<key>` · registered · grant valid<br>
> Current cycle `<n>`: `<eligibility>` · Next cycle `<n+1>`: `<eligibility or projection>`<br>
> Coverage: local chain `<state>` · signer telemetry `<state>` · indexed history `<state>`

Never use "setup complete" or "signing" as a deduction from registration or an initial stake.
Signing health requires current-cycle eligibility plus actual participation evidence.

## Durable deployment identity

After the first successful connection gate, Sidekick atomically records a versioned deployment
identity containing the configured network/chain identity and signer-manager principal. This binds
the SQLite history to one operator context.

On every later startup:

- matching configuration proceeds normally;
- a signer-key rotation or deployed-source observation does not change deployment identity;
- a network or manager-principal mismatch enters diagnostic safe mode before any reconciliation,
  event ingestion, projection write, transaction planning, or Assist activity;
- the UI shows both stored and configured identities and permits read-only Settings and support
  export; and
- Sidekick never silently rebinds, merges histories, or offers a one-click dashboard reset.

Liveness remains available in diagnostic safe mode so an orchestrator does not erase evidence in
a restart loop. Readiness reports a stable deployment-identity mismatch code and remains non-ready
until the configuration/database pairing is corrected.

To operate a different manager, use a new empty database path. To restore, use a database whose
stored identity matches the configured deployment. A migration for a legacy unbound database may
bind it automatically only when all existing manager-scoped and network-scoped evidence agrees
unambiguously with the configured identity; otherwise it must enter the same diagnostic safe mode.

## Implementation and acceptance contract

- Provide an authenticated, bounded connection-assessment response independently of the
  comprehensive operator snapshot. A forced Recheck must be coalesced and must not start roster or
  history synchronization.
- Replace the setup-era `sidekick attach <manager>` CLI with a read-only connection-check command
  that uses the same required `SIDEKICK_MANAGER_PRINCIPAL` and network configuration as `serve`.
  It must exit nonzero only for a blocked/unavailable connection, not for missing registration,
  ineligibility, optional-source gaps, or unavailable manager actions.
- Preserve the last proved connection result during a temporary local-node read failure, mark it
  stale with its timestamp, and block evidence-sensitive actions; never represent stale evidence
  as a new successful assessment.
- Route to the connection page only while the connection dimension is blocked or has never
  succeeded. Registration, eligibility, API, telemetry, and capability problems route to the
  ordinary operator pages with focused alerts.
- Include connection state, deployment-identity state, source coverage, exact failure evidence,
  and timestamps in the support snapshot without secrets.
- Test new/empty, legacy-unbound, matching-bound, and mismatched-bound databases.
- Test the stable result-code matrix for unreachable node, missing contract, wrong network, trait
  mismatch, and deployment-identity mismatch, plus the non-gating cases of missing
  registration/grant, absent signer telemetry, API outage/lag, and a trait-only custom manager.
- Test that a new deployment reaches either the focused recovery page or Overview without waiting
  for indexed data, roster sync, rewards, or signer telemetry.
- Test the exact distinction between Recheck and restart-required configuration changes.
