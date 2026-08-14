# Activity and action workspace contract

- Status: Approved product contract
- Date: 2026-08-14
- Parent: [Signer Sidekick scope reset](scope-reset-plan-2026-08-13.md)
- Related: [Recurring operation contracts](recurring-operation-contracts-2026-08-13.md)

## Purpose

Activity is the durable operator journal for one Sidekick deployment. It answers:

> What happened, what is still happening, what needs my intervention, and did the expected
> on-chain result become canonical and reconciled?

The action workspace is the common place to inspect and execute one recurring operation. Overview,
Pool, Rewards, Signer Health, Settings, and Activity may all link directly to it. Operators must not
visit an intermediate Manager or Operations page before they can act.

This contract replaces the current split between the Operations page, Manager action forms,
Rewards action forms, transaction-engine job UI, and the claims/withdrawals-only activity response.
It does not replace the underlying wallet-intent or transaction-engine state machines.

## Research constraints

Stacks transactions have distinct construction, signing, broadcast, mempool, execution, canonical
inclusion, and finality phases. Inclusion is not execution success: a transaction can be included
and abort by response or post-condition. Sidekick also requires its expected post-state to be
reconciled before calling an operation complete.

The operator UI therefore must not collapse `submitted`, `mempool`, `included`, `executed`,
`finalized`, and `post-state verified` into one “confirmed” status. It must present a small stable
status vocabulary while retaining the detailed evidence timeline underneath it.

Useful presentation rules from established design systems also apply:

- use the smallest status vocabulary that lets the operator distinguish action from progress and
  completion;
- show errors and recovery actions at the point where the operator can resolve them, not only as a
  colored status in a list; and
- ensure every timeline item communicates its meaning in text without relying on the connecting
  line, indentation, icon, or color.

References:

- [Stacks transaction lifecycle](https://docs.stacks.co/learn/transactions/how-transactions-work)
- [Stacks post-conditions](https://docs.stacks.co/post-conditions/overview)
- [Stacks Bitcoin finality](https://docs.stacks.co/learn/block-production/bitcoin-finality)
- [Primer timeline](https://primer.style/product/components/timeline/)
- [GOV.UK task status guidance](https://design-system.service.gov.uk/patterns/complete-multiple-tasks/)

## Frozen navigation and routes

The navigation is frozen at:

1. Overview
2. Pool
3. Rewards
4. Activity
5. Signer Health
6. Settings

Manager and Operations are removed rather than retained as aliases. The installed population is
small enough that old dashboard URLs do not require compatibility redirects. An unknown or removed
hash routes to Overview without interpreting old query parameters. Remove the current special
handling for `#registration`, `#setup`, and `#enrollment` in the same change; there is one routing
rule for every deleted surface, not separate compatibility eras.

Stable product routes:

| Route | Purpose |
| --- | --- |
| `#overview` | Current attention and concise domain summaries |
| `#pool` | Pool positions and future changes |
| `#rewards` | Reward state, outlook, claims, fees, and withdrawals |
| `#activity` | Active work and durable history |
| `#activity/<activity-id>` | Evidence and timeline for one durable activity group |
| `#health` | Signer, node, and network diagnosis |
| `#settings` | Attachment, sources, capabilities, observer, auth, and support |
| `#action/<operation-code>` | Start or resume one contextual recurring operation |

`#action/*` is a workspace route, not a seventh navigation item. When an action creates or resumes
a durable operation, its canonical detail route becomes `#activity/<activity-id>`. Browser Back
returns to the originating domain page and restores that page's in-memory filters and scroll
position.

## What belongs in Activity

Activity contains durable, operator-relevant facts:

- recurring operation plans, wallet intents, engine jobs, attempts, and reconciled outcomes;
- canonical manager and PoX-5 activity relevant to the attached manager or its pool;
- claims, withdrawals, fee/admin changes, signer registration/key rotation, and reward
  calculations;
- reorg or reconciliation corrections to facts Sidekick previously presented;
- operator configuration or safety-control changes that affect authority or behavior; and
- later, durable signer-health finding transitions once the health evidence contract is defined.

Activity does not contain:

- raw or merely `observer-claimed` callbacks;
- polling, sync-loop, retry, or API-request logs;
- every node or signer health sample;
- transient loading and rate-limit messages;
- authentication access logs; or
- unverified callback event bytes.

Only evidence that has crossed its domain's normal authority boundary may enter Activity. A custom
manager print can appear as generic verified contract activity, but it must not receive reference-
manager semantics without a reviewed event adapter.

## Page structure

Activity has two sections.

### Active work

Show nonterminal work that is actionable, progressing, or unresolved:

- action required;
- in progress; and
- needs attention.

The total sort order is `needs-attention`, then `action-required`, then `in-progress`. Within one
status, overdue structured deadlines sort before future deadlines and no-deadline items sort after
both deadline groups, followed by the earliest
normalized `urgencyAt` with `null` last, `updatedAt` newest first, and `activityId` ascending as the
deterministic tie-breaker. `urgencyAt` is only a sorting normalization; the operator and every action
preflight use the exact burn-block, reward-cycle, or time `deadline`. Do not sort an ambiguous
money-moving operation below routine new activity. Active work is not duplicated in History. Once
an item reaches a terminal resolved state, it moves into History.

If there is no active work, omit the section rather than render a large empty card.

### History

Show terminal operations and verified observations in reverse meaningful-time order, grouped under
Today, Yesterday, or an absolute local date. The group heading is textual; visual timeline breaks
are decorative only.

The page is a list/timeline, never a wide data table. Each row shows:

- operator-facing title;
- one-line outcome or evidence summary;
- compact status text;
- domain and operation/event type;
- relevant principal, amount, cycle, or transaction identifier;
- last meaningful timestamp; and
- a direct Details or Resume action when applicable.

## Operator-facing status vocabulary

The Activity projection owns the mapping from internal states. Dashboard code must not infer these
statuses independently from wallet-intent or engine-job fields.

| Display status | Meaning | Presentation |
| --- | --- | --- |
| `action-required` | The operator can safely perform a specific next action now | Attention tag and direct action |
| `in-progress` | Work is proceeding or being observed; no operator input is presently needed | Neutral progress text |
| `needs-attention` | Sidekick cannot safely resolve the outcome or requires a decision/recovery action | Warning/error tag and direct recovery |
| `complete` | The terminal expected result is canonical and reconciled | Plain success text, not a dominant badge |
| `superseded` | A newer operation intentionally replaced this one | Muted terminal text and replacement link |
| `observed` | A verified chain/configuration fact with no operation lifecycle | Plain neutral text |

An additional structured `outcome` explains the result without expanding the primary status set:

`pending`, `succeeded`, `failed`, `aborted`, `ambiguous`, `superseded`, or `observed`.

The valid combinations are closed:

| Display status | Allowed outcomes |
| --- | --- |
| `action-required` | `pending` |
| `in-progress` | `pending` |
| `needs-attention` | `pending`, `failed`, `aborted`, `ambiguous` |
| `complete` | `succeeded` |
| `superseded` | `superseded` |
| `observed` | `observed` |

The API schema rejects every other combination. Whether an item requires attention is derived from
`displayStatus`; the contract does not carry a second boolean that can disagree with it.

The initial mappings are:

| Source states | Display status |
| --- | --- |
| Wallet intent `prepared` | `action-required` |
| Wallet intent `submitted`, `mempool`, `confirmed`, or routine `reobserve` | `in-progress` |
| Wallet intent `complete` | `complete` |
| Wallet intent `failed` | `needs-attention` |
| Wallet intent `expired` | `superseded` |
| Wallet intent `superseded` | `superseded` |
| Engine job `prepared`, `preflighted`, or `awaiting_approval` | `action-required` |
| Engine job `nonce_reserved`, `broadcast`, or `confirmed` | `in-progress` |
| Engine job `noncanonical_reobserve` | `in-progress` for a five-minute recovery window from the state transition; `needs-attention` when that deadline expires |
| Engine job `ambiguous` or unresolved `blocked` | `needs-attention` |
| Engine job `reconciled` | `complete` |
| Engine job `superseded` | `superseded` |

An expired intent is always a terminal historical fact. Whether the underlying operation is
currently due is evaluated by the ordinary current readiness projection, which may emit a separate
`action-required` contextual notice. It never rewrites the expired Activity group or causes the
Activity read model to perform a live node read.

## Activity groups and correlation

One operator operation is one Activity group, not a row for every state transition.

Correlation order:

1. A wallet intent or engine job and every transaction/event/post-state observation bound to it
   form one `operation` group.
2. Verified contract events not bound to an operation are grouped by canonical transaction ID.
   Multiple event indexes from one transaction appear in one `chain-event` group.
3. One runtime settings revision or safety-control change forms one `configuration-change` group.
4. A later health finding uses one group per finding episode, from opened through resolved.

If a transaction first appears as generic chain activity and is later proven to belong to an
operation, the operation group absorbs it. It must not remain as a duplicate feed row.

An absorbed activity ID remains a durable alias. A detail request for its former
`chain-tx:<chain-id>:<txid>` ID resolves to the absorbing operation group and returns that group's
canonical `activityId`. The dashboard replaces the hash with the canonical detail route without
adding browser history. Aliasing is resolved deterministically from the transaction correlation in
the authority records; it does not require a duplicate feed item or a mutable redirect table.

A reorg updates the existing group and appends a correction to its timeline. It must not preserve a
green terminal summary while creating an unrelated warning elsewhere. A replacement operation
links both directions through `supersedesActivityId` / `supersededByActivityId`.

## Activity kinds and domains

Initial kinds:

- `operation`
- `chain-event`
- `configuration-change`
- `finding-change` (reserved until the Signer Health contract lands)

Domains:

- `manager`
- `pool`
- `rewards`
- `node`
- `signer`
- `network`
- `sidekick`

An item has one primary domain for filtering and may contain related-domain labels. Domain does not
determine authority or action availability.

## Filtering, search, and pagination

Keep the default useful without configuration:

- status: All, Action required, Needs attention, In progress, Resolved;
- type: All, Actions, Chain events, Configuration;
- domain: All, Manager, Pool, Rewards, Node, Signer, Network, Sidekick; and
- time: 24 hours, 7 days, 30 days, All.

The Resolved filter includes `complete`, `superseded`, and `observed`; it is a filter label, not a
seventh display status.

Search is server-side and matches exact or prefix forms of transaction IDs, principals, activity
IDs, wallet-intent IDs, and engine-job IDs. It does not search raw callback JSON.

History uses opaque cursor pagination ordered by meaningful timestamp and stable activity ID. The
cursor is bound to a hash of the active filters so it cannot be reused with a different query.
Active work is returned separately and is not paginated with terminal history.

The first read-model implementation always loads all active wallet-intent and engine authority
records, while terminal source histories are bounded to the newest 10,000 records per authority.
Crossing a terminal window marks that source's coverage `delayed`; it must never return a 503 or
silently imply that active work is absent. Complete cursor reachability beyond that window requires
source-aware repository pagination or a rebuildable materialized projection and remains a gate
before claiming unbounded production history.

Filters are encoded in the `#activity` query string so the page can be bookmarked. Detail routes
return to the preserved filter state.

## Activity detail timeline

The detail route presents the complete durable evidence for one group. The summary header contains:

- title, status, and outcome;
- action authority (`external-wallet`, `permissionless-fee-payer`, `observe`, or later `assist`);
- actor/sender when known;
- manager/network binding;
- transaction ID and canonical anchor when known;
- source coverage and last observation time; and
- the one safe next action, if any.

The timeline uses stable event codes rendered into operator language. Initial operation events:

- plan created;
- readiness/preflight passed or blocked;
- wallet signature requested;
- transaction ID reported;
- transaction observed in mempool;
- transaction included in a canonical block;
- contract execution succeeded or aborted;
- inclusion finalized under the configured finality policy;
- expected post-state verified;
- observation became unavailable;
- inclusion became noncanonical;
- operation superseded/replaced; and
- manual intervention required.

Every timeline entry states its source and timestamp. Canonical entries include Stacks height and
index-block hash. Details may expose reviewed call arguments, post-conditions, expected effects,
adapter identity, facts/manifest hashes, and redacted audit evidence. They never expose private
keys, signed transaction bytes supplied by the browser, API-key values, or raw callback bodies.

## Shared action workspace

The workspace is one responsive page used by every recurring operation. It is not a setup wizard
and has no generic Continue button or step-completion persistence.

### Entry

A contextual notice or domain action links directly to `#action/<operation-code>`. Opening that route
is read-only: it loads availability and current facts but does not create an intent or reserve a
nonce.

If the same operation scope already has active work, the route resumes that activity instead of
creating a duplicate. The operator is taken to its current stage and the URL changes to the stable
activity-detail route once a durable activity ID exists.

### Layout

Render these sections on one page, progressively as facts become available:

1. **Why this action** — the triggering condition, urgency, and current availability.
2. **Inputs** — only operator-supplied values not already proven from current state.
3. **Transaction review** — actor, network, contract/function, arguments, recipient/amount,
   maximum asset effects, post-conditions, fee bounds, anchor/age, expiry, expected post-state, and
   reviewed capability adapter.
4. **Execute** — the exact signing authority and one primary action.
5. **Progress and evidence** — the same durable timeline used by Activity detail.

On narrow screens these sections stack in that order. On wide screens the review may use a main
column and a sticky status/evidence rail, but all content and actions remain available in the linear
reading order.

### Action flow

1. Sidekick loads current per-action readiness and explains any missing evidence or unsupported
   capability.
2. The operator supplies required public inputs and selects **Review transaction**.
3. Sidekick performs anchored preflight and creates an expiring sealed intent. No wallet opens
   before the review is returned.
4. The operator verifies the exact review and selects **Open wallet**.
5. The wallet signs/submits. Sidekick accepts only the returned transaction ID, never wallet keys or
   arbitrary signed bytes.
6. Sidekick independently fetches and verifies the transaction against the sealed plan, observes
   canonical execution/finality, and reconciles expected post-state.
7. The workspace remains useful if the browser closes; returning resumes the durable activity.

Wallet cancellation leaves the sealed intent available until it expires and offers **Open wallet**
again. Expiry offers **Review a new transaction** and creates a replacement only after fresh
preflight. Ambiguity never offers blind resubmission; the primary action is **Review evidence** or
**Retry observation** until Sidekick can safely offer a replacement.

### Primary-action language

Use specific verbs:

- Review transaction
- Open wallet
- Retry observation
- Review evidence
- Create replacement
- Return to Rewards / Pool / Settings

Do not use Continue, Fix, Retry, or Confirm without naming what the action does.

## Contextual notices and direct actions

Every actionable finding or notice carries a typed primary action from the backend. The dashboard
must not parse prose to choose a destination.

Supported action targets:

- launch or resume an operation workspace;
- open a specific Activity group;
- open an exact Settings section;
- run a bounded read-only recheck; or
- open a named domain section.

The API returns a discriminated action, not an arbitrary URL:

```ts
type DomainTarget =
  | {
      page: "overview";
      section: "attention" | "cycle" | "pool" | "rewards" | "health" | null;
    }
  | { page: "pool"; section: "positions" | "forecast" | "roster" | null }
  | {
      page: "rewards";
      section: "outlook" | "calculation" | "claims" | "fees" | "withdrawals" | "history" | null;
    }
  | { page: "activity"; section: "active" | "history" | null }
  | {
      page: "health";
      section: "findings" | "node" | "signer" | "network" | "sources" | null;
    };

type OperatorOperationCode = RecurringWalletIntentAction | "calculate-rewards";

type ContextualAction =
  | {
      kind: "launch-operation";
      operation: OperatorOperationCode;
      context:
        | { kind: "none" }
        | { kind: "engine-job"; jobId: string }
        | {
            kind: "staker-reward";
            stakerPrincipal: string;
            rewardCycle: string;
            bondIndex: string | null;
          };
      label: string;
    }
  | { kind: "resume-activity"; activityId: string; label: string }
  | {
      kind: "open-settings";
      section: "attachment" | "sources" | "capabilities" | "observer" | "auth" | "support";
      label: string;
    }
  | {
      kind: "recheck";
      target: "connection" | "node" | "api" | "signer" | "activity";
      label: string;
    }
  | ({ kind: "open-domain"; label: string } & DomainTarget);
```

The dashboard constructs a route only from this closed set. Labels remain server-supplied so a
finding can name the exact action, but the backend cannot inject a navigation URL.
Launch context is a convenience hint for opening the correct job or reward bucket, never authority;
the action workspace reloads and verifies every value before preparing an intent. The closed
context union defines the only query parameters the route builder may serialize.

`open-settings` is the only route to a Settings subsection, so Settings does not have a second
stringly target through `open-domain`. `OperatorOperationCode` excludes `deploy-manager` at compile
time and reserves `calculate-rewards` for the reviewed reward-calculation adapter.
`register-self` deliberately remains a recurring day-2 signer-key repair/rotation operation. It is
available only when Sidekick can prove established expected participation through current/next
signer-set membership or a prior valid registration/finding episode, or when an explicit reviewed
key-rotation flow supplies equivalent evidence. A merely deployed manager, configured signer URL,
or absent registration is not enough. Without that evidence, Sidekick links to external first-time
setup or capability evidence and does not prepare `register-self`. The runtime API schema must reject
`deploy-manager` and every unknown or removed setup-only operation code so deleted setup actions
cannot be revived by stored data or a malformed response.

Notices have one primary action and at most one secondary Details link. If an operation cannot be
prepared because its capability is unsupported, the notice links directly to the manager
capability evidence in Settings rather than showing a dead action button. If evidence is stale, the
workspace explains and rechecks the exact required source; it does not send the operator to a
generic status page.

## Data coverage and freshness

Activity has independent coverage for:

- local transaction observation;
- indexed manager history;
- observer delivery/verification; and
- durable Sidekick operation/audit records.

The page always renders durable local records. A delayed indexed API marks only indexed history as
delayed and retains its last verified anchor. It does not replace the page with Loading or imply
that local transaction evidence is stale.

Each Activity group carries the authority, anchor, and observation age of the facts it summarizes.
The action workspace separately evaluates the evidence required by that exact operation; an old
history row does not block a fresh node-backed action, and a fresh dashboard snapshot does not
authorize an action whose own witnesses are stale.

In deployment-identity safe mode, Activity and its details remain read-only. All action controls are
disabled with the stored/configured identity evidence and direct links to the exact Settings and
support-export sections.

## API projection

Activity is a server-owned projection over wallet intents, transaction-engine jobs/attempts,
verified manager events, claims/withdrawals, runtime-setting audit, and later finding episodes. The
frontend must not merge and sort those repositories itself.

The first implementation is a deterministic read model over those existing durable repositories,
not a second write-side activity log. Activity IDs are derived from their authority records:

- `wallet-intent:<intent-id>`;
- `engine-job:<job-id>`;
- `chain-tx:<chain-id>:<txid>`;
- `settings:<revision>`; and
- later, `finding:<finding-id>:<episode-id>`.

The projection suppresses a `chain-tx` group when that transaction is already correlated with a
wallet intent or engine job and adds its verified events to the operation detail instead. This
keeps the underlying repositories authoritative and makes replay/reorg corrections visible without
maintaining another mutable copy. A materialized cache may be added later only if measured query
cost requires it; it must be versioned and fully rebuildable from the authority records.

Proposed summary contract:

```ts
type ActivityDisplayStatus =
  | "action-required"
  | "in-progress"
  | "needs-attention"
  | "complete"
  | "superseded"
  | "observed";

type ActivityOutcome =
  | "pending"
  | "succeeded"
  | "failed"
  | "aborted"
  | "ambiguous"
  | "superseded"
  | "observed";

interface ActivityGroupSummary {
  schemaVersion: 1;
  activityId: string;
  kind: "operation" | "chain-event" | "configuration-change" | "finding-change";
  domain: "manager" | "pool" | "rewards" | "node" | "signer" | "network" | "sidekick";
  code: string;
  title: string;
  summary: string;
  displayStatus: ActivityDisplayStatus;
  outcome: ActivityOutcome;
  occurredAt: string;
  updatedAt: string;
  deadline: OperatorDeadline | null;
  urgencyAt: string | null;
  actorPrincipal: string | null;
  txids: string[];
  anchor: ChainAnchor | null;
  supersedesActivityId: string | null;
  supersededByActivityId: string | null;
  primaryAction: ContextualAction | null;
  coverage: DomainCoverage[];
}

interface ActivityPage {
  schemaVersion: 1;
  generatedAt: string;
  active: ActivityGroupSummary[];
  items: ActivityGroupSummary[];
  nextCursor: string | null;
  coverage: DomainCoverage[];
}

interface ActivityDetail {
  schemaVersion: 1;
  requestedActivityId: string;
  canonicalActivityId: string;
  aliases: string[];
  summary: ActivityGroupSummary;
  timeline: ActivityTimelineEntry[];
}
```

`GET /api/v1/activity` changes in place to this versioned response; no parallel legacy endpoint is
added. All in-repository clients change atomically. `GET /api/v1/activity/<activity-id>` returns the
detail contract above plus its ordered typed timeline and complete redacted evidence. When the
requested ID has been absorbed, `requestedActivityId` preserves what the caller used,
`canonicalActivityId` and `summary.activityId` identify the absorbing group, and `aliases` contains
every derived ID that resolves to that group.

The action route may continue using the existing operation-specific preparation/submission APIs.
The Activity projection supplies stable correlation IDs so those APIs do not become a second feed
contract.

## Current-code implementation map

| Current area | Treatment |
| --- | --- |
| `packages/api-contracts/src/v1.ts` claims/withdrawals-only `activityResponseSchema` | Replace with the versioned group/page/detail and contextual-action contracts |
| `packages/api-contracts/src/engine.ts` job/attempt/reconciliation contracts | Preserve as authority evidence behind the projection; do not expose raw states as page status |
| `apps/sidekick/src/wallet-intent-service.ts` | Preserve its sealed intent and verification lifecycle; project it into one operation group |
| `apps/sidekick/src/transaction-engine/` repository and runtime | Preserve job authority and cursor logic; reuse its summaries/details when building operation groups |
| `apps/sidekick/src/server.ts` `/api/v1/activity` | Replace the narrow response and add the activity-detail route |
| `apps/dashboard/src/features/operations/engine-api.ts` | Reuse the API helpers behind Activity/action data loaders |
| `engine-job-review.tsx`, `browser-wallet-action.tsx`, recovery helpers | Extract into shared action-workspace sections rather than rewrite their safety-sensitive behavior |
| `operations-page.tsx` | Replace with Activity and delete after its status/evidence is reachable there |
| `manager-page.tsx` | Move attachment/capability evidence to Settings and action forms to the shared workspace, then delete |
| `rewards-page.tsx` action forms | Replace local forms with contextual launch/resume links; keep domain data and explanations on Rewards |
| `dashboard-route.ts` and `main.tsx` | Adopt the frozen six-page routes plus non-navigation action/activity-detail routes; remove legacy parsing |

## Responsive and accessibility contract

- Use list/timeline rows, not a desktop table with horizontal scrolling.
- Status is always text; color and icons are supplemental.
- Each timeline entry remains meaningful when read without its visual connector.
- Principals and transaction IDs truncate visually but retain copy and accessible full-value
  controls.
- Keyboard focus moves to the action heading after route changes and to the inline error summary
  after an unsuccessful submission.
- Errors appear beside the failed input/action with the safe recovery button; they are not conveyed
  only by the Activity status tag.
- Browser Back returns to the prior feed/domain position without losing filters during the session.

## Empty, degraded, and failure states

| State | Presentation |
| --- | --- |
| No activity yet | “No operator or verified chain activity has been recorded yet.” Include coverage, not a decorative empty dashboard. |
| Active work empty | Omit Active work; show History directly. |
| History source delayed | Show durable local history plus the indexed source's last verified anchor and age. |
| One item cannot load | Keep the feed and show an inline retry on that detail route. |
| Action unsupported | Explain the missing reviewed capability and link to its Settings evidence. |
| Action evidence stale | Name the exact witness and offer its bounded recheck. |
| Transaction ambiguous | Preserve the transaction/nonce evidence and prohibit blind replacement. |
| Reorg/noncanonical | Mark the existing group as rechecking; append correction evidence. |
| Identity safe mode | Read-only Activity remains available; action controls are disabled. |

## Implementation sequence

1. Add versioned Activity group/detail contracts, contextual-action contracts, and fixture builders.
2. Implement the server-owned projection and correlation rules over existing repositories.
3. Build Activity active/history/detail UI and the new routes.
4. Build the shared action workspace and migrate Rewards and Manager action forms into it.
5. Move manager attachment/capability/provenance and advanced administration into Settings.
6. Add typed contextual actions to findings/notices and link them directly to workspaces/details.
7. Remove Manager and Operations navigation, routes, pages, old route parsing, and obsolete
   page-specific projection code.
8. Update browser, API-contract, accessibility, responsive, Devnet action, and support-snapshot
   tests.

Do not remove Manager or Operations before their actions and history are reachable through the new
surfaces in the same change series. No compatibility redirects are required once they are removed.

## Implementation checkpoint (2026-08-14)

- The strict Activity group/detail, filter, cursor, source-coverage, deadline, and contextual-action
  contracts and the read-only server projection are implemented. Wallet-intent and engine states
  have exhaustive mappings, and Overview consumes this projection instead of interpreting engine
  state again.
- Active wallet and engine authority is loaded independently and remains complete. Terminal source
  windows exceeding 10,000 records report delayed history coverage instead of failing the page;
  source-aware cursor reachability beyond that window remains a release-claim gate.
- Expired wallet intents link to their replacements, absorbed chain-transaction aliases resolve to
  the canonical operation, and noncanonical engine work escalates after a stable five-minute
  recovery deadline. Cached chain context supplies structured deadline ordering without a live read.
- The Activity active/history/detail UI and its bookmarkable filter/detail routes are implemented,
  including independent source coverage, retained evidence on refresh failure, and 15-second
  visible-browser refreshes. The shared contextual action route now hosts manager actions, exact
  staker settlements, and exact transaction-engine claim jobs; active wallet intents resume from
  Activity without creating duplicates. First-time registration is denied in both the workspace and
  the server authority path, while established signer repair and rotation remain available.
- The six-page navigation cutover is implemented. Manager attachment, capability, signer-grant,
  admin, observer, and transaction-policy controls now live in Settings; engine and wallet history
  lives in Activity; all retained operations use contextual action routes. Manager, Operations,
  setup, enrollment, and registration hashes now resolve through the normal unknown-route rule to
  Overview without compatibility parsing.
- Permissionless PoX-5 reward calculation is implemented through a reviewed protocol adapter. It
  reads the complete bounded active-bond set at one node anchor, applies the contract's canonical
  ordering, seals the exact PoX-5 source/profile and checkpoint binding, revalidates before wallet
  signing, verifies the canonical post-state, and records a losing permissionless race as
  superseded rather than failed. Real vendored-contract execution vectors cover both STX-only and
  mixed STX/bond reward distributions.
- The released-binary Devnet action gate is met. The acceptance harness injects a controlled
  Leather-compatible provider into the real dashboard, reviews and signs Sidekick's exact
  `update-fees` intent with the public Devnet fixture account, returns only the transaction ID,
  and requires Sidekick to independently reconcile the Activity group to `complete`. The
  2026-08-14 clean-chain run passed in 7.62 seconds for the wallet-action phase; the surrounding
  observer, restart/recovery, external smoke, installed-profile, and failure-injection scenarios
  passed in the same released-binary run.

## Required contract tests

- The dashboard boundary schema rejects the old claims/withdrawals-only `/api/v1/activity` shape,
  missing or unknown `schemaVersion` values, unknown action variants, `deploy-manager`, other
  setup-only operation codes, and unknown page-section combinations.
- Wallet-intent and engine-job mappings are exhaustive functions ending in `assertNever`. Their
  tests enumerate the authoritative runtime state tuples and assert the exact display status for
  every state. Adding a state without a mapping must fail compilation or the mapping test.
- Status/outcome tests reject every combination outside the closed compatibility table, and filter
  tests prove Action required and every resolved status remain reachable.
- Active-work ordering tests pin the full order: `needs-attention`, `action-required`, then
  `in-progress`; overdue structured deadlines before future deadlines and no-deadline items last;
  earlier normalized
  `urgencyAt`; newer `updatedAt`; and finally ascending `activityId`.
- Correlation tests prove that an absorbed `chain-tx` ID resolves to the canonical operation detail,
  reports both IDs, and produces no duplicate feed row.
- Route tests prove that `#setup`, `#enrollment`, `#registration`, `#manager`, `#operations`, and
  unknown hashes land on Overview without interpreting legacy query parameters.
- The Devnet action acceptance leg opens a contextual `#action/<operation-code>` route in the real
  dashboard, creates a real Sidekick wallet intent, reviews and submits its exact transaction
  through a controlled Devnet browser-wallet provider, and returns only the transaction ID to
  Sidekick. Sidekick must independently fetch and verify the transaction, observe canonical
  execution, and reconcile the Activity group to `complete`. The harness must not add a production
  bypass or test-only trust path.

## Acceptance contract

- Navigation contains exactly the six frozen pages.
- Every currently retained operation is launchable from its contextual domain and uses the shared
  workspace.
- A notice with a safe action opens that action directly; it never sends the operator through a
  generic Manager or Operations page.
- Internal wallet-intent and engine states are mapped by the backend into the stable Activity
  vocabulary.
- Submitted, mempool, canonical inclusion, execution status, finality, and reconciled post-state
  remain separately inspectable.
- Related plans, transactions, events, and post-state evidence appear once in one Activity group.
- An absorbed Activity ID remains a working link and resolves to its canonical operation group.
- Reorg and supersession update/link the existing groups without leaving false-success duplicates.
- Raw observer claims and unverified callback event bytes never enter Activity.
- Delayed indexed history does not hide local durable operation evidence.
- Active ambiguity cannot be bypassed by blindly creating a replacement.
- Activity and action workspaces are usable without horizontal scrolling on narrow screens and
  expose equivalent keyboard/screen-reader meaning.
- Closing the browser does not stop operation observation or state transitions.
- The released-binary Devnet connect/observe/action leg exercises the shared action workspace and
  reaches a reconciled `complete` Activity group.

The reward-outlook path now includes the contract-proven simulator, a persisted single-anchor
`if-calculated-now` pool estimate, and a sample-gated checkpoint run-rate range whose three bounds
all use that exact simulator. The next implementation work is realized calculation-event capture,
model-error calibration, calibrated confidence, and projected fees, followed by calibrated
signer/network diagnosis and support handoff. The shared action workspace and released-binary
action gate no longer block that work.
