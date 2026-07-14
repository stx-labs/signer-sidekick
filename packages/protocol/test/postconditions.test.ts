import {
  type PoxPostCondition,
  postConditionToHex,
  postConditionToWire,
  type StakingPostCondition,
  wireToPostCondition,
} from "@stacks/transactions";
import { describe, expect, it } from "vitest";

const address = "SP000000000000000000002Q6VF78";

describe("Epoch 4.0 Staking and PoX post conditions", () => {
  it("serializes and round-trips a Stacking amount condition", () => {
    const condition: StakingPostCondition = {
      type: "staking-postcondition",
      address,
      condition: "gte",
      amount: 50_000_000_000n,
    };

    expect(postConditionToHex(condition)).toBe(
      "0302160000000000000000000000000000000000000000030000000ba43b7400",
    );
    expect(wireToPostCondition(postConditionToWire(condition))).toEqual({
      ...condition,
      amount: "50000000000",
    });
  });

  it("serializes and round-trips a PoX operation condition", () => {
    const condition: PoxPostCondition = {
      type: "pox-postcondition",
      address,
      condition: "will-perform",
    };

    expect(postConditionToHex(condition)).toBe("040216000000000000000000000000000000000000000032");
    expect(wireToPostCondition(postConditionToWire(condition))).toEqual(condition);
  });
});
