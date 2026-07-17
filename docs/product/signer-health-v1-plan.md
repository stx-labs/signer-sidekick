# Signer Health V1

Status: implemented for testnet calibration

## Goal

Give a pool signer operator one quiet, useful page for the operational state of the Stacks node and
signer. This is local monitoring, not a replacement for a full observability stack.

Detailed findings appear only on **Signer Health**. The Overview shows compact node and signer
traffic lights that link to that page. V1 does not send notifications or add global badges.

## V1 scope

Sources:

| Source | Configuration | Used for |
| --- | --- | --- |
| Stacks node RPC | existing `STACKS_NODE_RPC_URL` | version, network, chain tips, reachability |
| Stacks node Prometheus | optional `STACKS_NODE_METRICS_URL` | peers and node counters |
| Signer monitoring server | optional `STACKS_SIGNER_MONITORING_URL` | `/info`, `/heartbeat`, `/metrics` |
| Hiro public API | network default or `HIRO_REFERENCE_API_URL` | independent public chaintip comparison |
| Configured Stacks API | existing `STACKS_API_URL` | recent burn-block timing for prepare-phase ETA |

Included:

- Local node and Hiro Stacks/Bitcoin tips, with signed differences.
- Node RPC response time, last observed tip advance, peers, and one-hour warning/error deltas.
- Signer identity, heartbeat, observed node height, reward cycle, STX balance, registration, grant,
  and current/next-cycle eligibility.
- One-hour signer proposal, response, rejection, latency, and agreement-conflict observations.
- Source coverage and advanced source status.
- A five-minute-cached 12/24-hour Bitcoin block-time sample for the Overview prepare-phase ETA.
- Settings fields with connection tests.
- A bounded two-hour in-memory sample ring. Restarting Sidekick starts a new baseline.

Not included:

- Host CPU, memory, disk, network, container, or process metrics.
- Logs, historical charts, durable health history, notifications, or automated remediation.
- Threshold-based findings for peer count, tip lag, rejection rate, response latency, or conflicts.
- Any signing or broadcast authority.

Host and deeper process health remain fast-follow work after V1 is calibrated.

## Behavior

Sidekick starts its HTTP control plane before the first health collection. It polls every 30 seconds
and retains two hours of observations in memory. A manual refresh uses the same bounded collector.

The page degrades by capability:

- Node RPC alone still renders core node health.
- Missing metrics show as `Not configured` or unavailable values; the rest of the page remains useful.
- Metrics absent from a newer or older upstream release do not make the source fail.
- A restart shows `Collecting baseline` until enough counter samples exist.
- Counter resets are treated as a new counter epoch instead of a negative event rate.

Only unambiguous, sustained reachability failures produce findings in V1:

- Node RPC unavailable for three consecutive checks.
- Signer monitoring `/info` unavailable for three consecutive checks.
- Signer `/heartbeat` failing for three consecutive checks.

All other values are observations during testnet calibration. In particular, a tip mismatch is not
automatically a fault because independently updated sources can briefly disagree.

## API

All routes require the existing operator bearer credential:

- `GET /api/v1/health` — latest normalized snapshot; collects once when no sample exists.
- `POST /api/v1/health/refresh` — collect immediately and return the new snapshot.
- `POST /api/v1/health/test-source` — validate and test one candidate metrics/reference URL.

Responses contain normalized values and bounded error codes, not raw upstream bodies or URLs.

## Endpoint safety

Health endpoints are operator-configured but still treated as untrusted input.

- HTTP(S) only; credentials, query strings, and fragments are rejected.
- DNS is resolved before each request and the connection is pinned to the checked address.
- Redirects are not followed.
- Timeouts and response sizes are bounded.
- Unspecified, link-local, multicast, and known cloud-metadata addresses are blocked, including
  IPv4-mapped IPv6 forms.
- Private, loopback, Docker-network, and tailnet addresses are permitted because these are the
  expected deployment patterns.
- An unresolved hostname may be saved for a container that is not running yet, but it must pass the
  same resolution policy before a request is made.

Anyone who can change Sidekick settings already controls its deployment trust boundary. These
checks primarily prevent mistakes and DNS rebinding rather than trying to sandbox the operator.

## Metric compatibility

Collectors parse Prometheus exposition into labelled samples, then normalize only recognized
signals. Unknown metrics are ignored. Missing metrics reduce coverage rather than breaking the page.

Upstream node or signer releases therefore do not require a Sidekick release unless the upstream
HTTP contract changes in a way that removes all useful signals. Exact metric names are isolated in
the collector so aliases can be added without changing the API or UI.

The implementation is based on the node and signer monitoring contracts available in the Stacks
4.0.1 sources. Testnet operation is the calibration source for release-specific behavior.

## Test coverage

- Prometheus labels, escapes, histograms, malformed input, and parser limits.
- Endpoint validation, blocked address classes, connection pinning, timeouts, and response limits.
- Normalization from representative node/signer payloads.
- Counter deltas, counter resets, latency histogram p95, baseline state, and two-hour retention.
- Partial-source behavior and sustained-failure findings.
- Authenticated API reads, refreshes, source tests, and generic error responses.
- Dashboard healthy/partial fixture rendering, Overview health/ETA summary, mobile navigation, copy
  controls, and no credential leakage.
- Live devnet navigation through the page using whatever health sources are available.

## Testnet calibration checklist

Before promoting thresholds beyond reachability:

1. Confirm the deployed node and signer expose the expected endpoints and record missing aliases.
2. Observe normal peer, chaintip, heartbeat, proposal, response, latency, and conflict ranges.
3. Exercise signer/node restarts and confirm transient failures do not create misleading findings.
4. Confirm counter resets and Sidekick restarts return cleanly to baseline collection.
5. Add a threshold only when the testnet evidence shows it is actionable and stable.
