import type { EngineJobState } from "@stx-labs/signer-sidekick-api-contracts";

export type EngineJobBadgeState = "success" | "error" | "caution" | "info";

export function engineJobBadgeState(state: EngineJobState): EngineJobBadgeState {
  switch (state) {
    case "reconciled":
      return "success";
    case "blocked":
    case "ambiguous":
    case "noncanonical_reobserve":
      return "error";
    case "awaiting_approval":
      return "caution";
    case "prepared":
    case "preflighted":
    case "nonce_reserved":
    case "broadcast":
    case "confirmed":
    case "superseded":
      return "info";
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}
