import {
  bufferCV,
  contractPrincipalCV,
  cvToHex,
  listCV,
  noneCV,
  responseErrorCV,
  responseOkCV,
  someCV,
  standardPrincipalCV,
  trueCV,
  tupleCV,
  uintCV,
} from "@stacks/transactions";
import { describe, expect, it } from "vitest";
import {
  ClarityCodecError,
  decodeBoolean,
  decodeBuffer,
  decodeClaimRewardsResult,
  decodeClarityHex,
  decodeEarnedStakerRewards,
  decodeOptionalBuffer,
  decodeOptionalPrincipal,
  decodePox5CycleMembership,
  decodePox5StakerInfo,
  decodePoxAddressPreference,
  decodeResponseOk,
  encodeBondPeriods,
  encodeBufferHex,
  encodeOptionalBondIndex,
  encodePrincipalHex,
  encodeUIntHex,
} from "../src/clarity-codecs.js";

describe("Clarity boundary codecs", () => {
  it("decodes a node read-only hex result structurally", () => {
    const value = tupleCV({ earned: uintCV(123n), fees: uintCV(4n) });
    expect(decodeEarnedStakerRewards(decodeClarityHex(cvToHex(value)))).toEqual({
      earned: 123n,
      fees: 4n,
    });
  });

  it("decodes direct and L1 payout preferences", () => {
    expect(decodePoxAddressPreference(noneCV())).toBeNull();
    expect(
      decodePoxAddressPreference(
        someCV(
          tupleCV({
            "max-fee": uintCV(500n),
            "pox-addr": tupleCV({
              hashbytes: bufferCV(new Uint8Array(20).fill(7)),
              version: bufferCV(Uint8Array.of(0)),
            }),
          }),
        ),
      ),
    ).toEqual({
      versionHex: "00",
      hashbytesHex: "07".repeat(20),
      maxFee: 500n,
    });
  });

  it("decodes optional standard and contract principals", () => {
    expect(decodeOptionalPrincipal(noneCV())).toBeNull();
    expect(
      decodeOptionalPrincipal(someCV(standardPrincipalCV("SP000000000000000000002Q6VF78"))),
    ).toBe("SP000000000000000000002Q6VF78");
    expect(
      decodeOptionalPrincipal(
        someCV(contractPrincipalCV("SP000000000000000000002Q6VF78", "manager")),
      ),
    ).toBe("SP000000000000000000002Q6VF78.manager");
  });

  it("decodes authoritative PoX-5 staker positions", () => {
    expect(decodePox5StakerInfo(noneCV())).toBeNull();
    expect(
      decodePox5StakerInfo(
        someCV(
          tupleCV({
            "amount-ustx": uintCV(50_000_000_000n),
            "first-reward-cycle": uintCV(141n),
            "num-cycles": uintCV(12n),
            signer: contractPrincipalCV("SP000000000000000000002Q6VF78", "manager"),
          }),
        ),
      ),
    ).toEqual({
      amountUstx: 50_000_000_000n,
      firstRewardCycle: 141n,
      numCycles: 12n,
      signer: "SP000000000000000000002Q6VF78.manager",
    });
  });

  it("rejects malformed PoX-5 staker position fields", () => {
    expect(() =>
      decodePox5StakerInfo(
        someCV(
          tupleCV({
            "amount-ustx": uintCV(1n),
            "first-reward-cycle": uintCV(141n),
            "num-cycles": uintCV(1n),
            signer: uintCV(1n),
          }),
        ),
      ),
    ).toThrow("get-staker-info.signer: expected principal");
  });

  it("decodes exact PoX-5 per-cycle memberships", () => {
    expect(decodePox5CycleMembership(noneCV())).toBeNull();
    expect(
      decodePox5CycleMembership(
        someCV(
          tupleCV({
            "amount-ustx": uintCV(49_000_000_000n),
            signer: contractPrincipalCV("SP000000000000000000002Q6VF78", "manager"),
          }),
        ),
      ),
    ).toEqual({
      amountUstx: 49_000_000_000n,
      signer: "SP000000000000000000002Q6VF78.manager",
    });
  });

  it("encodes read-only arguments and decodes optional buffers", () => {
    expect(encodePrincipalHex("SP000000000000000000002Q6VF78.manager")).toBe(
      cvToHex(contractPrincipalCV("SP000000000000000000002Q6VF78", "manager")),
    );
    expect(encodeUIntHex(141n)).toBe(cvToHex(uintCV(141n)));
    expect(encodeBufferHex("02".repeat(33))).toBe(cvToHex(bufferCV(new Uint8Array(33).fill(2))));
    expect(decodeOptionalBuffer(noneCV())).toBeNull();
    expect(decodeBuffer(bufferCV(Uint8Array.of(1, 2)))).toBe("0102");
    expect(decodeOptionalBuffer(someCV(bufferCV(Uint8Array.of(1, 2))))).toBe("0102");
    expect(decodeBoolean(decodeResponseOk(responseOkCV(trueCV())))).toBe(true);
    expect(() => encodeBufferHex("abc")).toThrow("even-length hexadecimal");
  });

  it("decodes the manager claim response", () => {
    const result = responseOkCV(
      tupleCV({
        "bond-rewards": listCV([
          tupleCV({
            "bond-index": uintCV(2n),
            earned: uintCV(40n),
            "rewards-per-token": uintCV(9n),
          }),
        ]),
        "bond-totals": uintCV(40n),
        "stx-rewards": tupleCV({ earned: uintCV(60n), "rewards-per-token": uintCV(11n) }),
        "total-rewards": uintCV(100n),
      }),
    );

    expect(decodeClaimRewardsResult(result)).toEqual({
      totalRewards: 100n,
      bondTotals: 40n,
      stxRewards: { earned: 60n, rewardsPerToken: 11n },
      bondRewards: [{ bondIndex: 2n, earned: 40n, rewardsPerToken: 9n }],
    });
  });

  it("rejects contract errors and shape mismatches with a field path", () => {
    expect(() => decodeResponseOk(responseErrorCV(uintCV(53n)), "claim-rewards")).toThrow(
      "claim-rewards: contract returned err",
    );
    expect(() => decodeEarnedStakerRewards(tupleCV({ earned: uintCV(1n) }))).toThrow(
      "missing tuple field fees",
    );
    expect(() => decodeClarityHex("not-hex")).toThrow(ClarityCodecError);
  });

  it("encodes bounded bond inputs", () => {
    expect(encodeOptionalBondIndex(null)).toEqual(noneCV());
    expect(encodeOptionalBondIndex(3n)).toEqual(someCV(uintCV(3n)));
    expect(encodeBondPeriods([1n, 4n])).toEqual(listCV([uintCV(1n), uintCV(4n)]));
    expect(() => encodeBondPeriods([0n, 1n, 2n, 3n, 4n, 5n, 6n])).toThrow(
      "at most six bond periods",
    );
  });
});
