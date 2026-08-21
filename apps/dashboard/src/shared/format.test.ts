import { describe, expect, it } from "vitest";
import { sbtc } from "./format.js";

describe("sbtc", () => {
  it("distinguishes missing evidence from a real zero balance", () => {
    expect(sbtc(null)).toBe("—");
    expect(sbtc(undefined)).toBe("—");
    expect(sbtc("")).toBe("—");
    expect(sbtc(" ")).toBe("—");
    expect(sbtc("invalid")).toBe("—");
    expect(sbtc("0")).toBe("0");
  });

  it("formats satoshis as sBTC", () => {
    expect(sbtc("163011")).toBe("0.00163011");
  });
});
