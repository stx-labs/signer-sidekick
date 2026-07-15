import { describe, expect, it } from "vitest";
import { readManagerActivity } from "./manager-activity.js";
import type { StoredChainEvent } from "./storage/store.js";

const manager = "SP000000000000000000002Q6VF78.signer-manager";
const staker = "SP000000000000000000002Q6VF78.staker";

function storedEvent(
  blockHeight: number,
  eventIndex: number,
  event: Record<string, unknown>,
): StoredChainEvent {
  return {
    chainId: 1,
    txId: `0x${String(blockHeight).padStart(64, "0")}`,
    eventIndex,
    blockHeight,
    blockHash: `0x${"11".repeat(32)}`,
    indexBlockHash: `0x${"22".repeat(32)}`,
    microblockHash: null,
    microblockSequence: null,
    canonical: true,
    microblockCanonical: true,
    contractId: manager,
    topic: String(event.kind),
    rawPayload: {},
    decodedSchemaVersion: 1,
    decodedPayload: { transactionStatus: "success", event },
    sourceId: "api:mainnet:test",
    firstSeenAt: "2026-07-14T12:00:00.000Z",
    updatedAt: "2026-07-14T12:00:00.000Z",
  };
}

describe("manager activity projection", () => {
  it("reduces claims and withdrawal settlement deterministically", () => {
    const events = [
      storedEvent(102, 0, {
        kind: "settle-accepted-withdrawal",
        topic: "settle-accepted-withdrawal",
        requestId: "72",
        stakerPrincipal: staker,
        liabilityReleasedSats: "10000",
      }),
      storedEvent(101, 0, {
        kind: "claim-staker-rewards",
        topic: "claim-staker-rewards",
        stakerPrincipal: staker,
        rewardCycle: "141",
        bondIndex: null,
        amountSats: "10000",
        l1Withdrawal: { requestId: "72", amountSats: "9000", maxFeeSats: "1000" },
      }),
    ];
    const activity = readManagerActivity({ listChainEventsForContract: () => events }, 1, manager);

    expect(activity.claims).toHaveLength(1);
    expect(activity.withdrawals).toEqual([
      expect.objectContaining({ requestId: "72", state: "settled", resolvedBlockHeight: 102 }),
    ]);
  });
});
