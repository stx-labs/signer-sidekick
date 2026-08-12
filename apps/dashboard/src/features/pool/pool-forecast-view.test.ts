import type { ForecastCycle } from "@stx-labs/signer-sidekick-api-contracts";
import { describe, expect, it } from "vitest";
import { buildPoolForecastView, formatSignedPercent } from "./pool-forecast-view.js";

function cycle(cycleId: number, stx: number, classification?: "authoritative" | "projected") {
  return {
    cycleId,
    status: "ready",
    provenance: {
      classification: classification ?? (cycleId === 141 ? "authoritative" : "projected"),
      contractSource: "pox5-read-only",
      localRosterSource: "api-indexed-node-verified",
    },
    local: { stakerCount: 4, enumeratedStxUstx: String(stx * 1_000_000), rosterAvailable: true },
    contract: { pendingStxUstx: String(stx * 1_000_000), inSignerSet: true },
    threshold: { marginUstx: "1", meetsThreshold: true },
    changesFromPrevious: null,
  } satisfies ForecastCycle;
}

describe("pool forecast view", () => {
  it("summarizes the first meaningful projected change", () => {
    const view = buildPoolForecastView([
      cycle(141, 3_999_770),
      cycle(142, 3_999_770),
      cycle(146, 3_999_770),
      cycle(147, 3_684_770),
      cycle(150, 3_684_770),
    ]);

    expect(view.nextChange).toEqual({
      cycleId: 147,
      deltaUstx: -315_000_000_000n,
      relativePercent: -7.875,
    });
    expect(view.endingCycleId).toBe(150);
    expect(view.endingRelativePercent).toBe(-7.875);
    expect(view.points.map(({ relativePercent }) => relativePercent)).toEqual([
      0, 0, 0, -7.875, -7.875,
    ]);
  });

  it("reports a flat forecast without inventing a change", () => {
    const view = buildPoolForecastView([cycle(141, 4_000_000), cycle(142, 4_000_000)]);

    expect(view.nextChange).toBeNull();
    expect(view.endingRelativePercent).toBe(0);
    expect(view.relativeScaleAvailable).toBe(true);
  });

  it("fails the relative scale closed when a zero pool becomes non-zero", () => {
    const view = buildPoolForecastView([cycle(141, 0), cycle(142, 50_000)]);

    expect(view.nextChange?.deltaUstx).toBe(50_000_000_000n);
    expect(view.endingRelativePercent).toBeNull();
    expect(view.relativeScaleAvailable).toBe(false);
  });

  it("formats signed percentages without negative zero", () => {
    expect(formatSignedPercent(-7.875)).toBe("−7.9%");
    expect(formatSignedPercent(4.24)).toBe("+4.2%");
    expect(formatSignedPercent(0)).toBe("0%");
    expect(formatSignedPercent(null)).toBe("—");
  });
});
