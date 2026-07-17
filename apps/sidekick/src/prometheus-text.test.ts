import { describe, expect, it } from "vitest";
import { parsePrometheusText, sampleValue } from "./prometheus-text.js";

describe("Prometheus text parsing", () => {
  it("parses gauges, counters, labels, escaped values, and histograms", () => {
    const samples = parsePrometheusText(`
# HELP stacks_signer_block_responses_sent Responses
# TYPE stacks_signer_block_responses_sent counter
stacks_signer_block_responses_sent{response_type="accepted"} 12
stacks_signer_block_responses_sent{response_type="rejected",note="line\\n\\"two\\""} 3 1234
stacks_signer_block_response_latencies_histogram_bucket{le="0.1"} 5
stacks_signer_block_response_latencies_histogram_bucket{le="+Inf"} 15
`);

    expect(
      sampleValue(samples, "stacks_signer_block_responses_sent", {
        response_type: "accepted",
      }),
    ).toBe(12);
    expect(samples[1]?.labels.note).toBe('line\n"two"');
    expect(
      sampleValue(samples, "stacks_signer_block_response_latencies_histogram_bucket", {
        le: "+Inf",
      }),
    ).toBe(15);
  });

  it("ignores comments and non-finite values", () => {
    expect(parsePrometheusText("# EOF\nmetric_nan NaN\nmetric_inf +Inf\nmetric_ok 1\n")).toEqual([
      { name: "metric_ok", labels: {}, value: 1 },
    ]);
  });

  it.each([
    "invalid-name 1",
    'metric{label="unterminated} 1',
    'metric{label="value" nope="value"} 1',
    "metric",
  ])("rejects malformed input without partial parsing: %s", (input) => {
    expect(() => parsePrometheusText(input)).toThrow();
  });

  it("bounds line, label, sample, and document sizes", () => {
    expect(() => parsePrometheusText(`metric ${"1".repeat(17_000)}`)).toThrow("line is too long");
    expect(() => parsePrometheusText(`metric{label="${"a".repeat(501)}"} 1`)).toThrow();
    expect(() => parsePrometheusText("a".repeat(1_048_577))).toThrow("too large");
  });
});
