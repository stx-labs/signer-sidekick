import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assessObserverLatency, observerLatencySample } from "./check-observer-latency.mjs";

function metrics({ count, withinTwoSeconds, le1 = 0, le5 = count }) {
  return `
sidekick_observer_reconciliation_latency_seconds_bucket{domain="current",le="1"} ${le1}
sidekick_observer_reconciliation_latency_seconds_bucket{domain="current",le="2"} ${withinTwoSeconds}
sidekick_observer_reconciliation_latency_seconds_bucket{domain="current",le="5"} ${le5}
sidekick_observer_reconciliation_latency_seconds_bucket{domain="current",le="10"} ${count}
sidekick_observer_reconciliation_latency_seconds_bucket{domain="current",le="30"} ${count}
sidekick_observer_reconciliation_latency_seconds_bucket{domain="current",le="+Inf"} ${count}
sidekick_observer_reconciliation_latency_seconds_sum{domain="current"} 12.5
sidekick_observer_reconciliation_latency_seconds_count{domain="current"} ${count}
sidekick_observer_reconciliation_within_two_seconds_total{domain="current"} ${withinTwoSeconds}
`;
}

describe("observer latency acceptance", () => {
  it("passes a bounded window when at least 95 percent complete within two seconds", () => {
    const before = observerLatencySample(metrics({ count: 100, withinTwoSeconds: 95, le1: 80 }));
    const after = observerLatencySample(metrics({ count: 200, withinTwoSeconds: 190, le1: 160 }));

    assert.deepEqual(assessObserverLatency({ before, after, minimumSamples: 100 }), {
      status: "pass",
      targetSeconds: 2,
      requiredFraction: 0.95,
      minimumSamples: 100,
      samples: 100,
      withinTarget: 95,
      withinTargetFraction: 0.95,
      p95UpperBoundSeconds: 2,
      buckets: { 1: 80, 2: 95, 5: 100, 10: 100, 30: 100, "+Inf": 100 },
    });
  });

  it("fails a sufficiently sampled window below the target", () => {
    const assessment = assessObserverLatency({
      after: observerLatencySample(metrics({ count: 100, withinTwoSeconds: 94 })),
      minimumSamples: 100,
    });

    assert.equal(assessment.status, "fail");
    assert.equal(assessment.p95UpperBoundSeconds, 5);
  });

  it("does not make a p95 claim from too few callbacks", () => {
    const assessment = assessObserverLatency({
      after: observerLatencySample(metrics({ count: 20, withinTwoSeconds: 20 })),
      minimumSamples: 100,
    });

    assert.equal(assessment.status, "insufficient-samples");
    assert.equal(assessment.samples, 20);
  });

  it("rejects counter resets and inconsistent histogram data", () => {
    const before = observerLatencySample(metrics({ count: 10, withinTwoSeconds: 10 }));
    const reset = observerLatencySample(metrics({ count: 1, withinTwoSeconds: 1 }));
    assert.throws(
      () => assessObserverLatency({ before, after: reset }),
      /counters reset during the measurement window/,
    );

    const inconsistent = observerLatencySample(metrics({ count: 100, withinTwoSeconds: 99 }));
    inconsistent.buckets["2"] = 98;
    assert.throws(
      () => assessObserverLatency({ after: inconsistent }),
      /counters and histogram buckets disagree/,
    );
  });
});
