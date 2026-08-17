import {
  contractPrincipalCV,
  standardPrincipalCV,
  stringAsciiCV,
  tupleCV,
  uintCV,
} from "@stacks/transactions";
import { describe, expect, it } from "vitest";
import { decodePox5PoolActivityEvent } from "./pox5-pool-events.js";

const manager = "SP000000000000000000002Q6VF78.signer-manager";
const otherManager = "SP2369QN53586176SYRF4XFGF4E84V0J0EWKRG0ZH.signer-manager";
const staker = "SP2369QN53586176SYRF4XFGF4E84V0J0EWKRG0ZH";

function contract(value: string) {
  const [address, name] = value.split(".") as [string, string];
  return contractPrincipalCV(address, name);
}

describe("decodePox5PoolActivityEvent", () => {
  it("decodes a staker joining this manager", () => {
    expect(
      decodePox5PoolActivityEvent(
        tupleCV({
          topic: stringAsciiCV("stake"),
          signer: contract(manager),
          staker: standardPrincipalCV(staker),
          "amount-ustx": uintCV(50_000_000_000n),
          "first-reward-cycle": uintCV(142),
          "unlock-cycle": uintCV(154),
        }),
        manager,
      ),
    ).toMatchObject({
      kind: "stake",
      relationship: "joined",
      stakerPrincipal: staker,
      signer: manager,
      amountUstx: "50000000000",
      firstRewardCycle: "142",
      unlockCycle: "154",
    });
  });

  it("records moves both into and out of this manager", () => {
    const base = {
      topic: stringAsciiCV("stake-update"),
      staker: standardPrincipalCV(staker),
    };
    expect(
      decodePox5PoolActivityEvent(
        tupleCV({ ...base, signer: contract(manager), "old-signer": contract(otherManager) }),
        manager,
      )?.relationship,
    ).toBe("joined");
    expect(
      decodePox5PoolActivityEvent(
        tupleCV({ ...base, signer: contract(otherManager), "old-signer": contract(manager) }),
        manager,
      )?.relationship,
    ).toBe("left");
  });

  it("ignores pool events for another manager", () => {
    expect(
      decodePox5PoolActivityEvent(
        tupleCV({
          topic: stringAsciiCV("stake"),
          signer: contract(otherManager),
          staker: standardPrincipalCV(staker),
        }),
        manager,
      ),
    ).toBeNull();
  });

  it("decodes manager-mediated staker rewards", () => {
    expect(
      decodePox5PoolActivityEvent(
        tupleCV({
          topic: stringAsciiCV("claim-staker-rewards-for-signer"),
          "signer-manager": contract(manager),
          staker: standardPrincipalCV(staker),
          "rewards-claimed": uintCV(1250),
          "bond-index": uintCV(8),
        }),
        manager,
      ),
    ).toMatchObject({
      relationship: "rewarded",
      rewardsClaimedSats: "1250",
      bondIndex: "8",
    });
  });
});
