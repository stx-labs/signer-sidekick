# Signer Health

Signer Health gives a pool operator one page for the operational state of the Stacks node and signer.
It is local monitoring, not a replacement for a full observability stack.

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

Not included:

- Host CPU, memory, disk, network, container, or process metrics.
- Logs, historical charts, durable health history, notifications, or automated remediation.
- Threshold-based findings for peer count, tip lag, rejection rate, response latency, or conflicts.
- Any signing or broadcast authority.

## Behavior

Sidekick starts its HTTP control plane before the first health collection. It polls every 30 seconds
and retains two hours of observations in memory. A manual refresh uses the same bounded collector.

The page degrades by capability:

- Node RPC alone still renders core node health.
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
- Private, loopback, Docker-network, and tailnet addresses are permitted for local deployments;
  filtering and DNS pinning still limit rebinding and common SSRF mistakes.
- An unresolved hostname may be saved for a container that is not running yet, but it must pass the
  same resolution policy before a request is made.

## Metric compatibility

Collectors normalize recognized Prometheus signals, ignore unknown metrics, and report missing
metrics as reduced coverage. Metric names are isolated in the collector so aliases do not change the
API or UI. Stacks 4.0.1 node and signer monitoring contracts are the current baseline; testnet
operation calibrates release-specific behavior.
