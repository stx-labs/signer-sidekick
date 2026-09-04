import { describe, expect, it } from "vitest";
import { operatorStateIsStale, STATUS_STALE_AFTER_MS } from "./status-freshness.js";

describe("operator status freshness", () => {
  it("keeps a recent retained snapshot current after an isolated request failure", () => {
    expect(
      operatorStateIsStale({
        connectionUnavailable: false,
        serverStatus: "current",
        ageMs: STATUS_STALE_AFTER_MS,
      }),
    ).toBe(false);
  });

  it("marks retained data delayed only after the freshness budget expires", () => {
    expect(
      operatorStateIsStale({
        connectionUnavailable: false,
        serverStatus: "current",
        ageMs: STATUS_STALE_AFTER_MS + 1,
      }),
    ).toBe(true);
  });

  it("honors explicit server or connection failures immediately", () => {
    expect(
      operatorStateIsStale({
        connectionUnavailable: false,
        serverStatus: "stale",
        ageMs: 1,
      }),
    ).toBe(true);
    expect(
      operatorStateIsStale({
        connectionUnavailable: true,
        serverStatus: "current",
        ageMs: 1,
      }),
    ).toBe(true);
  });
});
