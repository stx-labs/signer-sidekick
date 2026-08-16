import { describe, expect, it } from "vitest";
import { copyValidDate, parseCanonicalInstant } from "./time.js";

describe("time validation", () => {
  it("copies valid Date values without sharing mutable state", () => {
    const input = new Date("2026-08-15T12:00:00.000Z");
    const copy = copyValidDate(input);
    expect(copy).toEqual(input);
    expect(copy).not.toBe(input);
    expect(copyValidDate(new Date(Number.NaN))).toBeNull();
    expect(copyValidDate("2026-08-15T12:00:00.000Z")).toBeNull();
  });

  it("accepts canonical ISO instants only", () => {
    expect(parseCanonicalInstant("2026-08-15T12:00:00.000Z")?.toISOString()).toBe(
      "2026-08-15T12:00:00.000Z",
    );
    expect(parseCanonicalInstant("2026-08-15T12:00:00Z")).toBeNull();
    expect(parseCanonicalInstant("not-a-date")).toBeNull();
  });
});
