# July 15 build-audit disposition

This records the product-owner and implementation disposition of the Phase 2/3 findings in
`build-audit-2026-07-15-phase2.md`. It does not rewrite the independent audit snapshot.

## Phase 3 findings

| Finding | Disposition |
|---|---|
| P3-1 unsafe URL schemes | Fixed at settings/enrollment ingestion and again at pool-card rendering. HTTP(S)-only hostile-scheme tests added. |
| P3-2 endpoint replacement | Fixed in code. Candidate node/API/key/header changes run the normal connected preflight before a revision is committed; failure preserves the prior revision. |
| P3-3 API key in SQLite | Accepted product decision and documented explicitly. UI replacement was a stated requirement. The API credential may be stored locally, making the database/backups secret-bearing; signer, manager-admin, and gas-payer keys remain forbidden. |
| P3-4 onboarding audit | Fixed with migration 9 and an append-only metadata-only onboarding audit. |
| P3-5 invalid persisted state | Fixed. Stored onboarding state is schema-validated and malformed state fails closed without breaking the summary route. |
| P3-6 destructive path selection | Fixed. Same-path start is a no-op; switching requires explicit reset confirmation in both API and UI. |
| P3-7 grant hash | Fixed. The live SIP-018 grant hash is visible with chain provenance before JSON verification. |
| P3-8 support classification | Fixed using actual email validation rather than `@` detection; regression-covered. |
| P3-9 static artifact | Fixed. Static mode now emits baked HTML plus versioned JSON; live mode emits HTML plus the same JSON snapshot. |
| P3-10 dashboard errors/auth | Fixed. Safe server error codes are displayed and any Phase 3 route 401 clears the browser credential and returns to login. |
| P3-11 OperatorService coverage | Fixed with alert, threshold-copy, force-snapshot serialization, and support-classification tests. |
| P3-12 provenance markers | Fixed for manager source, grant hash, reward cycle, pool size, and eligibility. |

The associated polish items were also addressed: numeric forecast editing no longer writes `NaN`,
settings navigation tracks selection, auto-poll no longer moves the operator's selected step, data
source status uses operator language, and environment-versus-persisted precedence is documented.

## Phase 2 and lifecycle carry-overs

| Finding | Disposition |
|---|---|
| P2-2 threshold copy | Fixed; alert text formats the observed contract threshold. |
| P2-3 unread responses | Fixed; rejected/retried bodies are cancelled before retry or throw. |
| P2-4 readiness latency | Fixed for probe behavior with a 20-second readiness deadline. Individual requests retain bounded retry policy. |
| P2-5 reorg projection | Fixed with a regression proving displaced claims disappear from canonical manager history. |
| P2-6 Retry-After parsing | Fixed; only decimal delta-seconds or IMF-style HTTP dates are accepted. |
| P2-7 lifecycle coverage | Fixed. Ten focused Clarinet tests now cover every contract path listed in v1-plan §15.2. |
| P2-8 print events | Fixed for representative stake, calculate-rewards, and claim-rewards payloads. |
| P2-9 duplicate PoX-5 instance | The explicit Epoch 4.0 deployment is required by Clarinet to execute the Clarity 6 boot override. The harness documents the constraint, names both principals, asserts their separation, and targets only the boot principal. Removing the deployment was tested and makes the harness fail before contract execution. |
| P2-10 stale ignored cache | Not a source/release finding. The ignored local cache is unnecessary and can be deleted by the operator without changing the repository. |
| M27 branch CI | Fixed; CI now runs on every branch push and pull request. |
| `/healthz` documentation | Fixed in README alongside `/health/live` and `/health/ready`. |
| Strict HTTP port parsing | Fixed; trailing garbage is rejected. |

The requested `ERR_REWARDS_PAUSED`/u53 note remains intentionally omitted. The product owner already
decided the special reward-pause edge case is outside V1 and should not influence claim behavior.
The Vitest 5 environment deprecation is upstream in `vitest-environment-clarinet` and remains a
dependency-upgrade watch item.

## Validation after remediation

- Formatting, lint, strict application TypeScript, and production builds pass.
- 30 protocol tests and 124 Sidekick tests pass.
- 10 real Clarity 6 lifecycle tests pass and cover every v1-plan §15.2 path.
- Browser QA confirms grant-hash provenance, separate static HTML/JSON controls, and a 390 px layout
  without horizontal overflow or console errors.
