# Per-block signer telemetry plan

Status: Sidekick consumer checkpoint implemented and validated; the producer endpoint still
requires a Stacks Signer release.

## Outcome

Signer Sidekick should report signer timing from the individual proposals that produced it. The
operator must be able to distinguish node validation, signer consensus waiting, and response
publication instead of seeing a percentile interpolated from broad Prometheus buckets.

The existing histograms remain a compatibility fallback. Sidekick must label that fallback as a
range and must not present the interpolated value as an exact measurement.

## Validated starting point

Stacks Signer 4.0.1 (`62e03cc5551bfc574223c2b78ce04ceca30cec37`) and upstream `main`
(`6b002604da0533e69f4ebdceb2747954f496a3ea`, inspected 2026-08-15) expose `/metrics`,
`/info`, `/heartbeat`, and `/` on the monitoring listener. They do not expose raw observations. The
existing metrics record:

- node-reported validation duration when a validate response is handled;
- end-to-end response duration from the block header timestamp after the response is acknowledged by
  StackerDB;
- cumulative counters and histograms only.

The production signer on `node-vm` was also checked read-only on 2026-08-15: it reports
`stacks-signer 4.0.1 (62e03cc...)` and returns HTTP 404 for the proposed telemetry path. No service
or configuration was changed during that validation.

The Signer already has the required lifecycle hooks: proposal receipt, validation submission and
result, pre-commit publication, pre-commit threshold, response publication start, and StackerDB
acknowledgement. Exact intermediate durations therefore belong in the Signer, not in Sidekick log
parsing. Log parsing is version-dependent, privileged in many deployments, and cannot provide a
stable completeness contract.

## Producer contract

The Signer monitoring listener adds a bounded read-only endpoint:

`GET /v1/block-telemetry?cursor=<opaque>&limit=<1..500>`

The response is schema version 1:

```json
{
  "schemaVersion": 1,
  "producer": {
    "version": "stacks-signer 4.x",
    "bootId": "opaque-process-id"
  },
  "records": [],
  "nextCursor": "opaque-cursor",
  "hasMore": false,
  "cursorReset": false
}
```

Each record is an updatable lifecycle observation:

- `recordId`: opaque and unique for one proposal attempt within one Signer boot;
- `sequence`: monotonically increasing update sequence;
- public correlation: block ID, signer-sighash, Stacks height, and block header timestamp;
- lifecycle wall timestamps for support correlation;
- monotonic-clock durations for proposal-to-validation-result, validation-result-to-pre-commit,
  pre-commit wait, response publication, and end-to-end local processing;
- the node-reported validation duration;
- accepted, rejected, or pending outcome and a bounded public reject reason.

Durations are non-negative integer milliseconds. The Signer computes durations from monotonic
instants; Sidekick never reconstructs them from scrape time. The existing official response metric
is retained as `headerToResponseAckMs`, explicitly marked as wall-clock-derived because the header
timestamp originates outside the Signer.

The producer keeps a bounded in-memory ring of at least 4,096 updates. Prometheus must not gain a
block-ID label: per-block identifiers in metric labels would create unbounded cardinality.

Cursor rules:

- no cursor returns retained updates from oldest to newest;
- a valid cursor returns only later updates;
- a cursor from a prior boot returns the current retained window with `cursorReset: true`;
- `nextCursor` advances through every record update, including finalization;
- a cursor older than retained history also sets `cursorReset: true` so the consumer can disclose a
  coverage gap.

The endpoint inherits the monitoring listener's private-network trust boundary. It contains no
private keys, signatures, transactions, credentials, or peer addresses.

## Sidekick consumer

Sidekick requests one bounded page during its normal five-second health collection when signer
monitoring is configured. It persists the page with the existing 72-hour raw health observation,
including the next cursor and reset state. Restart hydration resumes from the last persisted cursor.

Records are de-duplicated by `(bootId, recordId)` and the greatest sequence wins. Percentiles use
finalized records whose response timestamp falls within the requested health window. The percentile
algorithm is nearest rank: sort the exact durations and select `ceil(0.95 * n) - 1`. The UI always
shows the sample count and source.

Capability states are:

- `exact`: compatible records are available for this window;
- `collecting`: the endpoint exists but too few finalized records have arrived;
- `histogram-range`: the endpoint is absent and bucket bounds are the available evidence;
- `unavailable`: neither exact records nor usable histogram changes are available.

An HTTP 404 is a normal `histogram-range` compatibility state, not a health incident. Malformed or
oversized telemetry is rejected and the prior cursor is retained. Cursor resets and collection
failures are disclosed in the telemetry coverage summary but do not by themselves claim the Signer
is unhealthy.

## Diagnosis and presentation

Exact timing changes the diagnosis input, not the diagnosis model:

- node validation p95 above the target suggests node execution pressure;
- proposal-to-validation-result high while node validation stays low suggests node RPC, queueing, or
  transport delay;
- pre-commit wait high with healthy local validation suggests signer-set consensus delay and is not
  enough by itself to blame the local Signer;
- response publication high suggests local StackerDB/RPC transport;
- header-to-response high is the operator-facing end-to-end result.

No local-versus-network conclusion may be based on one local timing series alone. Existing node,
reference, participation, missing-response, and disagreement evidence remains required.

The Signer Health page shows exact p95 values only for exact records. Histogram fallback reads, for
example, `5-10s bucket range (98 responses)` rather than `9.9s`. Support bundles include the timing
source, coverage, cursor-reset count, exact phase summaries, and sample window, but not raw per-block
identifiers.

## Retention and limits

- Sidekick raw records: 72 hours through existing health-observation retention.
- Five-minute and 90-day rollups: summary counts and p95 only; no block identifiers.
- maximum response: 1 MiB and 500 records;
- default request: 200 records;
- reject unknown schema versions, invalid lifecycle ordering, negative durations, and oversized
  identifiers.

## Delivery gates

### Sidekick checkpoint

- bounded endpoint parser and cursor/reset handling;
- persistence through health observations and restart hydration;
- exact nearest-rank percentile and phase summaries;
- honest histogram-range fallback;
- diagnosis uses exact values when present; existing Prometheus interpolation remains only for
  compatibility/alert continuity while operator surfaces show the bucket range;
- dashboard and support snapshot expose source and coverage;
- unit, API-contract, dashboard, migration, build, regtest, and census checks pass.

### Stacks Signer checkpoint

- producer ring and monitoring endpoint implemented at the validated lifecycle hooks;
- duplicate proposals, retries, rejection paths, failed StackerDB publication, and restart/reset
  behavior covered;
- no secret-bearing fields and no unbounded metric labels;
- Devnet test proves one real proposal proceeds from receipt through final response and appears in
  Sidekick with matching node validation duration.

Until the Signer checkpoint ships, Sidekick's deployed behavior remains the labeled histogram-range
fallback. This is an explicit cross-repository release dependency, not a hidden incomplete state.

## Implemented Sidekick checkpoint

The 2026-08-15 build includes:

- strict schema-versioned parsing, response-size limits, encoded cursors, legacy 404 detection, and
  the existing DNS-rebinding and metadata-address protections;
- five-second collection when supported, 30-second retry after an unavailable endpoint, and a
  five-minute capability probe after an unsupported response;
- restart-safe cursor persistence in the existing 72-hour health observation stream;
- record-update de-duplication, cursor-reset disclosure, exact nearest-rank response/validation and
  phase p95s, and histogram bucket-range fallback;
- exact timing propagation to Overview and Signer Health, timing-source and sample-count metrics,
  and support-bundle summaries without raw block identifiers;
- compatibility with pre-telemetry Signers without a configuration change or health incident.

Validation completed on the repository's pinned dependency set except that the local shell used
Node 26 while the package declares Node 24.18.0:

- `pnpm check`;
- 68 API-contract, 145 protocol, 855 Sidekick, and 165 dashboard unit tests;
- Devnet harness-state, observer-latency, and manager-census tests;
- production build;
- 12 Clarinet regtest tests;
- 130 Playwright desktop/tablet/mobile tests passed and 2 were intentionally skipped.

The remaining real-world gate cannot be claimed until a Signer build implements the producer:
exercise a real Devnet proposal through the new endpoint, prove the exact durations against the
node-reported validation value, and then deploy that Signer build alongside this Sidekick consumer.
