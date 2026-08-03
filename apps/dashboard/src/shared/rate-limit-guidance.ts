import type { RateLimitInfo } from "@stx-labs/signer-sidekick-api-contracts";

export function rateLimitHeading(info: RateLimitInfo | null | undefined): string {
  switch (info?.source) {
    case "hiro-api":
      return "Hiro API rate limit reached";
    case "stacks-api":
      return "Configured Stacks API rate limit reached";
    case "node":
      return "Local node rate limit reached";
    default:
      return "Data source is rate limited";
  }
}

export function rateLimitGuidance(info: RateLimitInfo | null | undefined): string {
  switch (info?.source) {
    case "hiro-api":
      return info.apiKeyConfigured
        ? "Check your API key and plan limits."
        : "Add a free API key in Settings for higher limits.";
    case "stacks-api":
      return "Check its quota or proxy limits.";
    case "node":
      return "Check node RPC or proxy limits.";
    default:
      return "Sidekick will retry automatically.";
  }
}

export function isHiroRateLimit(info: RateLimitInfo | null | undefined): boolean {
  return info?.source === "hiro-api";
}
