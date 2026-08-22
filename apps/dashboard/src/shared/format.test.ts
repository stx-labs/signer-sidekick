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

describe("reward amount rule", () => {
  it("uses whole sats below 100,000 and three significant figures above", async () => {
    const { amount, amountParts, exactSats, feePercent, shortUtc, stxAmount } = await import(
      "./format.js"
    );
    expect(amount("0")).toBe("0 sats");
    expect(amount("8150")).toBe("8,150 sats");
    expect(amount("99999")).toBe("99,999 sats");
    expect(amount("100000")).toBe("0.001 sBTC");
    expect(amount("245900")).toBe("0.00246 sBTC");
    expect(amount("1287000")).toBe("0.0129 sBTC");
    expect(amount("12900000")).toBe("0.129 sBTC");
    expect(amount("162235", "BTC")).toBe("0.00162 BTC");
    expect(amount(null)).toBe("—");
    expect(amountParts("64350")).toEqual({ value: "64,350", unit: "sats" });
    expect(amountParts("1287000")).toEqual({ value: "0.0129", unit: "sBTC" });
    expect(exactSats("1287000")).toBe("1,287,000 sats");
    expect(stxAmount("12480000")).toBe("12.48 STX");
    expect(stxAmount("310000")).toBe("0.31 STX");
    expect(stxAmount("999995")).toBe("1.00 STX");
    expect(feePercent("500")).toBe("5%");
    expect(feePercent("250")).toBe("2.5%");
    expect(shortUtc("2026-08-22T03:14:00.000Z")).toBe("Aug 22, 03:14 UTC");
  });
});
