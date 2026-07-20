import {
  contractPrincipalCV,
  noneCV,
  someCV,
  stringAsciiCV,
  tupleCV,
  uintCV,
} from "@stacks/transactions";
import { describe, expect, it } from "vitest";
import { decodeManagerPrintEvent } from "../src/manager-events.js";

const staker = "SP000000000000000000002Q6VF78.staker";

describe("reference manager print events", () => {
  it("decodes direct and L1 staker claims structurally", () => {
    expect(
      decodeManagerPrintEvent(
        tupleCV({
          topic: stringAsciiCV("claim-staker-rewards"),
          staker: contractPrincipalCV("SP000000000000000000002Q6VF78", "staker"),
          "reward-cycle": uintCV(141n),
          "bond-index": noneCV(),
          "amount-sats": uintCV(10_000n),
          "l1-withdrawal": noneCV(),
        }),
      ),
    ).toEqual({
      kind: "claim-staker-rewards",
      topic: "claim-staker-rewards",
      stakerPrincipal: staker,
      rewardCycle: "141",
      bondIndex: null,
      amountSats: "10000",
      l1Withdrawal: null,
    });

    expect(
      decodeManagerPrintEvent(
        tupleCV({
          topic: stringAsciiCV("claim-staker-rewards"),
          staker: contractPrincipalCV("SP000000000000000000002Q6VF78", "staker"),
          "reward-cycle": uintCV(141n),
          "bond-index": noneCV(),
          "amount-sats": uintCV(10_000n),
          "l1-withdrawal": someCV(
            tupleCV({
              "withdrawal-request": uintCV(72n),
              amount: uintCV(9_000n),
              "max-fee": uintCV(1_000n),
            }),
          ),
        }),
      ),
    ).toMatchObject({
      kind: "claim-staker-rewards",
      l1Withdrawal: { requestId: "72", amountSats: "9000", maxFeeSats: "1000" },
    });
  });

  it("decodes rejected reclaim and accepted settlement lifecycle events", () => {
    expect(
      decodeManagerPrintEvent(
        tupleCV({
          topic: stringAsciiCV("reclaim-failed-withdrawal"),
          "request-id": uintCV(72n),
          staker: contractPrincipalCV("SP000000000000000000002Q6VF78", "staker"),
          "amount-sats": uintCV(10_000n),
        }),
      ),
    ).toMatchObject({
      kind: "reclaim-failed-withdrawal",
      requestId: "72",
      amountSats: "10000",
    });
    expect(
      decodeManagerPrintEvent(
        tupleCV({
          topic: stringAsciiCV("settle-accepted-withdrawal"),
          "request-id": uintCV(73n),
          staker: contractPrincipalCV("SP000000000000000000002Q6VF78", "staker"),
          "liability-released": uintCV(20_000n),
        }),
      ),
    ).toMatchObject({
      kind: "settle-accepted-withdrawal",
      requestId: "73",
      liabilityReleasedSats: "20000",
    });
  });

  it("preserves unknown topics without guessing their payload", () => {
    expect(decodeManagerPrintEvent(tupleCV({ topic: stringAsciiCV("update-fees") }))).toEqual({
      kind: "other",
      topic: "update-fees",
    });
  });
});
