# Signer Health v2

Signer Health answers the operator question: **is my node and signer operating and signing
properly, and is a problem likely local, external-source-specific, or network-wide?** It combines
local Stacks node and signer evidence with on-chain operator context and bounded comparison sources.
It does not run the signer, control the host, or replace infrastructure observability.

The Overview consumes the same typed diagnosis and finding episodes. It does not reinterpret raw
tips or counters into separate health verdicts.

The reasoning, authority hierarchy, external-reference boundary, examples, and model-change process
are normative in the [Signer Health diagnosis model](signer-health-diagnosis-model.md). In
particular, Sidekick does not build a signer-cohort explorer or require the Hiro Signer Metrics API;
detailed signer-network exploration belongs in [Slotwatch](https://slotwatch.dev/).

## Evidence model

Sidekick polls cheap local node and signer endpoints every five seconds. Public/configured API
references are refreshed every 30 seconds and back off to at least 60 seconds after a rate-limit
response. Their original `checkedAt` time is retained between polls; reusing a reference sample
never counts as an additional failure or independent source. Browser pages read the server-owned
snapshot every 15 seconds while visible. Closing the browser does not stop collection.

| Source | Role | Authority |
| --- | --- | --- |
| Stacks node `/v2/info` and optional `/v3/health` | chain tip, canonical hash, network, sync, connected-peer height view | authoritative for local operating state; a release without `/v3/health` has limited peer evidence |
| Stacks node Prometheus | peers and node warning/error counters | local supporting evidence |
| Signer `/info`, `/heartbeat`, `/metrics` | identity, node view, cycle, proposals, validation, responses, latency, agreement | authoritative for what this signer and its node report through signer monitoring |
| Anchored operator snapshot | manager, registration, signer key/grant, current and next participation | node-proved operator context |
| Hiro reference API | independent public tip progression | comparison only |
| Configured indexed API | second comparison when it is a distinct origin | comparison only |

One delayed or unavailable API cannot classify a local node as unhealthy and cannot produce a
network-wide diagnosis. `suspected-network-wide` requires the local node to stop advancing and at
least two distinct comparison/peer signals to corroborate the same condition. A healthy advancing
local node instead classifies a lagging API as `source-disagreement`.

If signer monitoring is not configured, Sidekick reports stable `partial` coverage after the local
baseline is collected; it does not claim that the signer is healthy or create an availability
incident for a source the operator did not configure. A configured signer source that becomes
unavailable is subject to the sustained availability rules below.

## Classifications

Every active finding includes its first and last observation, sample count, evidence duration,
distinct-source count, confidence, and supporting/contradicting evidence.

- `likely-local-node` — sustained local RPC, peer-height, or local-tip evidence points at this node.
- `likely-local-signer` — signer reachability, identity, network/cycle, node-view, or participation
  telemetry points at this signer.
- `source-disagreement` — a comparison source disagrees with an advancing local node, or one local
  signer metric cannot safely attribute the cause.
- `suspected-network-wide` — the local tip and at least two distinct nonlocal/peer signals agree on
  a network stall.
- `insufficient-evidence` — coverage or baseline is not sufficient to attribute a condition.
- `healthy` — no active finding is supported.

The current thresholds are deliberately closed and operator-readable:

| Rule ID | Finding | Minimum evidence |
| --- | --- | --- |
| `node-rpc-unavailable` | Node RPC unavailable | 3 consecutive samples spanning at least 10 seconds |
| `signer-monitoring-unavailable` | Signer monitoring unavailable | 3 consecutive samples spanning at least 10 seconds |
| `signer-node-heartbeat-failed` | Signer cannot reach its node | 3 consecutive samples spanning at least 10 seconds |
| `signer-metrics-unavailable` | Signer metrics unavailable | 3 consecutive samples spanning at least 10 seconds; suppressed when all signer monitoring is unavailable |
| `node-behind-network` | Local node behind connected peers | gap of at least 3 Stacks blocks for 6 samples spanning at least 25 seconds |
| `node-tip-stalled-locally` | Local node tip stall | 90 seconds plus at least one advancing peer/API signal |
| `network-tip-stalled` | Suspected network stall | 180 seconds plus at least two distinct stalled peer/API signals |
| `local-canonical-tip-changed` | Possible local reorg | one consecutive successful-node height regression or same-height hash change; informational |
| `canonical-tip-disagreement` | Canonical hash disagreement | 3 independent reference checks spanning at least 60 seconds at the same Stacks height |
| `reference-api-behind-local-node` / `configured-api-behind-local-node` | Comparison API behind local node | at least 3 Stacks blocks for 90 seconds while the local node advances |
| `signer-identity-mismatch` / `signer-network-mismatch` / `signer-reward-cycle-mismatch` | Signer configuration mismatch | 3 samples spanning at least 10 seconds against node-proved context |
| `signer-node-view-behind` | Signer node view behind local node | at least 3 Stacks blocks across 3 signer-height updates spanning at least 2 minutes; 2 healthy updates resolve it |
| `signer-proposal-response-gap` | Proposal/response gap | at least 5 proposals and a conservative lower bound of 3 unaccounted-for responses in 15 minutes after a 30-second settling window |
| `expected-signer-silent` | Expected signer receives no proposals | signer is expected in the current set, metrics remain available, the proposal counter is static for 10 minutes, and the local node advances at least 12 times |
| `signer-rejection-rate-elevated` | Elevated rejection rate | at least 20 responses and 25% rejected in 15 minutes; cause remains unattributed |
| `signer-validation-latency-elevated` | Elevated node validation latency | at least 20 timed histogram observations and node-reported p95 above 5 seconds in 15 minutes |
| `signer-agreement-conflicts-elevated` | Agreement conflicts | at least 3 conflicts in 15 minutes; cause remains unattributed |

Signer counters are reset-safe. Histograms use the official Stacks signer bucket boundaries and
derive windowed p95 from cumulative-counter increases, re-baselining every bucket together on a
reset and interpolating within the crossing bucket (as Prometheus
[`histogram_quantile`](https://prometheus.io/docs/prometheus/latest/querying/functions/#histogram_quantile)
does) rather
than reporting the bucket's upper boundary. Incomplete or non-monotonic histogram intervals are
excluded rather than allowed to create a false latency finding. Missing release-specific metrics
reduce coverage rather than failing the entire signer source.

End-to-end response p95 remains visible as diagnostic telemetry and in support data, but it cannot
open or strengthen a health finding. Stacks Signer derives that measurement from the block header's
wall-clock timestamp, so Sidekick does not treat it as a reliable local alert boundary. The
validation-latency rule instead uses `validation_time_ms` reported by the local Stacks node for
successful validation responses.

## Durable history

The SQLite store keeps raw observations for 72 hours and five-minute rollups and resolved episodes
for 90 days. A finding
opens one episode; repeated samples update that episode and recovery resolves it without deleting
history. Missing evidence retains an active episode without increasing its occurrence count. A
Sidekick restart hydrates the recent diagnostic window, preserves active episode IDs, continues
counter baselines, and delays resolution during a 15-minute warm-up. Malformed historical rows are
skipped and counted rather than stopping monitoring. Changing the monitored configuration resolves
the old configuration's active episodes and starts a separate evidence stream.

The API returns up to 288 recent rollups and 50 recent episodes. Rollups contain source
availability, tip progression, proposal/response/rejection/conflict changes, response p95 for
diagnostics, and validation p95 for alert calibration.

## Operator and support surfaces

All operator health API routes require the existing operator credential:

- `GET /api/v1/health` returns the latest server-owned v2 snapshot and collects once if empty.
- `POST /api/v1/health/refresh` forces one bounded collection.
- `POST /api/v1/health/test-source` validates and tests a candidate source URL.

Process probes are separate from authenticated operator health data: `/health/live` reports process
liveness, `/health/ready` reports that Sidekick and its database can serve requests, and
`/health/operational` verifies the current node/manager connection, manager preflight, and the
availability of node-health evidence. It returns the current diagnostic status in its body, but a
warning such as slow validation does not make the probe fail; connection/preflight failure or an
`unavailable` health state does. A node outage must not make `/health/ready` fail because Sidekick
remains the diagnostic surface during that outage.

The five-second collector starts with the Sidekick control plane and remains server-owned even when
the manager connection is not yet operational or no browser is open. Manager readiness gates
money-moving operations, not node and signer diagnosis.

The existing Prometheus endpoint exports the one-hot diagnosis, active findings by classification,
retained observation count, latest sample time, per-source availability, and the rolling signer
response gap, rejection percentage, response p95, and validation p95 when those measurements are
available. Exporting a diagnostic metric does not make it an alerting rule.

Signer Health shows the primary diagnosis, evidence window, active findings, local node and signer
state, distinct comparison sources, current/next participation expectation, 15-minute signing
telemetry, and durable incident history. Advanced source details retain bounded error codes and
source timestamps.

The support bundle schema v2 includes this complete normalized health snapshot, its incidents and rollups,
the node-proved operator state, connection/observer/automation evidence, and a correlation window
for an optional `stacksup-or-operator-infrastructure-support-bundle`. The companion artifact should
cover host saturation, process/container lifecycle, service logs, disk/filesystem health, and host
networking for the same window. Sidekick deliberately does not collect unrestricted logs, control
the host, or include private keys. Bundle generation is read-only: it cannot collect a new health
sample, resolve an episode, or change incident history.

## Endpoint safety

Health endpoints are operator-configured but treated as untrusted input. HTTP(S) is required;
credentials, query strings, fragments, redirects, oversized responses, and cloud-metadata or
invalid address ranges are rejected. DNS is resolved for each request and the connection is pinned
to the checked address. Private, loopback, Docker, and tailnet addresses remain available for local
deployments under the same rebinding protections. A configured reverse-proxy base path is preserved
when Sidekick appends `/v2/info`, `/v3/health`, `/info`, `/heartbeat`, or `/metrics`.
