# ADR 0011: Scheduled reward runs

- Status: Proposed for merge review
- Date: 2026-09-21
- Tracking: [#6](https://github.com/stx-labs/signer-sidekick/issues/6)

## Decision

An opt-in server scheduler replaces repeated Rewards button clicks. It shares the UI's next-action
selection and calls the existing asynchronous preparation and exact-recipe approval services.
[ADR 0010](0010-operator-run-execution-envelope.md)'s engine, authorization format, adapters, signing,
postconditions, exclusion, expiry and recovery remain unchanged.

Enabling binds consent to the network/chain ID, manager and gas wallet, including future eligible
stakers and subsequent distribution chunks. Existing fee settings apply; per-run caps are **not** an
aggregate spending budget. Admin changes, fee withdrawals and gas-wallet sweeps remain manual.

The schedule is off by default. SQLite stores settings, its own request/run linkage and initiation
provenance. A pass persists its request ID before preparation and never adopts another preparation
returned by deduplication. Restart follows the same request; overlapping passes coalesce. Idle
discovery reads one ledger page per check, advancing through retained history. Completion triggers
fresh discovery for the next step; an idle check defaults to every 15 minutes.

Before approval, the scheduler rechecks enablement and deployment identity. Disable cancels its
unapproved recipe once preparation finishes; approval already begun and approved execution may
continue. Force Observe retains its existing signature-boundary effect.

A halted, paused, expired or cancelled scheduled run latches scheduling off with its reason. The
scheduler never resumes it or starts a replacement. Re-enablement requires explicit review and cannot discard
a materialized/broadcast attempt or an unresolved halted/paused run. A changed deployment cannot
inherit a pending recipe's consent.
An expired or cancelled manual run with unresolved signed-attempt evidence also blocks automatic
starts, even if its engine lease has been released. Missing evidence fails closed; only terminal
attempt evidence clears this guard. The scheduler does not change engine reconciliation.

## Interfaces and persistence

`GET /api/v1/rewards/schedule` returns status without live chain reads. `PUT` uses the existing
operator authentication and CSRF guard; its body is `{ enabled, intervalMinutes, revision }`.
The revision must match the current status. The strict contract lives in
`packages/api-contracts/src/reward-schedule.ts`, not deployment environment variables.

Schema 44 adds `reward_schedule` (singleton settings, identity and progress) and
`reward_schedule_requests` (initiation provenance). Existing run/child/attempt tables remain the
execution record. The scheduler starts with operational workers and drains before the engine on
shutdown; it never creates another signer or transaction queue.

## Review and rollout

This adds automatic approval authority, not a second execution path. Review against the
[signing-path checklist](../../../security/operator-run-mainnet-review.md), including lifecycle,
consent and manual-run coexistence tests. Record executed scenarios, remaining gaps and explicit
mainnet approval in the shipping PR; CI success alone is not live workflow validation.
[Operations](../../operator/operations.md#automatic-reward-runs) owns enable/disable and recovery
procedures. Rollout evidence and remaining acceptance work are tracked in #6, not a second plan.
