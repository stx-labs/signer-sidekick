import { describe, expect, it } from "vitest";
import {
  HEALTH_RULE_CATALOG,
  HEALTH_RULE_THRESHOLDS,
  HEALTH_RULES,
} from "./health-monitoring-rules.js";

describe("health rule catalog", () => {
  it("keeps every finding identifier unique and review metadata populated", () => {
    const ids = HEALTH_RULE_CATALOG.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const rule of HEALTH_RULE_CATALOG) {
      expect(rule.rationale.length).toBeGreaterThan(20);
      expect(rule.falsePositiveGuard.length).toBeGreaterThan(20);
    }
  });

  it("keeps ambiguous signer performance counters diagnostic-only", () => {
    expect(HEALTH_RULE_CATALOG.map(({ id }) => id)).not.toEqual(
      expect.arrayContaining([
        "signer-response-latency-elevated",
        "signer-validation-latency-elevated",
        "signer-rejection-rate-elevated",
        "signer-agreement-conflicts-elevated",
      ]),
    );
  });

  it("waits a minute before making a local endpoint outage actionable", () => {
    expect(HEALTH_RULE_THRESHOLDS.localEndpointFailure).toEqual({
      minimumSamples: 3,
      minimumWindowMs: 60_000,
    });
  });

  it("keeps a lagging comparison API informational", () => {
    expect(HEALTH_RULES.referenceApiBehindLocalNode.defaultSeverity).toBe("info");
    expect(HEALTH_RULES.configuredApiBehindLocalNode.defaultSeverity).toBe("info");
  });
});
