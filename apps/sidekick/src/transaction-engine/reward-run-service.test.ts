import { getAddressFromPublicKey, privateKeyToPublic } from "@stacks/transactions";
import type { GasWalletRefusal, RewardRun } from "@stx-labs/signer-sidekick-api-contracts";
import { planRewardOperation } from "@stx-labs/signer-sidekick-protocol/reward-operation-plan";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openSidekickStore, type SidekickStore } from "../storage/store.js";
import type { SignedRewardOperationTransaction } from "./gas-payer-signer.js";
import {
  buildRewardRunRecipe,
  type RewardRunDraftFacts,
  type RewardRunDriver,
  RewardRunService,
  type RewardRunSigner,
} from "./reward-run-service.js";

const publicKey = privateKeyToPublic(`${"11".repeat(32)}01`);
const wallet = getAddressFromPublicKey(publicKey, "testnet");
const manager = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.signer-manager";
const pox5 = "ST000000000000000000002AMW42H.pox-5";
const sbtc = "SN3VMHXEN64ZZF71JQ5VESXDWTR301XTTXGF4J8F1.sbtc-token";
const registry = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.sbtc-registry";
const stakerOne = "ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG";
const stakerTwo = "ST1SJ3DTE5DN7X54YDH5D64R3BCB6A2AG2ZQ8YPD5";
const started = new Date("2026-08-22T12:00:00.000Z");
const goodRefusal: GasWalletRefusal = {
  checkedAt: started.toISOString(),
  isManagerAdmin: false,
  isSignerKey: false,
  isContract: false,
  refusalReason: null,
};

function facts(): RewardRunDraftFacts {
  return {
    walletPrincipal: wallet,
    managerPrincipal: manager,
    pox5Contract: pox5,
    sbtcTokenContract: sbtc,
    sbtcRegistryContract: registry,
    network: "testnet",
    chainId: 0x8000_0005,
    cycle: 141,
    distribution: 1,
    preparedAnchor: {
      stacksBlockHeight: 9_000,
      burnBlockHeight: 4_100,
      indexBlockHash: `0x${"ab".repeat(32)}`,
    },
    managerSourceFingerprint: "12".repeat(32),
    pox5SourceFingerprint: "34".repeat(32),
    calculateRequired: false,
    collectRequired: true,
    maximumCollectSats: "20000",
    eligibleAccountCount: 2,
    eligibleWithdrawalCounts: { accepted: 0, rejected: 0 },
    accounts: [
      {
        stakerPrincipal: stakerTwo,
        rewardCycle: 141,
        bondIndex: null,
        maximumGrossSats: "10000",
        payoutRoute: "direct-sbtc",
      },
      {
        stakerPrincipal: stakerOne,
        rewardCycle: 141,
        bondIndex: "2",
        maximumGrossSats: "10000",
        payoutRoute: "bitcoin-l1",
      },
    ],
    withdrawals: [],
  };
}

function signed(
  plan: Awaited<ReturnType<typeof planRewardOperation>>,
): SignedRewardOperationTransaction {
  return {
    kind: "signed-reward-operation",
    operationKind: plan.material.kind,
    planSha256: plan.planSha256,
    unsignedTransactionSha256: plan.unsignedTransactionSha256,
    precomputedTxid: `0x${plan.material.transaction.nonce.padStart(64, "0")}`,
    nonce: plan.material.transaction.nonce,
    fee: plan.material.transaction.feeUstx,
    signedTransactionBytes: new Uint8Array([1]),
    toJSON: () => ({}),
  } as unknown as SignedRewardOperationTransaction;
}

function signer(): RewardRunSigner {
  const sign = async (plan: Awaited<ReturnType<typeof planRewardOperation>>) => signed(plan);
  return {
    gasWalletSignerReady: () => true,
    signPox5CalculateRewardsPlan: sign,
    signManagerClaimRewardsRunPlan: sign,
    signClaimStakerRewardsPlan: sign,
    signSettleAcceptedWithdrawalPlan: sign,
    signReclaimFailedWithdrawalPlan: sign,
  };
}

function driver(
  options: {
    reconcile?: "confirmed" | "pending" | "halt";
    broadcast?: "accepted" | "ambiguous" | "deterministic-rejection";
  } = {},
) {
  const materialized: string[] = [];
  const broadcasts: string[] = [];
  const implementation: RewardRunDriver = {
    async materialize({ run, child }) {
      materialized.push(child.operation);
      const recipeChild = run.recipe.children[child.index];
      if (!recipeChild || recipeChild.maximumAmountSats === null) {
        throw new Error("Test driver expected a bounded collect or payment child");
      }
      const common = {
        authorization: {
          schemaVersion: 2 as const,
          kind: "operator-run" as const,
          runId: run.runId,
          recipeSha256: run.recipeSha256,
        },
        network: { kind: "testnet" as const, chainId: 0x8000_0005 },
        chainAnchor: run.recipe.preparedAnchor,
        sender: { principal: wallet, publicKey },
        managerSourceFingerprint: run.recipe.managerSourceFingerprint,
        nonce: BigInt(child.index + 1),
        feeUstx: 500n,
      };
      const plan =
        child.operation === "claim-rewards"
          ? await planRewardOperation({
              ...common,
              kind: "claim-rewards",
              managerContract: manager,
              pox5Contract: pox5,
              sbtcTokenContract: sbtc,
              rewardCycle: 141n,
              bondPeriods: [2n],
              expectedSbtcOutflow: BigInt(recipeChild.maximumAmountSats),
            })
          : await (async () => {
              const account = run.recipe.accounts.find(
                ({ accountKey }) => accountKey === recipeChild.accountKey,
              );
              if (!recipeChild.stakerPrincipal || !account) {
                throw new Error("Test payment child is missing its bound account");
              }
              return await planRewardOperation({
                ...common,
                kind: "claim-staker-rewards",
                managerContract: manager,
                sbtcTokenContract: sbtc,
                stakerPrincipal: recipeChild.stakerPrincipal,
                rewardCycle: 141n,
                bondIndex: (recipeChild.accountKey?.endsWith(":stx") ?? true) ? null : BigInt("2"),
                payoutRoute: account.payoutRoute,
                grossSats: BigInt(recipeChild.maximumAmountSats),
                feeSats: 500n,
                expectedNetSats: BigInt(recipeChild.maximumAmountSats) - 500n,
              });
            })();
      return { status: "plan", plan, amountSats: recipeChild.maximumAmountSats };
    },
    async reconcile() {
      if (options.reconcile === "pending") return { status: "pending" };
      if (options.reconcile === "halt") {
        return { status: "halt", reason: "The preparation anchor became noncanonical" };
      }
      return { status: "confirmed", blockHeight: 9_001 };
    },
    async broadcast(attempt) {
      broadcasts.push(attempt.operationKind);
      return options.broadcast === "ambiguous"
        ? {
            status: "ambiguous",
            txid: attempt.precomputedTxid,
            httpStatus: null,
            reason: "timeout",
          }
        : options.broadcast === "deterministic-rejection"
          ? {
              status: "deterministic-rejection",
              txid: attempt.precomputedTxid,
              httpStatus: 400,
              nodeError: "BadNonce",
              nodeReason: "BadNonce",
              nodeMessage: "bad nonce",
            }
          : { status: "accepted", txid: attempt.precomputedTxid, httpStatus: 200 };
    },
  };
  return { implementation, materialized, broadcasts };
}

async function settle(service: RewardRunService, runId: string, limit = 20): Promise<RewardRun> {
  for (let index = 0; index < limit; index += 1) {
    await service.recover();
    const run = service.get(runId);
    if (["completed", "halted", "cancelled", "expired"].includes(run.status)) return run;
  }
  return service.get(runId);
}

describe("reward run coordinator", () => {
  const stores: SidekickStore[] = [];
  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
  });

  it("seals the exact account universe while keeping the full collect bound", () => {
    const recipe = buildRewardRunRecipe({
      runId: "00000000-0000-4000-8000-000000000001",
      facts: facts(),
      request: { cycle: 141, distribution: 1, maxTransactions: 2 },
      feeCapUstx: 1_000n,
      maximumTransactions: 200,
    });
    expect(recipe.children.map(({ operation }) => operation)).toEqual([
      "claim-rewards",
      "claim-staker-rewards",
    ]);
    expect(recipe.children[0]?.maximumAmountSats).toBe("20000");
    expect(recipe.accounts).toHaveLength(1);
    expect(recipe.reviewedTotalSats).toBe("10000");
    expect(recipe.gasBudgetUstx).toBe("2000");
    expect(recipe).toMatchObject({
      eligibleTransactions: 3,
      truncated: true,
      remainingTransactions: 1,
    });
  });

  it("seals no amount for retirement and the exact refund ceiling for reclaim", () => {
    const withWithdrawals: RewardRunDraftFacts = {
      ...facts(),
      calculateRequired: false,
      collectRequired: false,
      maximumCollectSats: null,
      eligibleAccountCount: 0,
      eligibleWithdrawalCounts: { accepted: 1, rejected: 1 },
      accounts: [],
      withdrawals: [
        {
          requestId: "4",
          stakerPrincipal: stakerOne,
          state: "accepted",
          maximumAmountSats: "1100",
          withdrawalAmountSats: "1000",
          maxFeeSats: "100",
        },
        {
          requestId: "5",
          stakerPrincipal: stakerTwo,
          state: "rejected",
          maximumAmountSats: "2200",
          withdrawalAmountSats: "2000",
          maxFeeSats: "200",
        },
      ],
    };
    const recipe = buildRewardRunRecipe({
      runId: "00000000-0000-4000-8000-000000000004",
      facts: withWithdrawals,
      request: {
        cycle: 141,
        distribution: 1,
        operations: ["settle-accepted-withdrawal", "reclaim-failed-withdrawal"],
      },
      feeCapUstx: 1_000n,
      maximumTransactions: 200,
    });
    expect(
      recipe.children.map(({ operation, maximumAmountSats }) => ({
        operation,
        maximumAmountSats,
      })),
    ).toEqual([
      { operation: "settle-accepted-withdrawal", maximumAmountSats: null },
      { operation: "reclaim-failed-withdrawal", maximumAmountSats: "2200" },
    ]);
    expect(recipe).toMatchObject({
      eligibleTransactions: 2,
      truncated: false,
      remainingTransactions: 0,
    });
  });

  it("runs collect then each payment sequentially and survives background-only progress", async () => {
    const { store } = await openSidekickStore(":memory:", started.toISOString());
    stores.push(store);
    const live = driver();
    const refusalChecks = vi.fn(async () => goodRefusal);
    const service = new RewardRunService({
      repository: store.rewardRuns,
      signer: signer(),
      driver: live.implementation,
      facts: async () => facts(),
      refusalChecks,
      maximumFeeUstx: 1_000n,
      now: () => started,
    });
    const prepared = await service.prepare({ cycle: 141, distribution: 1 });
    expect(prepared.status).toBe("awaiting-approval");
    await service.approve(prepared.runId, prepared.recipeSha256);
    const completed = await settle(service, prepared.runId);

    expect(completed).toMatchObject({
      status: "completed",
      cursor: 3,
      gasSpentUstx: "1500",
      progress: { completed: 3, total: 3, inFlight: 0 },
    });
    expect(live.materialized).toEqual([
      "claim-rewards",
      "claim-staker-rewards",
      "claim-staker-rewards",
    ]);
    expect(live.broadcasts).toEqual(live.materialized);
    expect(refusalChecks).toHaveBeenCalledTimes(4);
    expect(store.rewardRuns.active(wallet)).toBeNull();
  });

  it("enforces emergency controls before preparation and again at the signature boundary", async () => {
    const { store } = await openSidekickStore(":memory:", started.toISOString());
    stores.push(store);
    const live = driver();
    let blocked = true;
    const readFacts = vi.fn(async () => facts());
    const executionControl = vi.fn((operations: readonly string[]) => ({
      allowed: !blocked,
      reason: blocked ? `Execution is disabled for ${operations.join(",")}` : null,
    }));
    const service = new RewardRunService({
      repository: store.rewardRuns,
      signer: signer(),
      driver: {
        ...live.implementation,
        async materialize(input) {
          const materialized = await live.implementation.materialize(input);
          blocked = true;
          return materialized;
        },
      },
      facts: readFacts,
      refusalChecks: async () => goodRefusal,
      executionControl,
      maximumFeeUstx: 1_000n,
      now: () => started,
    });

    await expect(
      service.prepare({ cycle: 141, distribution: 1, operations: ["claim-rewards"] }),
    ).rejects.toMatchObject({
      code: "reward_run_unavailable",
      message: "Execution is disabled for claim-rewards",
    });
    expect(readFacts).not.toHaveBeenCalled();

    blocked = false;
    const prepared = await service.prepare({
      cycle: 141,
      distribution: 1,
      operations: ["claim-rewards"],
    });
    await service.approve(prepared.runId, prepared.recipeSha256);
    const halted = await settle(service, prepared.runId);
    expect(halted).toMatchObject({
      status: "halted",
      cursor: 0,
      failureReason: "Execution is disabled for claim-rewards",
    });
    expect(live.materialized).toEqual(["claim-rewards"]);
    expect(live.broadcasts).toEqual([]);
  });

  it("reuses the same rejected attempt when an explicit resume rebuilds identical bytes", async () => {
    const { store } = await openSidekickStore(":memory:", started.toISOString());
    stores.push(store);
    const rejected = driver({ broadcast: "deterministic-rejection" });
    const service = new RewardRunService({
      repository: store.rewardRuns,
      signer: signer(),
      driver: rejected.implementation,
      facts: async () => facts(),
      refusalChecks: async () => goodRefusal,
      maximumFeeUstx: 1_000n,
      now: () => started,
    });
    const prepared = await service.prepare({
      cycle: 141,
      distribution: 1,
      operations: ["claim-rewards"],
    });
    await service.approve(prepared.runId, prepared.recipeSha256);
    expect((await settle(service, prepared.runId)).status).toBe("halted");
    expect(store.rewardRuns.attempts(prepared.runId, 0)).toHaveLength(1);

    service.resume(prepared.runId);
    expect((await settle(service, prepared.runId)).status).toBe("halted");
    expect(rejected.broadcasts).toHaveLength(2);
    expect(store.rewardRuns.attempts(prepared.runId, 0)).toMatchObject([
      { attemptIndex: 0, state: "rejected" },
    ]);
  });

  it("returns the original run for an idempotent preparation retry", async () => {
    const { store } = await openSidekickStore(":memory:", started.toISOString());
    stores.push(store);
    const readFacts = vi.fn(async () => facts());
    const service = new RewardRunService({
      repository: store.rewardRuns,
      signer: signer(),
      driver: driver().implementation,
      facts: readFacts,
      refusalChecks: async () => goodRefusal,
      maximumFeeUstx: 1_000n,
      now: () => started,
    });
    const request = {
      requestId: "00000000-0000-4000-8000-000000000099",
      cycle: 141,
      distribution: 1 as const,
      operations: ["claim-rewards" as const],
    };
    const first = await service.prepare(request);
    const retried = await service.prepare(request);
    expect(retried).toEqual(first);
    expect(readFacts).toHaveBeenCalledTimes(1);
    await expect(
      service.prepare({ ...request, operations: ["calculate-rewards"] }),
    ).rejects.toMatchObject({ code: "reward_run_conflict" });
  });

  it("collapses concurrent preparation and approval retries onto one run", async () => {
    const { store } = await openSidekickStore(":memory:", started.toISOString());
    stores.push(store);
    const service = new RewardRunService({
      repository: store.rewardRuns,
      signer: signer(),
      driver: driver({ reconcile: "pending" }).implementation,
      facts: async () => {
        await Promise.resolve();
        return facts();
      },
      refusalChecks: async () => {
        await Promise.resolve();
        return goodRefusal;
      },
      maximumFeeUstx: 1_000n,
      now: () => started,
    });
    const request = {
      requestId: "00000000-0000-4000-8000-000000000098",
      cycle: 141,
      distribution: 1 as const,
      operations: ["claim-rewards" as const],
    };
    const [first, second] = await Promise.all([service.prepare(request), service.prepare(request)]);
    expect(second.runId).toBe(first.runId);
    const approvals = await Promise.all([
      service.approve(first.runId, first.recipeSha256),
      service.approve(first.runId, first.recipeSha256),
    ]);
    expect(approvals.every(({ runId }) => runId === first.runId)).toBe(true);
    await service.recover();
    service.stop();
  });

  it("recovers a broadcast child after restart without signing or broadcasting it again", async () => {
    const { store } = await openSidekickStore(":memory:", started.toISOString());
    stores.push(store);
    const pending = driver({ reconcile: "pending" });
    const first = new RewardRunService({
      repository: store.rewardRuns,
      signer: signer(),
      driver: pending.implementation,
      facts: async () => facts(),
      refusalChecks: async () => goodRefusal,
      maximumFeeUstx: 1_000n,
      now: () => started,
    });
    const prepared = await first.prepare({
      cycle: 141,
      distribution: 1,
      operations: ["claim-rewards"],
    });
    await first.approve(prepared.runId, prepared.recipeSha256);
    await first.recover();
    expect(first.get(prepared.runId)).toMatchObject({
      status: "running",
      progress: { inFlight: 1 },
    });
    expect(pending.broadcasts).toHaveLength(1);
    first.stop();

    const recovered = driver();
    const second = new RewardRunService({
      repository: store.rewardRuns,
      signer: signer(),
      driver: recovered.implementation,
      facts: async () => facts(),
      refusalChecks: async () => goodRefusal,
      maximumFeeUstx: 1_000n,
      now: () => started,
    });
    const complete = await settle(second, prepared.runId);
    expect(complete.status).toBe("completed");
    expect(recovered.materialized).toEqual([]);
    expect(recovered.broadcasts).toEqual([]);
  });

  it("halts without advancing when reconciliation detects a reorg", async () => {
    const { store } = await openSidekickStore(":memory:", started.toISOString());
    stores.push(store);
    const reorg = driver({ reconcile: "halt" });
    const service = new RewardRunService({
      repository: store.rewardRuns,
      signer: signer(),
      driver: reorg.implementation,
      facts: async () => facts(),
      refusalChecks: async () => goodRefusal,
      maximumFeeUstx: 1_000n,
      now: () => started,
    });
    const prepared = await service.prepare({
      cycle: 141,
      distribution: 1,
      operations: ["claim-rewards"],
    });
    await service.approve(prepared.runId, prepared.recipeSha256);
    const halted = await settle(service, prepared.runId);
    expect(halted).toMatchObject({
      status: "halted",
      cursor: 0,
      progress: { completed: 0, inFlight: 1 },
      failureReason: "The preparation anchor became noncanonical",
    });
    expect(reorg.broadcasts).toHaveLength(1);
  });

  it("halts an ambiguous broadcast and only reconciles it after explicit resume", async () => {
    const { store } = await openSidekickStore(":memory:", started.toISOString());
    stores.push(store);
    const ambiguous = driver({ broadcast: "ambiguous", reconcile: "pending" });
    const service = new RewardRunService({
      repository: store.rewardRuns,
      signer: signer(),
      driver: ambiguous.implementation,
      facts: async () => facts(),
      refusalChecks: async () => goodRefusal,
      maximumFeeUstx: 1_000n,
      now: () => started,
    });
    const prepared = await service.prepare({
      cycle: 141,
      distribution: 1,
      operations: ["claim-rewards"],
    });
    await service.approve(prepared.runId, prepared.recipeSha256);
    const halted = await settle(service, prepared.runId);
    expect(halted).toMatchObject({ status: "halted", progress: { inFlight: 1 } });
    expect(ambiguous.broadcasts).toHaveLength(1);
    await service.recover();
    expect(service.get(prepared.runId).status).toBe("halted");
    service.resume(prepared.runId);
    await service.recover();
    expect(service.get(prepared.runId).status).toBe("running");
    expect(ambiguous.broadcasts).toHaveLength(1);
  });

  it("expires a halted run at its runtime deadline and releases the wallet lease", async () => {
    const { store } = await openSidekickStore(":memory:", started.toISOString());
    stores.push(store);
    let now = started;
    const ambiguous = driver({ broadcast: "ambiguous", reconcile: "pending" });
    const service = new RewardRunService({
      repository: store.rewardRuns,
      signer: signer(),
      driver: ambiguous.implementation,
      facts: async () => facts(),
      refusalChecks: async () => goodRefusal,
      maximumFeeUstx: 1_000n,
      now: () => now,
    });
    const prepared = await service.prepare({
      cycle: 141,
      distribution: 1,
      operations: ["claim-rewards"],
    });
    await service.approve(prepared.runId, prepared.recipeSha256);
    expect((await settle(service, prepared.runId)).status).toBe("halted");
    now = new Date("2026-08-22T18:01:00.000Z");
    await expect(async () => service.resume(prepared.runId)).rejects.toMatchObject({
      code: "reward_run_expired",
    });
    expect(service.get(prepared.runId).status).toBe("expired");
    expect(store.rewardRuns.active(wallet)).toBeNull();
  });

  it("expires unused approvals and refuses a changed dedicated-wallet role", async () => {
    const { store } = await openSidekickStore(":memory:", started.toISOString());
    stores.push(store);
    let now = started;
    const service = new RewardRunService({
      repository: store.rewardRuns,
      signer: signer(),
      driver: driver().implementation,
      facts: async () => facts(),
      refusalChecks: vi.fn(async () => ({
        ...goodRefusal,
        refusalReason: "manager-admin" as const,
      })),
      maximumFeeUstx: 1_000n,
      now: () => now,
    });
    const refused = await service.prepare({ cycle: 141, distribution: 1 });
    await expect(service.approve(refused.runId, refused.recipeSha256)).rejects.toMatchObject({
      code: "reward_run_refused",
    });
    service.cancel(refused.runId);

    const expiring = await service.prepare({ cycle: 141, distribution: 1 });
    now = new Date("2026-08-22T12:31:00.000Z");
    await expect(service.approve(expiring.runId, expiring.recipeSha256)).rejects.toMatchObject({
      code: "reward_run_expired",
    });
    expect(service.get(expiring.runId).status).toBe("expired");
  });
});
