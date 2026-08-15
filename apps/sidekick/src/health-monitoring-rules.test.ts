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

  it("keeps response latency diagnostic-only and validation latency actionable", () => {
    expect(HEALTH_RULE_CATALOG.map(({ id }) => id)).not.toContain(
      "signer-response-latency-elevated",
    );
    expect(HEALTH_RULES.signerValidationLatencyElevated).toMatchObject({
      id: "signer-validation-latency-elevated",
      defaultSeverity: "warning",
      thresholds: {
        minimumAcceptedValidations: 20,
        p95Seconds: 5,
      },
    });
    expect(HEALTH_RULE_THRESHOLDS.validationLatency.windowMs).toBe(15 * 60_000);
  });
});
