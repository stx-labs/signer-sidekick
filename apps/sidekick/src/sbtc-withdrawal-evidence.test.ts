import { bufferCV, noneCV, someCV, tupleCV, uintCV } from "@stacks/transactions";
import { describe, expect, it } from "vitest";
import { decodeSbtcWithdrawalCompletion } from "./sbtc-withdrawal-evidence.js";

describe("sBTC withdrawal completion evidence", () => {
  it("decodes the registry's node-readable Bitcoin sweep proof", () => {
    expect(
      decodeSbtcWithdrawalCompletion(
        someCV(
          tupleCV({
            "sweep-txid": bufferCV(Uint8Array.from({ length: 32 }, () => 0x11)),
            "sweep-burn-height": uintCV(963_758),
            "sweep-burn-hash": bufferCV(Uint8Array.from({ length: 32 }, () => 0x22)),
          }),
        ),
      ),
    ).toEqual({
      sweepTxId: `0x${"11".repeat(32)}`,
      bitcoinBlockHeight: 963_758,
      bitcoinBlockHash: `0x${"22".repeat(32)}`,
    });
  });

  it("returns null before the withdrawal is completed", () => {
    expect(decodeSbtcWithdrawalCompletion(noneCV())).toBeNull();
  });
});
