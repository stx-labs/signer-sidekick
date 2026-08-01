import { describe, expect, it } from "vitest";
import { isHiroRateLimit, rateLimitGuidance, rateLimitHeading } from "./rate-limit-guidance.js";

describe("rate-limit guidance", () => {
  it("guides an unauthenticated Hiro API operator to add a key", () => {
    const info = { source: "hiro-api" as const, retryAfterSeconds: 30, apiKeyConfigured: false };
    expect(rateLimitHeading(info)).toBe("Hiro API rate limit reached");
    expect(rateLimitGuidance(info)).toBe("Add a free API key in Settings for higher limits.");
    expect(isHiroRateLimit(info)).toBe(true);
  });

  it("does not suggest a new key when Hiro already has one", () => {
    const info = { source: "hiro-api" as const, retryAfterSeconds: 30, apiKeyConfigured: true };
    expect(rateLimitGuidance(info)).toBe("Check your API key and plan limits.");
  });

  it("uses source-appropriate guidance for other API and node limits", () => {
    expect(rateLimitHeading({ source: "stacks-api", retryAfterSeconds: 10 })).toBe(
      "Configured Stacks API rate limit reached",
    );
    expect(rateLimitGuidance({ source: "node", retryAfterSeconds: 10 })).toBe(
      "Check node RPC or proxy limits.",
    );
    expect(isHiroRateLimit({ source: "node", retryAfterSeconds: 10 })).toBe(false);
  });
});
