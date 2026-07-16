# Build audit round 4 disposition — installed manager profiles

**Date:** July 16, 2026
**Audit:** `build-audit-2026-07-16-trusted-profiles.md`
**Branch:** `agent/v1-milestone-1`

The audit findings were validated against the implementation and resolved before commit. The
original audit remains unchanged as a point-in-time record.

| Finding | Disposition |
| --- | --- |
| T1 — cross-network approval inheritance | **Fixed.** Reference proof may use an artifact from the same pinned source lineage, which is necessary for private/testnet renders, but automation eligibility now requires a production-approved built-in for the installed profile's own network and matching provenance. An adversarial test proves that a crafted testnet profile referencing the approved Devnet artifact remains ineligible. |
| T2 — invalid JSON could leak file content | **Fixed.** Loader issues and startup logs use content-free parse/schema messages. Secret-shaped malformed and valid JSON probes prove profile bytes do not enter serialized issues or support bundles. |
| T3 — missing safety-negative coverage | **Fixed.** Tests now cover mainnet substitutions, custom-manager observe-only behavior, unavailable upstream source, built-in short circuit, missing/ambiguous principal inference, incorrect replacement counts, schema network constraints, CLI flag parsing, and the T1 exploit. |
| T4 — trust recorded only during snapshots | **Fixed.** Serve startup and synchronization now persist trust observations independently of dashboard traffic. Startup failure is retried by the next sync or snapshot. |
| T5 — ineligible tier downgrades not audited | **Fixed.** Recognition loss without an eligibility flip creates an immutable `degraded` transition. Tests cover restart-persistent gained, lost, and degraded events. |
| Permanent gained alert | **Fixed.** A successful gained transition is delivered once and retired; unresolved loss/degradation remains visible. |
| Trust-state read before transaction | **Fixed.** The previous state is read after `BEGIN IMMEDIATE`. |
| CLI parsing and observe-only source dependency | **Fixed.** Argument parsing is explicit and tested; `--observe-only` does not require the pinned upstream source. |
| Wrong-network ADR wording | **Fixed.** Internally inconsistent profiles warn, while valid profiles for another configured network remain inert. |
| Profiles included in Docker build context | **Fixed.** `.dockerignore` excludes `trusted-managers/*.json`. |
| Confusing `source.match` for failed proof | **Fixed.** Exact/canonical installed-source matches are reported only for recognized profiles. |
| Missing UI tier coverage | **Fixed.** Playwright exercises unrecognized, custom-observe, reference-render, and built-in states at desktop, tablet, and mobile sizes. |

## Accepted clarifications

- A custom-observe profile without a private `networkId` is still source-, principal-, and
  read-only-bound; requiring it is not necessary for V1 safety.
- The audit's unreachable-assertion note does not require a change: unknown compatible managers
  are attachable, so `manager verify` does not exit on that path.
- Devnet approval remains intentional so the released harness exercises the real eligibility gate.
  Mainnet, testnet, and regtest remain unapproved until a matching built-in is reviewed.

## Verification after remediation

- `pnpm check`, production build, protocol provenance, and offline Devnet lock verification pass.
- Coverage passes with 199 tests across 33 files: 78.98% statements, 72.07% branches, 82.51%
  functions, and 80.88% lines.
- Clarinet regtest passes all 10 Clarity lifecycle tests.
- Dashboard Playwright passes all 15 responsive browser tests.
- A clean released-image Devnet run `1784211206906-27381` passes the full acceptance suite. Its
  independent manager render transitions from `unrecognized` to `reference-render`, proves pinned
  provenance, becomes eligible only under the Devnet network-scoped approval, and the run removes
  its containers, processes, volume, and runtime credentials.

The local runtime was Node 26 while the repository pins Node 24.18.0; this produced an engine
warning only. CI remains the pinned-toolchain confirmation lane.

After re-review, the original migration 11 checksum was preserved and the `degraded` transition
constraint was added through forward-only migration 12. Persistent databases created by the
pre-remediation development build therefore upgrade without a reset.
