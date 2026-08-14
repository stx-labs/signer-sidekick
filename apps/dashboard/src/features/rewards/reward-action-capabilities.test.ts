import { describe, expect, it } from "vitest";
import { rewardManagerCapabilityId } from "./reward-action-capabilities.js";

describe("reward action capabilities", () => {
  it("maps every reward shortcut to its own server-enforced capability", () => {
    expect(rewardManagerCapabilityId("claim-rewards")).toBe("reference-reward-claims");
    expect(rewardManagerCapabilityId("claim-staker-rewards")).toBe("reference-reward-claims");
    expect(rewardManagerCapabilityId("update-fees")).toBe("update-fees");
    expect(rewardManagerCapabilityId("withdraw-fees")).toBe("withdraw-fees");
    expect(rewardManagerCapabilityId("sweep-fee-refunds")).toBe("sweep-fee-refunds");
  });
});
