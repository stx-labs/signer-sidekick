import { falseCV, trueCV, uintCV } from "@stacks/transactions";
import { describe, expect, it, vi } from "vitest";
import { type PoolForecastStore, readPoolForecast } from "./pool-forecast.js";
import type {
  SignerStakerRun,
  StoredCycleMembership,
  StoredSignerStaker,
} from "./storage/store.js";

const manager = "SP000000000000000000002Q6VF78.signer-manager";
const pox5 = "SP000000000000000000002Q6VF78.pox-5";
const sourceId = "api:mainnet:test";
const stakerOne = "SP000000000000000000002Q6VF78";
const stakerTwo = "SP2JXKMSH007NPYAQHKJPQMAQYAD90NQGTVJVQ02B";

const completedRun: SignerStakerRun = {
  runId: "1f53f216-71c3-4b72-865d-53e81a426bc8",
  sourceId,
  managerPrincipal: manager,
  status: "completed",
  cursor: null,
  pagesProcessed: 2,
  itemsProcessed: 2,
  startedAt: "2026-07-14T12:00:00.000Z",
  updatedAt: "2026-07-14T12:01:00.000Z",
  completedAt: "2026-07-14T12:01:00.000Z",
};

function staker(stakerPrincipal: string, hasBtc = false): StoredSignerStaker {
  return {
    managerPrincipal: manager,
    stakerPrincipal,
    hasStx: true,
    hasBtc,
    stxNodeVerified: true,
    active: true,
    sourceId,
    verificationSourceId: "node:mainnet:test",
    lastSeenRunId: completedRun.runId,
    firstSeenAt: completedRun.startedAt,
    lastSeenAt: completedRun.completedAt as string,
    position: null,
  };
}

function membership(
  stakerPrincipal: string,
  rewardCycle: bigint,
  amountUstx: bigint,
): StoredCycleMembership {
  return {
    stakerPrincipal,
    rewardCycle,
    signerPrincipal: manager,
    amountUstx,
    active: true,
  };
}

function store(
  run: SignerStakerRun | null = completedRun,
  memberships: StoredCycleMembership[] = [],
): PoolForecastStore {
  return {
    getLatestCompletedSignerStakerRun: vi.fn().mockReturnValue(run),
    listSignerStakers: vi.fn().mockReturnValue([staker(stakerOne), staker(stakerTwo, true)]),
    listCycleMemberships: vi.fn().mockReturnValue(memberships),
  };
}

function options(
  projectionStore: PoolForecastStore,
  callReadOnly: ReturnType<typeof vi.fn>,
  horizonCycles = 3,
) {
  return {
    store: projectionStore,
    node: { callReadOnly },
    sourceId,
    managerPrincipal: manager,
    pox5ContractId: pox5,
    currentRewardCycle: 141,
    horizonCycles,
    observedAt: "2026-07-14T12:02:00.000Z",
    burnBlockHeight: 960_240,
    stacksTipHeight: 8_600_000,
  };
}

describe("pool cycle forecast", () => {
  it("reconciles enumerated STX positions with exact contract aggregates", async () => {
    const projectionStore = store(completedRun, [
      membership(stakerOne, 141n, 40_000_000_000n),
      membership(stakerOne, 142n, 40_000_000_000n),
      membership(stakerTwo, 142n, 20_000_000_000n),
      membership(stakerTwo, 143n, 20_000_000_000n),
    ]);
    const callReadOnly = vi
      .fn()
      .mockResolvedValueOnce(uintCV(40_000_000_000n))
      .mockResolvedValueOnce(uintCV(0n))
      .mockResolvedValueOnce(uintCV(40_000_000_000n))
      .mockResolvedValueOnce(falseCV())
      .mockResolvedValueOnce(uintCV(60_000_000_000n))
      .mockResolvedValueOnce(uintCV(60_000_000_000n))
      .mockResolvedValueOnce(uintCV(60_000_000_000n))
      .mockResolvedValueOnce(trueCV())
      .mockResolvedValueOnce(uintCV(20_000_000_000n))
      .mockResolvedValueOnce(uintCV(0n))
      .mockResolvedValueOnce(uintCV(20_000_000_000n))
      .mockResolvedValueOnce(falseCV());

    const result = await readPoolForecast(options(projectionStore, callReadOnly));

    expect(result.status).toBe("attention");
    expect(result.ingestion).toMatchObject({
      pagesProcessed: 2,
      activeDiscoveredStakers: 2,
      stxDiscoveries: 2,
      bondDiscoveries: 1,
    });
    expect(result.cycles[0]).toMatchObject({
      cycleId: 141,
      status: "attention",
      provenance: {
        classification: "authoritative",
        contractSource: "pox5-read-only",
        localRosterSource: "api-indexed-node-verified",
      },
      local: {
        stakerCount: 1,
        enumeratedStxUstx: "40000000000",
        enumerationDeltaUstx: "0",
        matchesContractPending: true,
      },
      contract: {
        pendingStxUstx: "40000000000",
        eligibleStxSharesUstx: "0",
        totalDelegatedUstx: "40000000000",
        nonStxDelegatedUstx: "0",
        inSignerSet: false,
      },
      threshold: { marginUstx: "-10000000000", meetsThreshold: false },
    });
    expect(result.cycles[1]?.changesFromPrevious).toEqual({
      joiningStakers: 1,
      leavingStakers: 0,
      changedAmountStakers: 0,
      netEnumeratedStxDeltaUstx: "20000000000",
    });
    expect(result.cycles.slice(1).map(({ provenance }) => provenance.classification)).toEqual([
      "projected",
      "projected",
    ]);
    expect(result.cycles[2]?.changesFromPrevious).toEqual({
      joiningStakers: 0,
      leavingStakers: 1,
      changedAmountStakers: 0,
      netEnumeratedStxDeltaUstx: "-40000000000",
    });
    expect(callReadOnly).toHaveBeenCalledTimes(12);
    expect(callReadOnly).toHaveBeenCalledWith(
      pox5,
      "get-signer-shares-staked-for-cycle",
      manager,
      expect.arrayContaining([expect.stringMatching(/^0x09$/)]),
    );
  });

  it("reports attention when the roster and contract pending total disagree", async () => {
    const projectionStore = store(completedRun, [membership(stakerOne, 141n, 40_000_000_000n)]);
    const callReadOnly = vi
      .fn()
      .mockResolvedValueOnce(uintCV(39_000_000_000n))
      .mockResolvedValueOnce(uintCV(0n))
      .mockResolvedValueOnce(uintCV(39_000_000_000n))
      .mockResolvedValueOnce(falseCV());

    const result = await readPoolForecast(options(projectionStore, callReadOnly, 1));

    expect(result.status).toBe("attention");
    expect(result.cycles[0]).toMatchObject({
      status: "attention",
      local: {
        enumerationDeltaUstx: "1000000000",
        matchesContractPending: false,
      },
    });
  });

  it("keeps contract state available while clearly marking a missing local roster", async () => {
    const projectionStore = store(null);
    const callReadOnly = vi
      .fn()
      .mockResolvedValueOnce(uintCV(50_000_000_000n))
      .mockResolvedValueOnce(uintCV(50_000_000_000n))
      .mockResolvedValueOnce(uintCV(50_000_000_000n))
      .mockResolvedValueOnce(trueCV());

    const result = await readPoolForecast(options(projectionStore, callReadOnly, 1));

    expect(result.status).toBe("attention");
    expect(result.ingestion).toBeNull();
    expect(result.cycles[0]?.local).toEqual({
      rosterAvailable: false,
      stakerCount: null,
      enumeratedStxUstx: null,
      enumerationDeltaUstx: null,
      matchesContractPending: null,
    });
    expect(result.cycles[0]?.provenance).toEqual({
      classification: "authoritative",
      contractSource: "pox5-read-only",
      localRosterSource: "unavailable",
    });
    expect(projectionStore.listCycleMemberships).not.toHaveBeenCalled();
  });
});
