import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getAddressFromPublicKey, privateKeyToPublic } from "@stacks/transactions";
import type {
  ConnectionAssessment,
  GasWalletRefusal,
  RewardRun,
} from "@stx-labs/signer-sidekick-api-contracts";
import { planRewardOperation } from "@stx-labs/signer-sidekick-protocol/reward-operation-plan";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChainAnchorError,
  RateLimitedError,
  UpstreamSchemaError,
  UpstreamUnavailableError,
} from "../chain-clients.js";
import { requireConnectedAssessment } from "../connection-assessment.js";
import { currentInteractiveRequestSignal } from "../request-context.js";
import { RewardScheduleService } from "../reward-schedule.js";
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
    chainId: 0x8000_0000,
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
    nonce?: () => bigint;
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
        network: { kind: "testnet" as const, chainId: 0x8000_0000 },
        chainAnchor: run.recipe.preparedAnchor,
        sender: { principal: wallet, publicKey },
        managerSourceFingerprint: run.recipe.managerSourceFingerprint,
        nonce: options.nonce?.() ?? BigInt(child.index + 1),
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
  const directories: string[] = [];
  afterEach(async () => {
    for (const store of stores.splice(0)) store.close();
    for (const directory of directories.splice(0))
      await rm(directory, { recursive: true, force: true });
  });

  it("executes scheduled collect and bounded payout chunks for both distributions through the unchanged engine", async () => {
    const { store } = await openSidekickStore(":memory:", started.toISOString());
    stores.push(store);
    let nonce = 0n;
    let distribution: 1 | 2 = 1;
    let collected = false;
    let remaining = facts().accounts;
    let finished = false;
    const live = driver({ nonce: () => ++nonce });
    const service = new RewardRunService({
      repository: store.rewardRuns,
      signer: signer(),
      driver: {
        ...live.implementation,
        async reconcile(input) {
          if (input.child.operation === "claim-rewards") collected = true;
          else {
            remaining = remaining.filter(
              (account) =>
                `${account.stakerPrincipal}:${account.rewardCycle}:${account.bondIndex ?? "stx"}` !==
                input.child.accountKey,
            );
            if (remaining.length === 0) {
              if (distribution === 1) {
                distribution = 2;
                collected = false;
                remaining = facts().accounts;
              } else finished = true;
            }
          }
          return { status: "confirmed", blockHeight: 9001 };
        },
      },
      facts: async () => ({
        ...facts(),
        distribution,
        collectRequired: !collected,
        accounts: collected ? remaining : [],
        eligibleAccountCount: collected ? remaining.length : 0,
      }),
      refusalChecks: async () => goodRefusal,
      maximumTransactions: 1,
      maximumFeeUstx: 1000n,
      now: () => started,
    });
    const schedule = new RewardScheduleService({
      repository: store.rewardSchedule,
      runs: service,
      identity: () => "testnet:manager:wallet",
      unavailable: () => null,
      walletBusy: () => false,
      now: () => started,
      select: async () => ({
        beforeCycle: null,
        request: finished
          ? null
          : {
              cycle: 141,
              distribution,
              operations: [collected ? "claim-staker-rewards" : "claim-rewards"],
            },
      }),
    });
    try {
      schedule.configure({ enabled: true, intervalMinutes: 15, revision: 0 });
      await vi.waitFor(
        async () => {
          await schedule.tick();
          await service.recover();
          expect(schedule.status().state).not.toBe("needs-attention");
          expect(finished).toBe(true);
        },
        { timeout: 5000, interval: 10 },
      );
      expect(live.broadcasts).toEqual([
        "claim-rewards",
        "claim-staker-rewards",
        "claim-staker-rewards",
        "claim-rewards",
        "claim-staker-rewards",
        "claim-staker-rewards",
      ]);
      expect(store.rewardRuns.list()).toHaveLength(6);
      for (const run of store.rewardRuns.list()) {
        expect(store.rewardSchedule.isScheduled(run.runId)).toBe(true);
        expect(run.recipe.maxTransactions).toBe(1);
      }
    } finally {
      await schedule.stop();
      await service.stop();
    }
  });

  it("does not hydrate 200 terminal runs with 50 children during idle maintenance", async () => {
    const { store } = await openSidekickStore(":memory:", started.toISOString());
    stores.push(store);
    const retainedFacts = {
      ...facts(),
      calculateRequired: false,
      collectRequired: false,
      eligibleAccountCount: 50,
      accounts: Array.from({ length: 50 }, (_, index) => ({
        stakerPrincipal: stakerOne,
        rewardCycle: 141,
        bondIndex: String(index),
        maximumGrossSats: "1000",
        payoutRoute: "direct-sbtc" as const,
      })),
    };
    for (let index = 0; index < 200; index += 1) {
      const runId = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
      const recipe = buildRewardRunRecipe({
        runId,
        facts: retainedFacts,
        request: { cycle: 141, distribution: 1, operations: ["claim-staker-rewards"] },
        feeCapUstx: 500n,
        maximumTransactions: 50,
      });
      store.rewardRuns.insert({
        runId,
        walletPrincipal: wallet,
        recipeSha256: "ab".repeat(32),
        recipe,
        children: recipe.children,
        approvalExpiresAt: started.toISOString(),
        now: started.toISOString(),
      });
      store.rewardRuns.transition({
        runId,
        from: ["awaiting-approval"],
        to: "cancelled",
        now: started.toISOString(),
        completedAt: started.toISOString(),
      });
    }
    const hydrate = vi.spyOn(store.rewardRuns, "get");
    const history = vi.spyOn(store.rewardRuns, "list");
    const live = driver();
    const service = new RewardRunService({
      repository: store.rewardRuns,
      signer: signer(),
      driver: live.implementation,
      facts: async () => facts(),
      refusalChecks: async () => goodRefusal,
      now: () => started,
    });
    try {
      await service.recover();
      expect(hydrate).not.toHaveBeenCalled();
      expect(history).not.toHaveBeenCalled();
      expect(live.materialized).toEqual([]);
      expect(live.broadcasts).toEqual([]);
    } finally {
      await service.stop();
    }
  }, 20_000);

  it("observes submitted work on existing maintenance with signing disabled, coalesces slow reads, and drains shutdown", async () => {
    const { store } = await openSidekickStore(":memory:", started.toISOString());
    stores.push(store);
    const pending = Promise.withResolvers<void>();
    const observeSubmitted = vi.fn(() => pending.promise);
    const live = driver();
    const service = new RewardRunService({
      repository: store.rewardRuns,
      signer: { ...signer(), gasWalletSignerReady: () => false },
      driver: live.implementation,
      facts: async () => facts(),
      refusalChecks: async () => goodRefusal,
      maximumFeeUstx: 1000n,
      observeSubmitted: [
        async () => {
          throw new Error("other observer failed");
        },
        observeSubmitted,
      ],
    });
    await service.start();
    await Promise.all([service.recover(), service.recover()]);
    expect(observeSubmitted).toHaveBeenCalledOnce();
    const stopped = vi.fn();
    const stop = service.stop().then(stopped);
    await Promise.resolve();
    expect(stopped).not.toHaveBeenCalled();
    pending.resolve();
    await stop;
    await service.recover();
    expect(observeSubmitted).toHaveBeenCalledOnce();
    expect(live.materialized).toEqual([]);
    expect(live.broadcasts).toEqual([]);
  });

  it.each([
    "pending",
    "unavailable",
    "throw",
  ] as const)("bounds active-run %s receipt reads per hour and finds a late confirmation without re-signing", async (kind) => {
    const { store } = await openSidekickStore(":memory:", started.toISOString());
    stores.push(store);
    const live = driver();
    let now = started;
    const reconcile = vi.fn<RewardRunDriver["reconcile"]>(async () => {
      if (kind === "throw") throw new UpstreamUnavailableError("offline");
      return kind === "unavailable"
        ? { status: "pending", retryLater: true }
        : { status: "pending" };
    });
    const sign = vi.fn(signer().signManagerClaimRewardsRunPlan);
    const service = new RewardRunService({
      repository: store.rewardRuns,
      signer: { ...signer(), signManagerClaimRewardsRunPlan: sign },
      driver: { ...live.implementation, reconcile },
      facts: async () => facts(),
      refusalChecks: async () => goodRefusal,
      maximumFeeUstx: 1_000n,
      now: () => now,
    });
    const run = await service.prepare({
      cycle: 141,
      distribution: 1,
      operations: ["claim-rewards"],
    });
    await service.approve(run.runId, run.recipeSha256);
    await service.recover();
    const deadline = service.get(run.runId).runtimeExpiresAt;
    for (let seconds = 5; seconds < 3600; seconds += 5) {
      now = new Date(started.getTime() + seconds * 1000);
      await service.recover();
    }
    expect(reconcile).toHaveBeenCalledTimes(kind === "pending" ? 120 : 15);
    expect(service.get(run.runId)).toMatchObject({
      status: "running",
      cursor: 0,
      runtimeExpiresAt: deadline,
    });
    expect(sign).toHaveBeenCalledOnce();
    expect(live.broadcasts).toEqual(["claim-rewards"]);
    reconcile.mockResolvedValue({
      status: "confirmed",
      blockHeight: 9_001,
      executionSource: "api",
    });
    now = new Date(started.getTime() + 3750_000);
    await service.recover();
    expect((await settle(service, run.runId)).status).toBe("completed");
    expect(service.get(run.runId).children[0]?.executionSource).toBe("api");
    expect(sign).toHaveBeenCalledOnce();
    expect(live.broadcasts).toEqual(["claim-rewards"]);
    await service.stop();
  });

  it.each([
    "returned",
    "thrown",
  ] as const)("continues five-minute reads despite a %s day-long Retry-After, without re-signing or extending expiry", async (kind) => {
    const { store } = await openSidekickStore(":memory:", started.toISOString());
    stores.push(store);
    const live = driver();
    let now = started;
    const retryAfterMs = 24 * 60 * 60_000;
    const reconcile = vi.fn<RewardRunDriver["reconcile"]>(async () => {
      if (kind === "thrown") throw new RateLimitedError("limited", retryAfterMs);
      return { status: "pending", retryLater: true, retryAfterMs };
    });
    const sign = vi.fn(signer().signManagerClaimRewardsRunPlan);
    const service = new RewardRunService({
      repository: store.rewardRuns,
      signer: { ...signer(), signManagerClaimRewardsRunPlan: sign },
      driver: { ...live.implementation, reconcile },
      facts: async () => facts(),
      refusalChecks: async () => goodRefusal,
      maximumFeeUstx: 1_000n,
      now: () => now,
    });
    const run = await service.prepare({
      cycle: 141,
      distribution: 1,
      operations: ["claim-rewards"],
    });
    await service.approve(run.runId, run.recipeSha256);
    await service.recover();
    const deadline = service.get(run.runId).runtimeExpiresAt;
    expect(deadline).toBe(new Date(started.getTime() + 6 * 60 * 60_000).toISOString());
    now = new Date(started.getTime() + 299_999);
    await service.recover();
    expect(reconcile).toHaveBeenCalledOnce();
    // A source hint cannot silence observation: keep checking throughout the original lifetime.
    for (let elapsed = 300_000; elapsed < 6 * 60 * 60_000; elapsed += 300_000) {
      now = new Date(started.getTime() + elapsed);
      await service.recover();
      expect(reconcile).toHaveBeenCalledTimes(1 + elapsed / 300_000);
      expect(service.get(run.runId)).toMatchObject({
        status: "running",
        cursor: 0,
        runtimeExpiresAt: deadline,
      });
    }
    now = new Date(started.getTime() + 6 * 60 * 60_000 - 5_000);
    await service.recover();
    expect(service.get(run.runId).status).toBe("running");
    expect(reconcile).toHaveBeenCalledTimes(72);
    now = new Date(started.getTime() + 6 * 60 * 60_000);
    await service.recover();
    expect(service.get(run.runId)).toMatchObject({ status: "expired", runtimeExpiresAt: deadline });
    expect(reconcile).toHaveBeenCalledTimes(72);
    expect(sign).toHaveBeenCalledOnce();
    expect(live.broadcasts).toEqual(["claim-rewards"]);
    await service.stop();
  });

  it("retries failed submitted observation without halting or delaying an active run", async () => {
    const { store } = await openSidekickStore(":memory:", started.toISOString());
    stores.push(store);
    const observeSubmitted = vi.fn(async () => {
      throw new Error("wallet source down");
    });
    const logger = { warn: vi.fn() };
    const live = driver();
    let now = started;
    const service = new RewardRunService({
      repository: store.rewardRuns,
      signer: signer(),
      driver: live.implementation,
      facts: async () => facts(),
      refusalChecks: async () => goodRefusal,
      maximumFeeUstx: 1000n,
      observeSubmitted: [observeSubmitted],
      logger,
      now: () => now,
    });
    const run = await service.prepare({
      cycle: 141,
      distribution: 1,
      operations: ["claim-rewards"],
    });
    await service.approve(run.runId, run.recipeSha256);
    expect((await settle(service, run.runId)).status).toBe("completed");
    expect(observeSubmitted).toHaveBeenCalledOnce();
    now = new Date(started.getTime() + 29_999);
    await service.recover();
    expect(observeSubmitted).toHaveBeenCalledOnce();
    now = new Date(started.getTime() + 30_000);
    await service.recover();
    expect(observeSubmitted).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("wallet source down"));
    expect(live.broadcasts).toEqual(["claim-rewards"]);
    await service.stop();
  });

  it("scans submitted work at most every thirty seconds while retaining five-second run ticks", async () => {
    const { store } = await openSidekickStore(":memory:", started.toISOString());
    stores.push(store);
    let now = started;
    const observeSubmitted = vi.fn(async () => {});
    const service = new RewardRunService({
      repository: store.rewardRuns,
      signer: signer(),
      driver: driver().implementation,
      facts: async () => facts(),
      refusalChecks: async () => goodRefusal,
      maximumFeeUstx: 1000n,
      observeSubmitted: [observeSubmitted],
      now: () => now,
    });
    for (let seconds = 0; seconds < 3600; seconds += 5) {
      now = new Date(started.getTime() + seconds * 1000);
      await service.recover();
    }
    expect(observeSubmitted).toHaveBeenCalledTimes(120);
    await service.stop();
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

  it.each([
    "materialize",
    "reconcile",
  ] as const)("waits through cached connection unavailability during %s without replacing the child", async (stage) => {
    const { store } = await openSidekickStore(":memory:", started.toISOString());
    stores.push(store);
    const live = driver();
    let assessment = { status: "unavailable" } as ConnectionAssessment;
    let now = started;
    const sign = vi.fn(signer().signManagerClaimRewardsRunPlan);
    const service = new RewardRunService({
      repository: store.rewardRuns,
      signer: { ...signer(), signManagerClaimRewardsRunPlan: sign },
      driver: {
        ...live.implementation,
        async [stage](input: never) {
          requireConnectedAssessment(assessment);
          return await live.implementation[stage](input);
        },
      } as RewardRunDriver,
      facts: async () => facts(),
      refusalChecks: async () => goodRefusal,
      maximumFeeUstx: 1_000n,
      now: () => now,
    });
    const run = await service.prepare({
      cycle: 141,
      distribution: 1,
      operations: ["claim-rewards"],
    });
    await service.approve(run.runId, run.recipeSha256);
    for (let index = 0; index < 3; index++) await service.recover();
    const waiting = service.get(run.runId);
    expect(waiting.status).toBe("running");
    expect(waiting.cursor).toBe(0);
    expect(waiting.children[0]?.status).toBe(stage === "materialize" ? "pending" : "broadcast");
    expect(sign).toHaveBeenCalledTimes(stage === "materialize" ? 0 : 1);
    const deadline = waiting.runtimeExpiresAt;
    assessment = { status: "connected" } as ConnectionAssessment;
    now = new Date(started.getTime() + 30_000);
    const completed = await settle(service, run.runId);
    expect(completed.status).toBe("completed");
    expect(completed.runtimeExpiresAt).toBe(deadline);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(live.broadcasts).toEqual(["claim-rewards"]);
  });

  it("keeps the next child's fresh preparation gated after API evidence completes a paced broadcast", async () => {
    const { store } = await openSidekickStore(":memory:", started.toISOString());
    stores.push(store);
    const live = driver();
    let assessment = { status: "unavailable" } as ConnectionAssessment;
    const service = new RewardRunService({
      repository: store.rewardRuns,
      signer: signer(),
      driver: {
        ...live.implementation,
        async materialize(input) {
          if (input.child.index > 0) requireConnectedAssessment(assessment);
          return live.implementation.materialize(input);
        },
        async reconcile() {
          return { status: "confirmed", blockHeight: 9_001, executionSource: "api" };
        },
      },
      facts: async () => facts(),
      refusalChecks: async () => goodRefusal,
      maximumFeeUstx: 1_000n,
      now: () => started,
    });
    const run = await service.prepare({ cycle: 141, distribution: 1 });
    await service.approve(run.runId, run.recipeSha256);
    await settle(service, run.runId);
    expect(service.get(run.runId)).toMatchObject({ status: "running", cursor: 1 });
    expect(service.get(run.runId).children[0]?.executionSource).toBe("api");
    expect(live.materialized).toEqual(["claim-rewards"]);
    expect(live.broadcasts).toEqual(["claim-rewards"]);
    assessment = { status: "connected" } as ConnectionAssessment;
    expect((await settle(service, run.runId)).status).toBe("completed");
    expect(live.broadcasts).toEqual([
      "claim-rewards",
      "claim-staker-rewards",
      "claim-staker-rewards",
    ]);
    await service.stop();
  });

  it.each([
    new UpstreamUnavailableError("node timeout"),
    new RateLimitedError("rate limited", 5_000),
    new ChainAnchorError("tip moved", { retryable: true }),
  ])("bounds repeated transient preparation failures by the original runtime cap: %s", async (error) => {
    const { store } = await openSidekickStore(":memory:", started.toISOString());
    stores.push(store);
    let now = started;
    const live = driver();
    const materialize = vi.fn().mockRejectedValue(error);
    const service = new RewardRunService({
      repository: store.rewardRuns,
      signer: signer(),
      driver: { ...live.implementation, materialize },
      facts: async () => facts(),
      refusalChecks: async () => goodRefusal,
      maximumFeeUstx: 1_000n,
      now: () => now,
    });
    const run = await service.prepare({ cycle: 141, distribution: 1 });
    await service.approve(run.runId, run.recipeSha256);
    await service.recover();
    expect(service.get(run.runId).status).toBe("running");
    const calls = materialize.mock.calls.length;
    now = new Date(started.getTime() + 6 * 60 * 60_000);
    await service.recover();
    expect(service.get(run.runId)).toMatchObject({
      status: "expired",
      failureReason: "Maximum run time elapsed",
    });
    expect(materialize).toHaveBeenCalledTimes(calls);
    expect(live.broadcasts).toEqual([]);
    expect(store.rewardRuns.active(wallet)).toBeNull();
  });

  it.each([
    new Error("identity changed"),
    new UpstreamSchemaError("malformed evidence"),
    new ChainAnchorError("canonical mismatch"),
  ])("still halts on non-transient errors and never automatically resumes: %s", async (error) => {
    const { store } = await openSidekickStore(":memory:", started.toISOString());
    stores.push(store);
    const live = driver();
    const materialize = vi.fn().mockRejectedValue(error);
    const service = new RewardRunService({
      repository: store.rewardRuns,
      signer: signer(),
      driver: { ...live.implementation, materialize },
      facts: async () => facts(),
      refusalChecks: async () => goodRefusal,
      maximumFeeUstx: 1_000n,
      now: () => started,
    });
    const run = await service.prepare({ cycle: 141, distribution: 1 });
    await service.approve(run.runId, run.recipeSha256);
    expect((await settle(service, run.runId)).status).toBe("halted");
    materialize.mockImplementation(live.implementation.materialize);
    await service.recover();
    expect(service.get(run.runId).status).toBe("halted");
    expect(live.broadcasts).toEqual([]);
  });

  it("rebuilds an unsigned child after a transient last-moment role read without signing twice", async () => {
    const { store } = await openSidekickStore(":memory:", started.toISOString());
    stores.push(store);
    const live = driver();
    let unavailable = false;
    const sign = vi.fn(signer().signManagerClaimRewardsRunPlan);
    const service = new RewardRunService({
      repository: store.rewardRuns,
      signer: { ...signer(), signManagerClaimRewardsRunPlan: sign },
      driver: live.implementation,
      facts: async () => facts(),
      refusalChecks: async () => {
        if (unavailable) throw new UpstreamUnavailableError("role read timed out");
        return goodRefusal;
      },
      maximumFeeUstx: 1_000n,
      now: () => started,
    });
    const run = await service.prepare({
      cycle: 141,
      distribution: 1,
      operations: ["claim-rewards"],
    });
    await service.approve(run.runId, run.recipeSha256);
    unavailable = true;
    await service.recover();
    expect(service.get(run.runId).status).toBe("running");
    expect(sign).not.toHaveBeenCalled();
    expect(store.rewardRuns.attempts(run.runId, 0)).toEqual([]);
    unavailable = false;
    expect((await settle(service, run.runId)).status).toBe("completed");
    expect(sign).toHaveBeenCalledOnce();
    expect(live.broadcasts).toEqual(["claim-rewards"]);
  });

  it("does not retry a typed transport error after a signed attempt may have been submitted", async () => {
    const { store } = await openSidekickStore(":memory:", started.toISOString());
    stores.push(store);
    const live = driver();
    const broadcast = vi
      .fn()
      .mockRejectedValue(new UpstreamUnavailableError("submission connection lost"));
    const sign = vi.fn(signer().signManagerClaimRewardsRunPlan);
    const service = new RewardRunService({
      repository: store.rewardRuns,
      signer: { ...signer(), signManagerClaimRewardsRunPlan: sign },
      driver: { ...live.implementation, broadcast },
      facts: async () => facts(),
      refusalChecks: async () => goodRefusal,
      maximumFeeUstx: 1_000n,
      now: () => started,
    });
    const run = await service.prepare({
      cycle: 141,
      distribution: 1,
      operations: ["claim-rewards"],
    });
    await service.approve(run.runId, run.recipeSha256);
    expect((await settle(service, run.runId)).status).toBe("halted");
    await service.recover();
    expect(store.rewardRuns.attempts(run.runId, 0)).toHaveLength(1);
    expect(sign).toHaveBeenCalledOnce();
    expect(broadcast).toHaveBeenCalledOnce();
  });

  it.each([
    "expire",
    "pause",
    "force-observe",
  ] as const)("rechecks %s after slow role reads before signing", async (change) => {
    const { store } = await openSidekickStore(":memory:", started.toISOString());
    stores.push(store);
    const live = driver();
    let now = started;
    let blocked = false;
    let roleReads = 0;
    const sign = vi.fn(signer().signManagerClaimRewardsRunPlan);
    const service = new RewardRunService({
      repository: store.rewardRuns,
      signer: { ...signer(), signManagerClaimRewardsRunPlan: sign },
      driver: live.implementation,
      facts: async () => facts(),
      refusalChecks: async () => {
        if (++roleReads > 1) {
          if (change === "expire") now = new Date(started.getTime() + 6 * 60 * 60_000);
          if (change === "pause") service.pause(store.rewardRuns.active(wallet)?.runId ?? "");
          if (change === "force-observe") blocked = true;
        }
        return goodRefusal;
      },
      executionControl: () => ({ allowed: !blocked, reason: "Force Observe is active" }),
      maximumFeeUstx: 1_000n,
      now: () => now,
    });
    const run = await service.prepare({
      cycle: 141,
      distribution: 1,
      operations: ["claim-rewards"],
    });
    await service.approve(run.runId, run.recipeSha256);
    await service.recover();
    expect(service.get(run.runId).status).toBe(
      change === "expire" ? "expired" : change === "pause" ? "paused" : "halted",
    );
    expect(sign).not.toHaveBeenCalled();
    expect(live.broadcasts).toEqual([]);
  });

  it("returns a durable preparation immediately and seals its run in the background", async () => {
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
    const queued = service.enqueuePreparation({
      cycle: 141,
      distribution: 1,
      operations: ["claim-rewards"],
    });
    expect(queued).toMatchObject({ status: "queued", runId: null });
    await vi.waitFor(() => {
      expect(service.getPreparation(queued.preparationId)).toMatchObject({
        status: "ready",
        runId: queued.preparationId,
      });
    });
    expect(readFacts).toHaveBeenCalledTimes(1);
    expect(service.get(queued.preparationId)).toMatchObject({ status: "awaiting-approval" });
  });

  it("leaves an interrupted preparation recoverable across a clean restart", async () => {
    const { store } = await openSidekickStore(":memory:", started.toISOString());
    stores.push(store);
    let entered: (() => void) | undefined;
    const preparing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const first = new RewardRunService({
      repository: store.rewardRuns,
      signer: signer(),
      driver: driver().implementation,
      facts: async () => {
        const signal = currentInteractiveRequestSignal();
        if (!signal) throw new Error("Background preparation has no cancellation signal");
        entered?.();
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
      refusalChecks: async () => goodRefusal,
      maximumFeeUstx: 1_000n,
      now: () => started,
    });
    const queued = first.enqueuePreparation({
      cycle: 141,
      distribution: 1,
      operations: ["claim-rewards"],
    });
    await preparing;
    expect(first.getPreparation(queued.preparationId).status).toBe("preparing");
    await first.stop();
    expect(first.getPreparation(queued.preparationId).status).toBe("preparing");

    const second = new RewardRunService({
      repository: store.rewardRuns,
      signer: signer(),
      driver: driver().implementation,
      facts: async () => facts(),
      refusalChecks: async () => goodRefusal,
      maximumFeeUstx: 1_000n,
      pollIntervalMs: 60_000,
      now: () => started,
    });
    await second.start();
    await vi.waitFor(() => {
      expect(second.getPreparation(queued.preparationId).status).toBe("ready");
    });
    await second.stop();
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
    await service.stop();
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
    await first.stop();

    const recovered = driver();
    const reconcile = vi
      .spyOn(recovered.implementation, "reconcile")
      .mockImplementation(async (input) => {
        expect(input.signedAttempt).toMatchObject({
          precomputedTxid: input.txid,
          state: "accepted",
        });
        expect(input.signedAttempt?.nonce).toBe(input.plan.material.transaction.nonce);
        expect(input.signedAttempt?.feeUstx).toBe(input.plan.material.transaction.feeUstx);
        return { status: "confirmed", blockHeight: 9001, executionSource: "api" };
      });
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
    expect(reconcile).toHaveBeenCalledOnce();
    expect(second.get(prepared.runId).children[0]?.executionSource).toBe("api");
  });

  it("migrates legacy halted broadcast diagnostics without losing the saved attempt or inventing execution provenance", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sidekick-r3b-migration-"));
    directories.push(directory);
    const path = join(directory, "sidekick.sqlite");
    const initial = await openSidekickStore(path, started.toISOString());
    const live = driver({ reconcile: "halt" });
    const options = {
      signer: signer(),
      facts: async () => facts(),
      refusalChecks: async () => goodRefusal,
      maximumFeeUstx: 1000n,
      now: () => started,
    };
    const first = new RewardRunService({
      ...options,
      repository: initial.store.rewardRuns,
      driver: live.implementation,
    });
    const prepared = await first.prepare({
      cycle: 141,
      distribution: 1,
      operations: ["claim-rewards"],
    });
    await first.approve(prepared.runId, prepared.recipeSha256);
    const halted = await settle(first, prepared.runId);
    expect(halted.status).toBe("halted");
    const attempt = initial.store.rewardRuns.attempts(prepared.runId, 0)[0];
    await first.stop();
    initial.store.close();
    // Recreate the previous schema and its parent-only unresolved diagnostic.
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      DROP TABLE reward_schedule_requests;
      DROP TABLE reward_schedule;
      DROP INDEX position_detail_due;
      DROP INDEX pool_detail_due;
      DROP INDEX position_detail_neighbors;
      DROP INDEX pool_detail_neighbors;
      DROP INDEX activity_chain_time;
      DROP INDEX manager_claim_cycle;
      DROP INDEX pox_reward_cycle;
      ALTER TABLE staker_position_observations DROP COLUMN chain_anchor_json;
      ALTER TABLE staker_position_observations DROP COLUMN reconciliation_complete;
      ALTER TABLE staker_position_observations DROP COLUMN position_detail_json;
      ALTER TABLE staker_position_observations DROP COLUMN history_compacted;
      ALTER TABLE pool_cycle_snapshots DROP COLUMN history_compacted;
      ALTER TABLE reward_cycle_snapshots DROP COLUMN snapshot_fingerprint;
      DROP INDEX settings_audit_revision;
      DROP INDEX IF EXISTS activity_chain_transactions;
    DROP INDEX IF EXISTS activity_run_transactions;
    DROP INDEX IF EXISTS activity_wallet_state;
    DROP INDEX IF EXISTS activity_job_state;
    DROP INDEX IF EXISTS activity_run_state;
    DROP INDEX IF EXISTS observer_latest_stacks;
    DROP INDEX IF EXISTS observer_latest_burn;
    DROP INDEX IF EXISTS observer_latest_verified;
    DROP INDEX IF EXISTS observer_latest_quarantine;
    DROP INDEX IF EXISTS observer_terminal_payloads;
      ALTER TABLE transaction_run_children DROP COLUMN execution_source;
      ALTER TABLE gas_wallet_sweeps DROP COLUMN execution_source;
      DELETE FROM schema_migrations WHERE version >= 40;
      PRAGMA user_version = 39;
    `);
    legacy.close();
    const upgraded = await openSidekickStore(path, started.toISOString());
    stores.push(upgraded.store);
    expect(upgraded.backupPath).not.toBeNull();
    expect(upgraded.store.rewardRuns.get(prepared.runId)?.children[0]).toMatchObject({
      status: "broadcast",
      executionSource: null,
      failureReason: halted.failureReason,
    });
    expect(upgraded.store.rewardRuns.attempts(prepared.runId, 0)[0]).toEqual(attempt);
    const reconcile = vi.fn<RewardRunDriver["reconcile"]>(async (input) => {
      expect(input.child.failureReason).toBe(halted.failureReason);
      expect(input.signedAttempt?.precomputedTxid).toBe(attempt?.precomputedTxid);
      return { status: "pending" };
    });
    const restarted = new RewardRunService({
      ...options,
      repository: upgraded.store.rewardRuns,
      driver: { ...live.implementation, reconcile },
    });
    await restarted.recover();
    expect(reconcile).not.toHaveBeenCalled(); // A migration is never authority to resume.
    restarted.resume(prepared.runId);
    await restarted.recover();
    expect(reconcile).toHaveBeenCalled();
    expect(live.broadcasts).toEqual(["claim-rewards"]);
    await restarted.stop();
  });

  it("retains a positive reconciliation conflict on the child across explicit resume", async () => {
    const { store } = await openSidekickStore(":memory:", started.toISOString());
    stores.push(store);
    const live = driver();
    const reason = "Canonical transaction conflict: absent";
    const reconcile = vi
      .fn<RewardRunDriver["reconcile"]>()
      .mockResolvedValueOnce({ status: "halt", reason, requiresNodeCorroboration: true })
      .mockImplementation(async (input) => {
        expect(input.child.failureReason).toBe(reason);
        return { status: "pending" };
      });
    const service = new RewardRunService({
      repository: store.rewardRuns,
      signer: signer(),
      driver: { ...live.implementation, reconcile },
      facts: async () => facts(),
      refusalChecks: async () => goodRefusal,
      maximumFeeUstx: 1000n,
      now: () => started,
    });
    const run = await service.prepare({
      cycle: 141,
      distribution: 1,
      operations: ["claim-rewards"],
    });
    await service.approve(run.runId, run.recipeSha256);
    expect((await settle(service, run.runId)).status).toBe("halted");
    expect(service.get(run.runId).children[0]?.failureReason).toBe(reason);
    service.resume(run.runId);
    await service.recover();
    expect(service.get(run.runId).status).toBe("running");
    expect(service.get(run.runId).children[0]?.failureReason).toBe(reason);
    expect(live.broadcasts).toEqual(["claim-rewards"]);
    await service.stop();
  });

  it("coalesces slow recovery ticks and drains observation before shutdown", async () => {
    const { store } = await openSidekickStore(":memory:", started.toISOString());
    stores.push(store);
    const live = driver();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reconcile = vi.fn(async () => {
      await pending;
      return { status: "pending" as const };
    });
    const service = new RewardRunService({
      repository: store.rewardRuns,
      signer: signer(),
      driver: { ...live.implementation, reconcile },
      facts: async () => facts(),
      refusalChecks: async () => goodRefusal,
      maximumFeeUstx: 1_000n,
      now: () => started,
    });
    const run = await service.prepare({
      cycle: 141,
      distribution: 1,
      operations: ["claim-rewards"],
    });
    await service.approve(run.runId, run.recipeSha256);
    const ticks = Array.from({ length: 6 }, () => service.recover());
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledOnce());
    const stopped = vi.fn();
    const stop = service.stop().then(stopped);
    await Promise.resolve();
    expect(stopped).not.toHaveBeenCalled();
    release();
    await Promise.all([...ticks, stop]);
    expect(stopped).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledOnce();
    expect(live.broadcasts).toEqual(["claim-rewards"]);
    await service.recover();
    expect(reconcile).toHaveBeenCalledOnce();
  });

  it("does not sign a materialized child while shutdown drains slow role checks", async () => {
    const { store } = await openSidekickStore(":memory:", started.toISOString());
    stores.push(store);
    const live = driver();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = vi.fn();
    let roleReads = 0;
    const sign = vi.fn(signer().signManagerClaimRewardsRunPlan);
    const service = new RewardRunService({
      repository: store.rewardRuns,
      signer: { ...signer(), signManagerClaimRewardsRunPlan: sign },
      driver: live.implementation,
      facts: async () => facts(),
      refusalChecks: async () => {
        if (++roleReads > 1) {
          entered();
          await pending;
        }
        return goodRefusal;
      },
      maximumFeeUstx: 1_000n,
      now: () => started,
    });
    const run = await service.prepare({
      cycle: 141,
      distribution: 1,
      operations: ["claim-rewards"],
    });
    await service.approve(run.runId, run.recipeSha256);
    await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
    const stopped = vi.fn();
    const stop = service.stop().then(stopped);
    await Promise.resolve();
    expect(stopped).not.toHaveBeenCalled();
    release();
    await stop;
    expect(sign).not.toHaveBeenCalled();
    expect(store.rewardRuns.attempts(run.runId, 0)).toEqual([]);
    expect(live.broadcasts).toEqual([]);
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
    // The scheduler must not turn the released lease into automatic replacement authority.
    expect(store.rewardSchedule.unresolvedExpiredRun(wallet)).toBe(prepared.runId);
    expect(store.rewardSchedule.unresolvedExpiredRun(stakerOne)).toBeNull();
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
