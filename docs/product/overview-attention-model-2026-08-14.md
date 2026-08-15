# Overview attention model

- Status: Product and implementation contract
- Date: 2026-08-14
- Parent: [Signer Sidekick scope reset](scope-reset-plan-2026-08-13.md)
- Depends on: [First-run connection](first-run-connection-2026-08-13.md),
  [Activity and action workspace](activity-and-action-workspace-2026-08-14.md), and
  [Recurring operation contracts](recurring-operation-contracts-2026-08-13.md)

## Purpose

Overview answers one question:

> What needs the operator's attention now?

It is a decision page, not a second copy of Pool, Rewards, Activity, Signer Health, or Settings.
Overview composes already-authoritative domain projections, shows one ordered queue of current
attention, and links directly to the exact action or evidence. It does not infer readiness in the
browser, run expensive synchronization, or persist a second alert ledger.

The initial useful paint must still identify what Sidekick is monitoring and whether the operator
can trust the answer. It therefore combines:

1. a live operational snapshot of the cycle, network, node, and signer;
2. current attention;
3. active operations already in progress; and
4. compact Pool and Rewards summaries.

## Non-goals

Overview does not:

- display detailed rosters, reward accounting, transaction evidence, manager provenance, or raw
  health metrics;
- duplicate terminal Activity history or the Rewards pipeline;
- treat every missing optional source, custom manager, pending withdrawal, or source mismatch as
  an alert;
- expose a generic Manager or Operations destination;
- offer first-time deployment, staking, or setup steps;
- let the browser manufacture attention by comparing unrelated timestamps or status strings; or
- define external notification delivery, acknowledgement, paging, or Assist policy.

## Page contract

### 1. Operational snapshot

A subtle header says **Monitoring `<manager-principal>`** and names the network. The manager
principal is identity context, not a dashboard card.

The first row answers the two time-sensitive protocol questions an operator repeatedly needs:

- current reward cycle and phase, with the current Bitcoin burn height;
- next reward calculation/checkpoint: exact Bitcoin block, blocks remaining, and clearly labelled
  ETA; and
- next prepare phase: exact Bitcoin block, blocks remaining, and clearly labelled ETA.

“Next reward calculation” always means the PoX-5 protocol checkpoint. It must not be labelled as a
payout, claim, or withdrawal deadline. Money-moving work appears separately in Attention or
Rewards only when it is actually due.

The second row answers whether the operating stack is working and aligned:

- **Network:** advancing, needs attention, unavailable, or insufficient evidence, with the
  independent reference and latest observed network position named;
- **Local node:** aligned, behind, unavailable, or insufficient evidence, with Stacks/Bitcoin tips,
  peer/reference difference, and last advancement; and
- **Signer:** healthy, needs attention, unavailable, not configured, or collecting, with current
  cycle, recent participation/response evidence, and node alignment.

Each status links to the exact Signer Health section that explains it. An absent optional network
reference is “insufficient evidence,” never proof that the network is unhealthy. A local node ahead
of an indexed/reference API remains current; only the indexed/reference evidence is delayed.

Registration, grant, signer identities, manager capabilities, and eligibility do not appear in the
normal snapshot because they rarely change and are already available in Signer Health or Settings.
They appear on Overview only when an authoritative mismatch or currently actionable condition
qualifies for Attention.

There is no deployment-wide yellow freshness banner and no global `ready` score. Every snapshot
fact carries its own evidence age/coverage. One delayed source cannot make unrelated current facts
look stale or leave the whole page loading.

### 2. Attention

Attention is one ordered list. Every item names:

- what is true now;
- why it matters to this operator;
- the affected domain;
- the evidence age or exact protocol deadline;
- one typed primary action; and
- one optional typed details action.

Render the first five items without interaction. If more exist, **Show all `<n>` items** expands the
same list in place; Overview must not silently discard everything after the first three. The
expanded state is session-local and does not acknowledge or dismiss an item.

When no item qualifies, show one compact line:

> **No action is required right now.** Current evidence was checked `<age>` ago.

Do not render a large success card. Scheduled facts that are not due belong in the domain summaries,
not in Attention.

### 3. In progress

Show nonterminal Activity groups whose display status is `in-progress`. Each row contains the
operation title, current stage, last meaningful update, and a direct link to its Activity detail.
Items already shown as `action-required` or `needs-attention` appear only in Attention.

Show at most three in-progress rows plus **View all in Activity**. Omit the section when empty. A
browser closing must not affect this list or the underlying operation.

### 4. Domain summaries

Render two compact, linked summaries. Each owns its freshness and failure state. Signer and network
health is already prominent in the operational snapshot and is not repeated here.

#### Pool

- current and next cycle amount and signer-set membership;
- threshold margin for the next actionable cycle;
- STX-only and Bitcoin-bond participant counts when indexed coverage exists;
- the next material join, exit, amount change, or unlock; and
- roster/history coverage and age.

The card links to `#pool`, normally its forecast or roster section. It does not reproduce the
forecast chart or staker table.

#### Rewards

- exact global rewards accrued;
- estimated pool reward and operator fee with confidence; and
- calculation/claim coverage and age.

The card links to the relevant Rewards section. It does not show the full pipeline, bucket list, or
historical distributions.

## What qualifies as attention

An item appears only when the operator can act now, must investigate a current material condition,
or cannot safely proceed because required evidence is unavailable. Merely being interesting,
recent, custom, delayed, or scheduled is insufficient.

The operator-facing tiers are:

| Tier | Meaning | Examples |
| --- | --- | --- |
| `urgent` | A current safety, participation, or money-state problem can materially harm operation or makes the correct outcome ambiguous | Deployment-identity safe mode; sustained local-node failure while participation is expected; runtime/on-chain signer-key mismatch; ambiguous money-moving transaction |
| `action-required` | A reviewed, currently safe operator action is due now | Repair/rotate signer authorization; correct next-cycle threshold while the window is open; calculate rewards once eligible; resume a prepared wallet intent |
| `needs-attention` | A material abnormal or insufficient-evidence state needs diagnosis, but Sidekick cannot honestly offer a direct corrective transaction | Signer monitoring not configured; a domain exceeded its freshness budget; current-cycle ineligibility that can no longer be changed; an action is due but its capability/evidence is unavailable |

There is no `upcoming` tier. Future deadlines and expected changes remain on the Pool and Rewards
summaries until they become due. This keeps “attention now” literal and avoids reminder noise.

### Initial inclusion policy

| Source condition | Attention treatment |
| --- | --- |
| Deployment identity mismatch | One `urgent` safe-mode item; suppress derived write/readiness noise |
| Local node unavailable or materially behind after the health persistence threshold | `urgent` when current participation or an operation is affected; otherwise `needs-attention` |
| Signer unavailable, heartbeat failing, or runtime key mismatched after the health persistence threshold | `urgent` when the signer is expected in the current set; otherwise `needs-attention` |
| Signer monitoring not configured | One `needs-attention` coverage item linking to Settings; never `unhealthy` |
| Registration missing or grant invalid | `urgent` for proved expected current-cycle participation; otherwise `action-required` only when current/next signer-set membership, a prior valid registration/finding episode, or an explicit reviewed rotation proves this is a day-2 repair; without that evidence, link to external first-time setup or capability evidence and do not prepare `register-self` |
| Next actionable cycle below threshold while changes are open | `action-required`, linked to the exact Pool forecast/positions evidence |
| A cycle is already fixed and cannot be changed | Never present “fix this cycle”; show `needs-attention` only when the result materially affects expected participation, with the next actionable cycle named |
| Activity group is `action-required` or `needs-attention` | Reuse that group and its `ContextualAction`; do not create a second domain reminder |
| Activity group is `in-progress` | In progress section, not Attention |
| Durable Activity projection cannot be read | One `needs-attention` Sidekick item; never render an empty In progress section as proof that no work exists |
| Reward calculation or claim is currently due | `action-required` only when action-specific evidence is current and a reviewed operation is available; otherwise `needs-attention` with the exact missing witness/capability |
| Withdrawal or submitted transaction is proceeding normally | In progress/Activity only; attention begins only on ambiguity, failure, or a separately reviewed overdue policy |
| Indexed roster or history is delayed | Domain freshness only, unless it exceeds its budget and prevents a current decision or action |
| Public/reference API is behind while the local node is current | Never a deployment-wide item; only affected indexed/reference coverage is delayed |
| Custom or unrecognized manager source | Settings provenance/capability state, not attention by itself |
| Manager profile failed to load | Attention only when it removes a capability required by an action that is currently due |
| Manager recognition/Assist eligibility gained | Activity history only; no action is required |
| Observer callback gap with healthy polling fallback inside the projection latency budget | Settings/coverage only |
| Observer or fallback gap causes an affected projection to exceed its freshness budget | One `needs-attention` item for that affected domain |
| Health or source is collecting a baseline | Domain summary says `collecting`; not attention unless the source remains unable to answer a required question beyond its defined window |

Thresholds for signer behavior and network attribution still belong to the Signer Health calibration
contract. Overview consumes a typed finding only after that domain has decided it is supported; it
must not invent a threshold from raw counters.

“Expected current participation” requires a current or last-proved current-cycle signer-set record,
or an active operation explicitly bound to that cycle. A configured manager, historical membership,
or nonzero balance alone is not enough to promote an item to `urgent`.

## Root-cause aggregation and suppression

Overview must reduce symptoms to the smallest honest set of operator decisions:

1. Deployment-identity safe mode suppresses all downstream action-readiness items. Its detail names
   the blocked domains and leaves read-only diagnostics/support available.
2. A sustained local-node failure suppresses derived tip-gap, signer-node-height, current-state
   freshness, and action-witness symptoms. The item lists the affected domains.
3. Signer monitoring unavailability suppresses runtime-key and proposal-participation deductions
   that cannot be made without it.
4. Missing registration absorbs the absent-grant and eligibility consequences into one signer-
   authorization item. A present registration with an invalid grant remains its own exact item.
5. Unavailable roster evidence suppresses threshold conclusions that depend on that roster; it
   never turns an unknown value into “below threshold.”
6. An existing Activity group absorbs a domain reminder for the same operation scope. The primary
   action resumes the existing group instead of preparing a duplicate.
7. One source/freshness problem produces at most one item per affected domain, not one per card or
   failed upstream request.

Suppression is presentation and correlation, not evidence deletion. Every underlying finding and
coverage fact remains available in its domain detail and support snapshot.

## Ordering

The server returns Attention in this total order:

1. `urgent`;
2. `action-required`;
3. `needs-attention`;
4. overdue deadlines before future deadlines, with no-deadline items after both deadline groups;
5. earliest normalized `urgencyAt`, with `null` last;
6. earliest non-null `openedAt`, with `null` last, so known long-running unresolved items do not
   sink; and
7. ascending `attentionId` as the deterministic tie-breaker.

Protocol deadlines remain structured facts. `urgencyAt` is only the server's snapshot-time sorting
normalization and must not replace the exact burn height, reward cycle, or wall-clock deadline in
the UI or action preflight.

## Deadlines

```ts
type OperatorDeadline =
  | { kind: "burn-block"; burnBlockHeight: number; estimatedAt: string | null }
  | { kind: "reward-cycle"; rewardCycleId: number; phase: "before-prepare" | "cycle-start" }
  | { kind: "time"; at: string };
```

Bitcoin-block ETAs are estimates derived from the current sampled block interval and are labelled
as such. A transaction or staking action always rechecks the canonical height/window; it never
trusts `estimatedAt` or `urgencyAt` as authority.

## Actions

Overview uses the closed `ContextualAction` union from the Activity/action contract. It never
returns or interprets an arbitrary URL.

- Due operations launch `#action/<operation-code>` or resume their Activity group.
- Ambiguous/in-progress work opens the exact Activity detail.
- Health, Pool, Rewards, and Settings actions open an exact typed section.
- Stale evidence offers the bounded source/domain recheck, not a money-moving action.
- First-time setup remains outside Sidekick. `register-self` appears only as a reviewed day-2
  signer-key repair/rotation operation; manager deployment never appears.

Every Attention item has one primary action. `detailsAction` is optional and may only open the
related Activity group or exact domain section. Labels describe the actual verb: **Review signer
evidence**, **Repair signer authorization**, **Resume reward claim**, **Recheck local node**. Do not
use generic **Fix**, **Continue**, or **Retry**.

## Freshness and authority

Overview has no single `fresh` bit. Every operational-snapshot fact, each Attention item, every
active operation, and each domain summary carries its own evidence state:

```ts
type OverviewEvidence = {
  status: "current" | "delayed" | "unavailable" | "not-configured";
  observedAt: string | null;
  anchor: ChainAnchor | null;
  source: "local-node" | "signer" | "indexed-api" | "network-reference" | "sidekick-store";
  reason: string | null;
};
```

Rules:

- A fresh observation that a source is unavailable is current evidence of unavailability; it is
  not itself stale.
- The local node being ahead of an indexed/reference API delays only the domain that needs that
  source. It does not block local current state or blank Overview.
- A local node materially behind independent network evidence becomes a Signer Health finding only
  after that domain's persistence/confidence rule is met.
- A delayed item may retain its last known factual value, visibly dated. It cannot keep a
  money-moving primary action; that action is replaced with a bounded recheck until its exact
  witnesses are current.
- One unavailable domain renders its own state while the rest of Overview remains usable.
- The open dashboard receives server-pushed invalidation after projection commits and uses the
  existing visibility-aware 15-second cached-state poll as fallback. Overview refresh never runs a
  full roster/history synchronization.

The header's manual action is **Refresh current state**. It performs bounded local/cached domain
refreshes and may coalesce with existing work. Expensive full-roster reconciliation stays on Pool
or in the relevant recovery action; the Overview must not retain the current broad **Sync now**
semantics.

## Read projection, not another alert store

Each domain owns its findings, readiness, operation, and freshness policy. The Overview projection:

1. reads those typed domain outputs and Activity groups;
2. applies the documented root-cause correlation and total order;
3. returns a versioned page response; and
4. writes nothing.

`attentionId` is derived from the producing authority record or finding episode. It remains stable
while the same condition is unresolved. When the producer lacks durable episodes, it may expose a
stable current-condition key, but that key is not eligible for external notification deduplication
until the producer persists finding episodes. Overview must not add its own acknowledgement,
dismissal, or episode table.

An item resolves automatically when its authoritative domain state resolves. A later recurrence is
a new producer episode. The change may enter Activity once that domain's durable finding-change
contract exists.

## Proposed API contract

```ts
type AttentionTier = "urgent" | "action-required" | "needs-attention";
type OverviewDomain =
  | "connection"
  | "manager"
  | "pool"
  | "rewards"
  | "node"
  | "signer"
  | "network"
  | "sidekick";

interface OverviewAttentionItem {
  schemaVersion: 1;
  attentionId: string;
  tier: AttentionTier;
  domain: OverviewDomain;
  affectedDomains: OverviewDomain[];
  code: string;
  title: string;
  summary: string;
  impact: string;
  openedAt: string | null;
  updatedAt: string;
  deadline: OperatorDeadline | null;
  urgencyAt: string | null;
  evidence: OverviewEvidence[];
  relatedActivityId: string | null;
  relatedFindingId: string | null;
  primaryAction: ContextualAction;
  detailsAction: ContextualAction | null;
}

interface OverviewPage {
  schemaVersion: 1;
  generatedAt: string;
  monitoring: { network: string; managerPrincipal: string };
  cycle: OverviewCycleSnapshot;
  network: OverviewNetworkHealthSummary;
  node: OverviewNodeHealthSummary;
  signer: OverviewSignerHealthSummary;
  attention: OverviewAttentionItem[];
  inProgress: OverviewInProgressItem[];
  pool: OverviewPoolSummary;
  rewards: OverviewRewardsSummary;
}
```

The operational-snapshot and two domain-summary types are closed contracts with the fields listed
above; they are not generic label/value arrays. `OverviewInProgressItem` is a compact projection of
an Activity group and always carries its canonical `activityId`.

Add `GET /api/v1/overview`. It performs no upstream full synchronization and returns the latest
available domain projections with independent evidence states. The dashboard boundary schema is
strict and versioned.

Once all dashboard routes use their own page contracts, remove `/api/v1/status`, `DashboardAlert`,
`OperatorAlert`, and the browser-side alert-action switch rather than maintaining a second
attention system. Non-Overview pages must not wait on an Overview response before rendering.

## Current-code migration map

| Current area | Treatment |
| --- | --- |
| `operator-service.ts::buildAlerts` | Replace with typed domain finding/readiness producers plus the read-only Overview correlation projection |
| `DashboardAlert` / `OperatorAlert` | Replace with `OverviewAttentionItem` and the shared `ContextualAction` contract |
| `overview-page.tsx` `requiredAlerts.slice(0, 3)` | Replace with the ordered expandable Attention list; never silently truncate |
| Browser `AlertActionButton` target switch | Delete after every producer supplies a typed contextual action |
| Overview broad `Sync now` | Replace with bounded current-state refresh; keep roster/history reconciliation in its domain |
| Current cycle clock | Replace with the operational snapshot: reward cycle/phase, next calculation, next prepare phase, and independent evidence age |
| Pool KPI tiles | Collapse into the typed Pool summary and direct domain link |
| Reward pipeline | Move detail to Rewards; put next calculation timing in the operational snapshot and retain only accrual/estimate summary below |
| Registration/eligibility card | Move stable facts to Signer Health/Settings; retain only exact actionable Attention items |
| Global freshness banner | Remove; render freshness and availability on each operational/domain fact |
| Recent claims timeline | Remove; Activity owns active work and history |
| Manager source hash/provenance | Move to Settings capabilities/provenance |
| Header support-bundle button | Keep support export in Settings and Signer Health; surface it contextually during diagnosis rather than as Overview's dominant global action |
| Observer warning appended in `server.ts` | Move to observer/domain freshness policy; healthy fallback inside budget is not attention |
| Global `/api/v1/status` dependency in `main.tsx` | Replace with route-specific page loading and lightweight connection/app-shell state |

### Existing alert disposition

The current hand-built alerts migrate as follows:

- preflight failures become exact connection, local-node, or source findings and are root-cause
  aggregated;
- manager trait failure remains a connection recovery state, not an ordinary Overview item;
- custom manager recognition is provenance/capability evidence in Settings;
- profile-load and trust-loss states appear only when they affect a currently due operation;
- global `Operator Readiness Is Blocked` splits into exact registration, grant, eligibility, or
  evidence items;
- pool forecast attention names the exact actionable cycle and window;
- incomplete reward roster becomes Rewards coverage unless it blocks a due action;
- normal pending withdrawals move to In progress/Activity; and
- observer degradation appears only when the affected projection misses its freshness budget.

## Responsive and accessibility contract

- Mobile renders monitoring identity, cycle timing, network/node/signer health, Attention, In
  progress, then Pool and Rewards in that order.
- Attention rows are full-width stacked content with no horizontal scrolling.
- Tier and evidence state are always text; color/icons are supplemental.
- The primary action immediately follows its item's evidence/impact in the reading and tab order.
- **Show all** announces the new count and moves no existing focus unexpectedly.
- Auto-refresh does not steal focus, collapse expanded attention, or reorder the focused item until
  focus leaves it; the next paint then applies the server order.
- Changed counts/statuses use a polite live region; urgent items do not repeatedly announce every
  15-second poll when their `attentionId` and meaningful content are unchanged.
- Truncated principals, keys, and transaction IDs retain copy controls and accessible full values.

## Required contract tests

- The API schema rejects the old `DashboardAlert` shape, arbitrary navigation targets, missing or
  unknown versions, duplicate attention IDs, and an item without a primary action.
- A table-driven policy test covers every initial inclusion row and its exact tier/action.
- Root-cause tests prove safe mode, local-node failure, missing registration, missing signer
  telemetry, roster unavailability, and existing Activity groups suppress their derived duplicates.
- Sorting tests pin the full total order, including deadline/null and stable-ID tie-breakers.
- A local-node-ahead/indexed-API-behind fixture keeps the operational snapshot current and delays
  only indexed Pool, Rewards, and Activity coverage.
- A local-node-behind sustained finding becomes attention only after the Signer Health producer's
  persistence rule; Overview never compares tips independently.
- Local-node findings retain the `node` domain and never become `network` findings merely because
  they use peer or reference evidence. Network-wide classification requires its own independent
  source/confidence result.
- Delayed action evidence removes the money-moving action and offers a bounded recheck.
- Current unavailability is distinguished from stale last-success evidence.
- Normal in-progress work appears only in In progress; `action-required` and `needs-attention`
  Activity groups appear only in Attention.
- An Activity-source read failure produces explicit unavailable evidence and cannot silently become
  an empty Attention/In progress result.
- More than five items remain reachable through inline expansion; no item is silently dropped.
- Unknown/custom manager recognition alone produces no attention item.
- Observer fallback inside the latency budget produces no item; a missed domain freshness budget
  produces one correlated item.
- Route-level tests prove Overview renders its operational snapshot and available domain summaries
  while one domain is delayed/unavailable and does not remain on a page-wide loading state.
- Browser tests pin keyboard order, live-region behavior, narrow-screen layout, focus stability, and
  direct contextual actions.

## Implementation sequence

1. Add the versioned Overview, evidence, deadline, attention, and closed domain-summary contracts.
2. Refactor current alert conditions into typed domain producers without changing their underlying
   authority or persistence.
3. Implement the pure Overview correlation/suppression/sorting projection and table-driven tests.
4. Add `/api/v1/overview` over cached/current projections without full synchronization.
5. Rebuild Overview operational snapshot, Attention, In progress, and the two domain summaries.
6. Migrate every retained action to `ContextualAction`; remove the target-string alert switch.
7. Remove duplicated reward pipeline, manager provenance, recent-activity, and broad sync surfaces
   from Overview after their destination pages are present.
8. Remove the legacy alert contracts and `/api/v1/status` dependency when all page routes are
   independently loaded.
9. Run API, projection, browser, responsive, accessibility, Devnet, and support-snapshot tests.

Implementation checkpoint (2026-08-14):

- The strict versioned `ContextualAction`, evidence, deadline, operational-snapshot, Attention,
  in-progress, Pool, Rewards, and Overview page schemas are implemented. They reject setup-only
  operations, arbitrary/mismatched navigation, duplicate IDs, and legacy alert shapes.
- The initial pure projection implements deterministic ordering, root-cause suppression,
  Activity-over-domain operation deduplication, node-first source handling, protocol timing,
  health summaries, and independent Pool/Rewards evidence states. It writes no alert state.
- `GET /api/v1/overview` reads the cached full operator snapshot, current health projection, and
  canonical typed Activity projection. It never invokes full roster/history reconciliation;
  unavailable optional health or Activity data degrades only that part of the response. Overview
  does not maintain a second wallet-intent or engine-state mapper.
- The implemented producer matrix covers every initial inclusion-policy row, including fixed-cycle
  exclusion, roster-blocked threshold work, due reward calculation and claims, profile issues only
  when they remove a due capability, stale-action rechecks, and Activity-over-domain deduplication.
- The Rewards summary prefers the persisted checkpoint run-rate point for
  `estimatedPoolRewardSats`; before the minimum sample gate is met, it falls back to the
  contract-exact `if-calculated-now` pool estimate from one stable node anchor. Overview preserves
  that distinction through `estimateKind` and carries the checkpoint forecast's
  `low`/`developing`/`calibrated` confidence instead of collapsing every value into `estimated`.
  Rewards remains the detailed source for the observed-rate range, sample window, assumptions, and
  omission reason. When reviewed manager fee semantics and anchored inputs are available,
  `operatorFeeSats` exposes the exact per-staker/per-bucket forecast point; otherwise
  `operatorFeeUnavailableReason` explains the omission. Exact accrued rewards, calculation state,
  and actionable-claim counts remain independently available.
- The stable shared chain anchor determines the next reward-calculation checkpoint, while its
  countdown uses the current local-node burn height displayed in the same cycle summary. This keeps
  protocol timing stable without introducing a normal one-block reference-indexer display skew.
- The legacy Overview UI and `/api/v1/status` remain intact. The next implementation slice is the
  route-specific dashboard loader and approved responsive UI, followed by removal of duplicated
  legacy alert/status surfaces after all direct actions are reachable.

## Acceptance contract

- An operator can immediately identify the manager/network/cycle, the next reward calculation and
  prepare-phase timing, whether the network is advancing, and whether the local node and signer are
  healthy and aligned without interpreting a global readiness label.
- Stable registration, grant, runtime-identity, capability, and eligibility facts stay in Signer
  Health/Settings unless a mismatch or due action requires attention.
- Every Overview attention item represents a current operator decision and opens its exact action,
  recovery, or evidence.
- Scheduled-but-not-due work does not enter Attention.
- One root cause does not create multiple symptom alerts.
- Existing Activity work is resumed, never duplicated.
- Local-node current state remains usable when an indexed/reference API is behind.
- Delayed action witnesses cannot authorize a money-moving operation.
- Normal pending work is visible without being called an error.
- One unavailable domain never traps the whole page on Loading.
- Overview contains no detailed roster, reward pipeline, terminal activity feed, raw health metrics,
  manager source audit, or first-time setup surface.
- The browser does not own attention classification, correlation, or ordering.

## Deferred decisions

These do not block implementing the Overview contract:

- Signer Health calibration thresholds, confidence, and finding retention remain the #19 design
  work. Overview consumes the resulting findings. Until a network/node classification is supported
  by that producer, the operational snapshot says `collecting` or `insufficient-evidence`; it does
  not infer `advancing`, `behind`, or network-wide health from raw tips.
  The initial display-only reference advancement fact uses a 90-second evidence window in Signer
  Health: a proved tip change inside that window may render `advancing`; absence of such proof renders
  `collecting` or `insufficient-evidence`, never an unhealthy-network finding. Alerting and
  network-wide attribution still require the #19 policy.
- Reward calculation grace periods and Assist escalation remain the reward/Assist policy work.

The reward policy is now fixed: the Rewards page shows a newly eligible calculation as normal
`awaiting calculation` state. Overview adds an action only after ten minutes and 24 newer canonical
Stacks blocks, provided the node is advancing and the reviewed wallet action has current witnesses.
A stalled chain or stale witness produces evidence-specific `needs-attention` instead. Unattended
Assist remains separately gated and cannot become eligible before 30 minutes and 120 blocks.
- External notification channels, paging thresholds, acknowledgements, and deduplication wait for
  durable finding episodes; they may consume this projection but do not change its semantics.
- Whether support export becomes a secondary direct action on urgent findings is decided with the
  Signer Health/support handoff design.
