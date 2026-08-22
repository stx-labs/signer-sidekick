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

describe("decodePox5PoolActivityEvent — reward prints", () => {
  it("decodes the manager-level collect print without a staker", () => {
    const event = decodePox5PoolActivityEvent(
      tupleCV({
        topic: stringAsciiCV("claim-rewards"),
        "reward-cycle": uintCV(141),
        "signer-manager": contract(manager),
        "stx-rewards": uintCV(1_200_000),
        "total-rewards": uintCV(1_287_000),
      }),
      manager,
    );
    expect(event).toMatchObject({
      kind: "claim-rewards",
      relationship: "collected",
      stakerPrincipal: null,
      signerManager: manager,
      rewardCycle: "141",
      totalRewardsSats: "1287000",
      stxRewardsSats: "1200000",
    });
  });

  it("ignores another manager's collect and keeps requiring a staker on other topics", () => {
    expect(
      decodePox5PoolActivityEvent(
        tupleCV({
          topic: stringAsciiCV("claim-rewards"),
          "reward-cycle": uintCV(141),
          "signer-manager": contract(otherManager),
          "total-rewards": uintCV(1),
        }),
        manager,
      ),
    ).toBeNull();
    expect(() =>
      decodePox5PoolActivityEvent(
        tupleCV({ topic: stringAsciiCV("stake"), signer: contract(manager) }),
        manager,
      ),
    ).toThrow(/staker principal/);
  });

  it("carries the reward cycle on staker payout prints", () => {
    const event = decodePox5PoolActivityEvent(
      tupleCV({
        topic: stringAsciiCV("claim-staker-rewards-for-signer"),
        "signer-manager": contract(manager),
        staker: standardPrincipalCV(staker),
        "reward-cycle": uintCV(141),
        "bond-index": uintCV(3),
        "rewards-claimed": uintCV(245_900),
      }),
      manager,
    );
    expect(event).toMatchObject({
      relationship: "rewarded",
      stakerPrincipal: staker,
      rewardCycle: "141",
      bondIndex: "3",
      rewardsClaimedSats: "245900",
    });
  });
});
