import { describe, expect, it } from "vitest";
import { SubmittedObservationCadence } from "./submitted-observation-cadence.js";

describe("submitted observation pacing", () => {
  it("backs missing/unavailable items off independently, capped at five minutes", () => {
    const cadence = new SubmittedObservationCadence();
    let now = 0;
    for (const delay of [30_000, 60_000, 120_000, 240_000, 300_000, 300_000]) {
      expect(cadence.isDue("missing", now)).toBe(true);
      cadence.record("missing", true, now);
      expect(cadence.isDue("missing", now + delay - 1)).toBe(false);
      expect(cadence.isDue("other", now)).toBe(true);
      now += delay;
    }
    expect(cadence.isDue("missing", now)).toBe(true);
  });

  it("returns to thirty seconds on an observed result, then restarts the retry backoff", () => {
    const cadence = new SubmittedObservationCadence();
    cadence.record("item", true, 0);
    cadence.record("item", true, 30_000);
    cadence.record("item", false, 31_000); // An immediate manual read saw it.
    expect(cadence.isDue("item", 60_999)).toBe(false);
    expect(cadence.isDue("item", 61_000)).toBe(true);
    cadence.record("item", true, 61_000);
    expect(cadence.isDue("item", 91_000)).toBe(true);
  });

  it("forgets only pacing for items no longer in the durable observation set", () => {
    const cadence = new SubmittedObservationCadence();
    cadence.record("active", true, 0);
    cadence.record("terminal", true, 0);
    cadence.retain(["active"]);
    expect(cadence.isDue("active", 1)).toBe(false);
    expect(cadence.isDue("terminal", 1)).toBe(true);
  });
});
