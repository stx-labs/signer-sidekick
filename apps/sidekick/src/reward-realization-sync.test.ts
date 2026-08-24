import {
  cvToHex,
  falseCV,
  listCV,
  makeSTXTokenTransfer,
  noneCV,
  stringAsciiCV,
  tupleCV,
  uintCV,
} from "@stacks/transactions";
import { simulatePox5CalculateRewards } from "@stx-labs/signer-sidekick-protocol/pox5-calculate-rewards";
import { describe, expect, it, vi } from "vitest";
import type { ChainAnchor } from "./chain-anchor.js";
import { type RewardRealizationStore, syncRewardRealizations } from "./reward-realization-sync.js";
import type { StoredRewardCalculationRealization } from "./storage/store.js";

const manager = "SP000000000000000000002Q6VF78.signer-manager";
const pox5 = "SP000000000000000000002Q6VF78.pox-5";
// The block-read fallback deserializes the block the node serves, so the realization's
// transaction has to be a real one that a real block can carry.
const realizationTransaction = await makeSTXTokenTransfer({
  recipient: "ST000000000000000000002AMW42H",
  amount: 1n,
  senderKey: `${"11".repeat(32)}01`,
  nonce: 1n,
  fee: 1_000n,
  network: "testnet",
});
const txId = `0x${realizationTransaction.txid()}` as const;

/** A Nakamoto block (version 1 header, no signer signatures) carrying `realizationTransaction`. */
function canonicalBlockBytes(): Uint8Array {
  const body = realizationTransaction.serializeBytes();
  const bytes = new Uint8Array(206 + 4 + 2 + 4 + 1 + 4 + 4 + body.byteLength);
  const view = new DataView(bytes.buffer);
  bytes.fill(0xab, 0, 206);
  view.setUint8(0, 1); // header version 1
  let offset = 206;
  view.setUint32(offset, 0); // signer_signature count
  offset += 4;
  view.setUint16(offset, 8); // pox_treatment BitVec.len
  offset += 2;
  view.setUint32(offset, 1); // BitVec.data length
  offset += 4 + 1;
  view.setUint32(offset, 0); // problematic_txs count
  offset += 4;
  view.setUint32(offset, 1); // transaction count
  offset += 4;
  bytes.set(body, offset);
  return bytes;
}
const txBlockHash = `0x${"22".repeat(32)}` as const;
const txIndexHash = `0x${"33".repeat(32)}` as const;
const parentBlockHash = `0x${"44".repeat(32)}` as const;
const parentIndexHash = `0x${"55".repeat(32)}` as const;
const sourceId = "api:mainnet:reward-realization-test";
const observedAt = "2026-08-14T12:00:00.000Z";

const simulationInput = {
  grossAccruedRewardsSats: 1_000n,
  currentReserveBalanceSats: 100n,
  cycleStakedUstx: 1_000_000_000n,
  currentRewardsPerUstx: 0n,
  managerStxSharesUstx: 500_000_000n,
  bonds: [],
};
const simulation = simulatePox5CalculateRewards(simulationInput);

function eventHex(): string {
  return cvToHex(
    tupleCV({
      topic: stringAsciiCV("calculate-rewards"),
      "bond-periods": listCV([]),
      "calculation-height": uintCV(960_240),
      "gross-accrued-rewards": uintCV(simulation.grossAccruedRewardsSats),
      "total-bond-rewards": uintCV(simulation.totalBondRewardsSats),
      "reserve-deposit": uintCV(simulation.reserveDepositSats),
      "reserve-balance": uintCV(simulation.reserveBalanceSats),
      "stx-cycle": uintCV(141),
      "total-stx-staker-rewards": uintCV(simulation.totalStxStakerRewardsSats),
      "cycle-staked-ustx": uintCV(simulation.cycleStakedUstx),
      "accrued-rewards-per-ustx": uintCV(simulation.accruedRewardsPerUstx),
      "cumulative-rewards-per-ustx": uintCV(simulation.cumulativeRewardsPerUstx),
    }),
  );
}

function forecastAnchor(): ChainAnchor {
  return {
    stacksBlockHeight: 8_599_000,
    indexBlockHash: `0x${"66".repeat(32)}`,
    burnBlockHeight: 960_096,
    rewardCycle: 141,
    rewardCycleLength: 2_100,
    prepareCycleLength: 100,
    cyclePosition: 905,
    phase: "reward",
    checkpoint: "first-half",
  };
}

function storedRealization(
  reason: StoredRewardCalculationRealization["poolEstimateUnavailableReason"] = "same-block-state-ambiguous",
): StoredRewardCalculationRealization {
  return {
    chainId: 1,
    txId,
    eventIndex: 0,
    sourceId,
    managerPrincipal: manager,
    pox5ContractId: pox5,
    canonical: true,
    evidenceLevel: "node-index-verified",
    blockHeight: 8_600_002,
    indexBlockHash: txIndexHash,
    burnBlockHeight: 960_241,
    targetRewardCycle: 141,
    targetCheckpoint: "first-half",
    calculationBurnHeight: 960_240,
    event: {
      kind: "calculate-rewards",
      topic: "calculate-rewards",
      bondPeriods: [],
      calculationBurnHeight: "960240",
      grossAccruedRewardsSats: simulation.grossAccruedRewardsSats.toString(),
      totalBondRewardsSats: simulation.totalBondRewardsSats.toString(),
      reserveDepositSats: simulation.reserveDepositSats.toString(),
      reserveBalanceSats: simulation.reserveBalanceSats.toString(),
      rewardCycle: "141",
      totalStxStakerRewardsSats: simulation.totalStxStakerRewardsSats.toString(),
      cycleStakedUstx: simulation.cycleStakedUstx.toString(),
      accruedRewardsPerUstx: simulation.accruedRewardsPerUstx.toString(),
      cumulativeRewardsPerUstx: simulation.cumulativeRewardsPerUstx.toString(),
    },
    poolEstimate: null,
    poolEstimateUnavailableReason: reason,
    modelRevision: 1,
    evaluation: null,
    observedAt,
    updatedAt: observedAt,
  };
}

function store() {
  const putRewardCalculationRealizationPage = vi.fn();
  const putRewardCalculationRealization = vi.fn();
  return {
    value: {
      chainState: { getCursor: vi.fn().mockReturnValue(null) },
      putRewardCalculationRealizationPage,
      putRewardCalculationRealization,
      getRewardCalculationRealization: vi.fn().mockReturnValue(null),
      listRewardCalculationRealizations: vi.fn().mockReturnValue([]),
      markRewardRealizationNoncanonical: vi.fn().mockReturnValue(false),
      getRewardEvaluationForecast: vi.fn().mockReturnValue({
        managerPrincipal: manager,
        pox5ContractId: pox5,
        chainAnchor: forecastAnchor(),
        globalAccruedRewardsSats: "500",
        calculationState: "pending",
        lastRewardComputeBurnHeight: "959190",
        poolEstimate: null,
        poolEstimateUnavailableReason: "anchored-inputs-unavailable",
        forecast: {
          kind: "checkpoint-run-rate",
          targetRewardCycle: 141,
          targetCheckpoint: "first-half",
          calculationBurnHeight: 960_240,
          globalSats: { low: "900", point: "1000", high: "1100" },
          poolSats: { low: "420", point: "475", high: "522" },
          sample: {
            observations: 6,
            firstObservedBurnHeight: 960_072,
            lastObservedBurnHeight: 960_096,
            sampleBlocks: 24,
            elapsedBlocks: 906,
            remainingBlocks: 144,
          },
          confidence: "developing",
          assumptions: [
            "zero-accrual-after-last-calculation",
            "linear-global-accrual-run-rate",
            "current-cycle-shares",
            "current-active-bond-set",
            "unchanged-reserve-before-calculation",
            "contract-integer-rounding",
          ],
        },
        forecastModelRevision: 1,
        forecastUnavailableReason: null,
        nextCalculation: null,
        observedAt,
      }),
      rewardRealizationScanFloor: vi.fn().mockReturnValue(960_240),
    } satisfies RewardRealizationStore,
    putRewardCalculationRealizationPage,
    putRewardCalculationRealization,
  };
}

function environment(txIndex = 0, postManagerSharesUstx?: number) {
  const blockBytes = canonicalBlockBytes();
  const page = {
    limit: 100,
    offset: 0,
    total: 1,
    next_cursor: null,
    prev_cursor: null,
    cursor: null,
    results: [
      {
        event_index: 0,
        event_type: "smart_contract_log" as const,
        tx_id: txId,
        contract_log: {
          contract_id: pox5,
          topic: "print",
          value: { hex: eventHex(), repr: "(tuple ...)" },
        },
      },
    ],
  };
  const transaction = {
    tx_id: txId,
    status: "success" as const,
    block: {
      height: 8_600_002,
      hash: txBlockHash,
      index_hash: txIndexHash,
      time: 1,
      tx_index: txIndex,
    },
    bitcoin_block: { height: 960_241, time: 1 },
  };
  const node = {
    getInfo: vi.fn().mockResolvedValue({
      network_id: 1,
      burn_block_height: 960_241,
      stacks_tip_height: 8_600_002,
    }),
    getPoxInfo: vi.fn().mockResolvedValue({
      current_burnchain_block_height: 960_241,
      reward_cycle_id: 141,
      reward_cycle_length: 2_100,
      prepare_cycle_length: 100,
      contract_id: pox5,
      contract_versions: [],
      next_cycle: {
        id: 142,
        min_threshold_ustx: 0,
        min_increment_ustx: 0,
        stacked_ustx: 0,
        prepare_phase_start_block_height: 961_191,
        blocks_until_prepare_phase: 950,
        reward_phase_start_block_height: 961_291,
        blocks_until_reward_phase: 1_050,
      },
    }),
    getTenureInfo: vi.fn().mockResolvedValue({
      tip_block_id: `0x${"99".repeat(32)}`,
      tip_height: 8_700_000,
      reward_cycle: 141,
    }),
    getNakamotoBlockById: vi.fn().mockResolvedValue(blockBytes),
    getNakamotoBlockAtHeight: vi.fn().mockResolvedValue(blockBytes),
    callReadOnly: vi.fn(
      async (
        _contract: string,
        functionName: string,
        _sender: string,
        args: readonly string[],
        options?: { tip?: string },
      ) => {
        if (functionName === "bond-period-to-reward-cycle") return uintCV(1_000);
        if (functionName === "get-reserve-balance") return uintCV(100);
        if (functionName === "get-total-shares-staked-for-cycle") return uintCV(1_000_000_000);
        if (functionName === "get-rewards-per-token-for-cycle") return uintCV(0);
        if (functionName === "get-signer-shares-staked-for-cycle") {
          return uintCV(
            options?.tip === txIndexHash && postManagerSharesUstx !== undefined
              ? postManagerSharesUstx
              : 500_000_000,
          );
        }
        if (functionName === "get-protocol-bond") return noneCV();
        if (functionName === "is-bond-active-at-height") return falseCV();
        throw new Error(`Unexpected read ${functionName} ${args.join(",")}`);
      },
    ),
  };
  return {
    api: {
      getSmartContractLogs: vi.fn().mockResolvedValue(page),
      getTransaction: vi.fn().mockResolvedValue(transaction),
      getBlock: vi.fn(async (hash: string | number) =>
        hash === txIndexHash
          ? {
              canonical: true,
              height: 8_600_002,
              hash: txBlockHash,
              index_block_hash: txIndexHash,
              parent_block_hash: parentBlockHash,
              parent_index_block_hash: parentIndexHash,
              burn_block_height: 960_241,
            }
          : {
              canonical: true,
              height: 8_600_001,
              hash: parentBlockHash,
              index_block_hash: parentIndexHash,
              parent_block_hash: `0x${"77".repeat(32)}` as const,
              parent_index_block_hash: `0x${"88".repeat(32)}` as const,
              burn_block_height: 960_241,
            },
      ),
    },
    node,
    nodeBlocks: node,
    nodeTransactions: {
      lookupIndexedTransaction: vi.fn().mockResolvedValue({
        status: "observed",
        httpStatus: 200,
        value: {
          txid: txId,
          transactionHex: "00",
          nonce: 0n,
          feeUstx: 0n,
          indexBlockHash: txIndexHash,
          blockHeight: 8_600_002n,
          isCanonical: true,
          resultRepr: "(ok true)",
        },
      }),
    },
  };
}

describe("PoX-5 reward realization synchronization", () => {
  it("fails closed when the API repeats a pagination cursor", async () => {
    const repository = store();
    const runtime = environment();
    const repeatedPage = await runtime.api.getSmartContractLogs(pox5, null, 100);
    runtime.api.getSmartContractLogs.mockResolvedValue({
      ...repeatedPage,
      prev_cursor: "repeat",
    });

    await expect(
      syncRewardRealizations({
        store: repository.value,
        ...runtime,
        sourceId,
        chainId: 1,
        managerPrincipal: manager,
        pox5ContractId: pox5,
        observedAt,
      }),
    ).rejects.toThrow("did not advance cursor repeat");
  });

  it("persists a node-verified exact pool realization and fixed-horizon evaluation", async () => {
    const repository = store();
    const runtime = environment();
    await expect(
      syncRewardRealizations({
        store: repository.value,
        ...runtime,
        sourceId,
        chainId: 1,
        managerPrincipal: manager,
        pox5ContractId: pox5,
        observedAt,
      }),
    ).resolves.toMatchObject({
      caughtUp: true,
      calculationsFound: 1,
      realizationsStored: 1,
      evaluationsStored: 1,
    });
    const realization = repository.putRewardCalculationRealizationPage.mock.calls[0]?.[0]?.[0];
    expect(realization).toMatchObject({
      canonical: true,
      evidenceLevel: "node-index-verified",
      targetRewardCycle: 141,
      targetCheckpoint: "first-half",
      calculationBurnHeight: 960_240,
      poolEstimate: { grossSats: simulation.manager?.grossRewardSats.toString() },
      poolEstimateUnavailableReason: null,
      evaluation: { leadBlocks: 144, rangeContainsActual: true },
    });
  });

  it("recovers an emitted reward fact without prior forecasts or historical node state", async () => {
    const repository = store();
    repository.value.rewardRealizationScanFloor.mockReturnValue(null);
    repository.value.getRewardEvaluationForecast.mockReturnValue(null);
    const runtime = environment();
    runtime.nodeTransactions.lookupIndexedTransaction.mockResolvedValue({
      status: "not-found",
      httpStatus: 404,
    });
    runtime.node.getPoxInfo.mockImplementation(async (options?: { tip?: string }) => {
      if (options?.tip) throw new Error("historical chainstate pruned");
      return {
        first_burnchain_block_height: 663_091,
        current_burnchain_block_height: 960_241,
        reward_cycle_id: 141,
        reward_cycle_length: 2_100,
        prepare_cycle_length: 100,
        contract_id: pox5,
        contract_versions: [
          {
            contract_id: pox5,
            activation_burnchain_block_height: 960_230,
            first_reward_cycle_id: 141,
          },
        ],
      };
    });
    const blockBytes = canonicalBlockBytes();
    const nodeBlocks = {
      getTenureInfo: vi.fn().mockResolvedValue({
        tip_block_id: `0x${"99".repeat(32)}` as `0x${string}`,
        tip_height: 8_700_000,
        reward_cycle: 141,
      }),
      getNakamotoBlockById: vi.fn().mockResolvedValue(blockBytes),
      getNakamotoBlockAtHeight: vi.fn().mockResolvedValue(blockBytes),
    };

    await expect(
      syncRewardRealizations({
        store: repository.value,
        ...runtime,
        nodeBlocks,
        sourceId,
        chainId: 1,
        managerPrincipal: manager,
        pox5ContractId: pox5,
        observedAt,
      }),
    ).resolves.toMatchObject({
      skippedReason: null,
      calculationsFound: 1,
      realizationsStored: 1,
      caughtUp: true,
    });
    expect(repository.putRewardCalculationRealizationPage.mock.calls[0]?.[0]?.[0]).toMatchObject({
      canonical: true,
      evidenceLevel: "canonical-block-correlated",
      targetCheckpoint: "first-half",
      poolEstimate: null,
      poolEstimateUnavailableReason: "historical-anchor-unavailable",
      evaluation: null,
    });
  });

  it("accepts a later-block transaction when parent and post-state prove stable manager shares", async () => {
    const repository = store();
    const runtime = environment(3);
    await syncRewardRealizations({
      store: repository.value,
      ...runtime,
      sourceId,
      chainId: 1,
      managerPrincipal: manager,
      pox5ContractId: pox5,
      observedAt,
    });
    expect(repository.putRewardCalculationRealizationPage.mock.calls[0]?.[0]?.[0]).toMatchObject({
      poolEstimate: { grossSats: simulation.manager?.grossRewardSats.toString() },
      poolEstimateUnavailableReason: null,
      evaluation: { leadBlocks: 144, rangeContainsActual: true },
    });
  });

  it("refuses pool attribution when the manager allocation is not stable across the block", async () => {
    const repository = store();
    const runtime = environment(3, 400_000_000);
    await syncRewardRealizations({
      store: repository.value,
      ...runtime,
      sourceId,
      chainId: 1,
      managerPrincipal: manager,
      pox5ContractId: pox5,
      observedAt,
    });
    expect(repository.putRewardCalculationRealizationPage.mock.calls[0]?.[0]?.[0]).toMatchObject({
      poolEstimate: null,
      poolEstimateUnavailableReason: "same-block-state-ambiguous",
      evaluation: null,
    });
  });

  it("invalidates an orphaned realization even when it has disappeared from the API feed", async () => {
    const repository = store();
    const runtime = environment();
    repository.value.listRewardCalculationRealizations.mockReturnValue([storedRealization()]);
    repository.value.markRewardRealizationNoncanonical.mockReturnValue(true);
    runtime.nodeTransactions.lookupIndexedTransaction.mockResolvedValue({
      status: "not-found",
      httpStatus: 404,
    });
    const orphanedBlock = canonicalBlockBytes();
    orphanedBlock[orphanedBlock.length - 1] ^= 0xff;
    runtime.nodeBlocks.getNakamotoBlockAtHeight.mockResolvedValue(orphanedBlock);
    runtime.api.getSmartContractLogs.mockResolvedValue({
      limit: 100,
      offset: 0,
      total: 0,
      next_cursor: null,
      prev_cursor: null,
      cursor: null,
      results: [],
    });

    await expect(
      syncRewardRealizations({
        store: repository.value,
        ...runtime,
        sourceId,
        chainId: 1,
        managerPrincipal: manager,
        pox5ContractId: pox5,
        observedAt,
      }),
    ).resolves.toMatchObject({ noncanonicalRealizations: 1, calculationsFound: 0 });
    expect(repository.value.markRewardRealizationNoncanonical).toHaveBeenCalledWith({
      chainId: 1,
      txId,
      eventIndex: 0,
      updatedAt: observedAt,
    });
  });

  it("preserves a realization when its required canonical-block witness is unavailable", async () => {
    const repository = store();
    const runtime = environment();
    repository.value.listRewardCalculationRealizations.mockReturnValue([storedRealization()]);
    runtime.nodeTransactions.lookupIndexedTransaction.mockResolvedValue({
      status: "unavailable",
      httpStatus: 501,
      reason: "transaction-index-unavailable",
    });
    runtime.nodeBlocks.getNakamotoBlockById.mockRejectedValue(
      new Error("canonical block witness unavailable"),
    );

    await expect(
      syncRewardRealizations({
        store: repository.value,
        ...runtime,
        sourceId,
        chainId: 1,
        managerPrincipal: manager,
        pox5ContractId: pox5,
        observedAt,
      }),
    ).rejects.toThrow("canonical block witness unavailable");
    expect(repository.value.markRewardRealizationNoncanonical).not.toHaveBeenCalled();
  });

  it("retries a canonical realization whose anchored pool reads were temporarily unavailable", async () => {
    const repository = store();
    const runtime = environment();
    const unresolved = storedRealization("anchored-inputs-unavailable");
    repository.value.listRewardCalculationRealizations.mockReturnValue([unresolved]);
    repository.value.getRewardCalculationRealization.mockReturnValue(unresolved);
    runtime.api.getSmartContractLogs.mockResolvedValue({
      limit: 100,
      offset: 0,
      total: 0,
      next_cursor: null,
      prev_cursor: null,
      cursor: null,
      results: [],
    });

    await expect(
      syncRewardRealizations({
        store: repository.value,
        ...runtime,
        sourceId,
        chainId: 1,
        managerPrincipal: manager,
        pox5ContractId: pox5,
        observedAt,
      }),
    ).resolves.toMatchObject({ realizationsStored: 1, evaluationsStored: 1 });
    expect(repository.putRewardCalculationRealization).toHaveBeenCalledWith(
      expect.objectContaining({
        poolEstimateUnavailableReason: null,
        evaluation: expect.objectContaining({ leadBlocks: 144, rangeContainsActual: true }),
      }),
    );
  });

  it("does not advance the durable cursor past an undecodable calculation event", async () => {
    const repository = store();
    const runtime = environment();
    const page = await runtime.api.getSmartContractLogs(pox5, null, 100);
    const calculation = page.results[0];
    if (!calculation) throw new Error("Reward realization fixture is missing its calculation");
    calculation.contract_log.value.hex = cvToHex(
      tupleCV({
        topic: stringAsciiCV("calculate-rewards"),
        "bond-periods": listCV([]),
      }),
    );

    await expect(
      syncRewardRealizations({
        store: repository.value,
        ...runtime,
        sourceId,
        chainId: 1,
        managerPrincipal: manager,
        pox5ContractId: pox5,
        observedAt,
      }),
    ).rejects.toThrow("could not decode");
    expect(repository.putRewardCalculationRealizationPage).not.toHaveBeenCalled();
  });
});
