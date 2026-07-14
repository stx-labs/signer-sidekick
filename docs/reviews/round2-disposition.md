# Round 2 review disposition

This records the product-owner disposition of
[`round2-spec-review.md`](round2-spec-review.md). It prevents findings that were intentionally
rejected from being mistaken for omissions in later reviews.

| Finding | Disposition | Result |
|---|---|---|
| F1 global `pause-rewards` handling | Not adopted for v1 by product decision | The released contract does contain the one-way pause and `claim-rewards` returns `u53` while paused. This is intentionally excluded as an extreme protocol-governance edge case, not overlooked. |
| F2 fallback crank default | Adopted | The global fallback is separately gated and defaults off until the expected primary caller and grace policy are confirmed. |
| F3 attach recognition bounds | Adopted | Automation recognition is byte-exact, lexical whitespace/comment normalization only, or an allowlisted reviewed source hash. General semantic-equivalence matching is prohibited. |
| F4 PoX-4 migration tracker | Rejected by product decision | A migration tracker adds scope beyond the operator setup and PoX-5 lifecycle product. The operator guide may explain the transition, but the application will not compare PoX-4 and PoX-5 rosters. |
| F5 payout-preference loss alert | Adopted | V1 alerts when a stored payout preference disappears or changes after stake lifecycle ingestion. |
| F6 solo-signer persona | Adopted | The plan now states that solo signers enroll through official interfaces and use Sidekick for manager setup and operation. |
