# Build audit round 3 disposition — released Devnet harness

**Date:** July 15, 2026  
**Audit:** `build-audit-2026-07-15-devnet-harness.md`  
**Branch:** `agent/issue-3-devnet-harness`

The audit's major findings were valid and have been resolved before commit. The intentional
auto-mining and proxy-listener choices are retained with explicit documentation; real reorg and a
complete live reward-withdrawal ceremony remain disclosed Phase 6 stretch work.

| Finding | Disposition |
| --- | --- |
| D1 — secret scan did not gate CI | **Fixed.** Artifact collection failures now fail the harness. A credential match deletes the run artifact and browser evidence directories before the error propagates, so the unconditional CI upload step has nothing unsafe to upload. |
| D2 — live Playwright traces/videos could retain the auth token | **Fixed.** Trace, video, and screenshot retention are disabled for the credential-bearing live suite. JUnit and HTML remain, and all browser evidence is recursively scanned with logs/results before acceptance. |
| D3 — bootstrap failure leaked detached processes/resources | **Fixed.** The cleanup manifest is written before any spawn and after every PID is learned. The test wrapper recovers partial state, while interactive `up` cleans only resources created by its own failed invocation. |
| D4 — exact two-block lag assertion could race | **Fixed.** The scenario requires warning state and `burnBlockLag >= 2`. |
| D5 — Devnet approval metadata drift | **Fixed and recorded.** Devnet-only approval is intentional so the released harness exercises the real compatibility gate. The artifact was regenerated, and both provenance verifiers now require profile/metadata approval, hashes, upstream provenance, and replacement counts to agree. Mainnet and regtest remain unapproved. |
| D6 — automatic mining differs from the original explicit-driver proposal | **Accepted design decision.** The pinned node/signer need the normal ten-second cadence through prepare phases; rapid manual blocks can produce a non-representative invalid anchor. Scenarios use adaptive state/indexer gates, and the limitation is documented. |
| D7 — stale crashed resources could collide with a new run | **Fixed.** Scoped orphan sweeps remove old harness containers, volumes, and networks before a clean start and during teardown. An already-running workbench is still protected from a second `up` or disposable test. |
| D8 — data proxies listen on all host interfaces | **Accepted with explicit boundary.** Docker Desktop and Linux host-gateway containers cannot portably reach host loopback. The control endpoint remains loopback-only; development docs require a trusted machine or firewalling ports 13999/21443. |
| D9 — secret list omitted configured mnemonics | **Fixed.** The scanner derives all mnemonics and signer keys from `Devnet.toml`, includes actor private keys and any configured API key, and detects any Sidekick Devnet bootstrap-token pattern rather than only the current token. |
| D10 — lock verifier omitted profile/metadata parity | **Fixed.** `devnet:verify` and `protocol:verify` now fail on metadata/profile drift in addition to source/image/tag drift. |

## Verification

- Deliberate bootstrap failure after proxy start exited nonzero and left no runtime state, detached
  proxy/resource process, harness container, volume, or network.
- Deliberately planted browser credential exited nonzero, identified the exact file, deleted the
  uploadable evidence directories, and completed cleanup.
- Final clean from-genesis acceptance run `1784165109845-71098` passed after the fixes, including
  Fresh Setup, real signer grant/registration, STX lifecycle, roster/event restart-resume, replay,
  cycle transition, live browser, container backup/restore, outages/rate-limit/lag, resource
  sampling, recursive evidence scan, and cleanup.
- `pnpm check`, coverage (169 tests), Clarinet regtest (10 tests), dashboard Playwright (9 tests),
  build, protocol provenance, and the Devnet lock verifier pass.

## Still open by design

- First execution of the scheduled/manual workflow on a GitHub Linux runner.
- CTO/core confirmation that the pinned 4.0.0 node and signer artifacts are the final launch set.
- Phase 6 real reorg validation and complete live reward-withdrawal lifecycle.
