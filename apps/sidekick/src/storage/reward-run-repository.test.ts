import { getAddressFromPublicKey, privateKeyToPublic } from "@stacks/transactions";
import type { RewardRunRecipe } from "@stx-labs/signer-sidekick-api-contracts";
import { planRewardOperation } from "@stx-labs/signer-sidekick-protocol/reward-operation-plan";
import { afterEach, describe, expect, it } from "vitest";
import { planGasWalletSweep } from "../gas-wallet-sweep.js";
import { openSidekickStore, type SidekickStore } from "./store.js";

const runId = "00000000-0000-4000-8000-000000000001";
const secondRunId = "00000000-0000-4000-8000-000000000002";
const sweepId = "00000000-0000-4000-8000-000000000003";
const now = "2026-08-22T12:00:00.000Z";
const publicKey = privateKeyToPublic(`${"11".repeat(32)}01`);
const wallet = getAddressFromPublicKey(publicKey, "testnet");
const manager = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.signer-manager";
const pox5 = "ST000000000000000000002AMW42H.pox-5";
const sbtc = "SN3VMHXEN64ZZF71JQ5VESXDWTR301XTTXGF4J8F1.sbtc-token";
const registry = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.sbtc-registry";
const staker = "ST2CY5V39NHDPWSXMW9QDT3HC3GD6Q6XX4CFRK9AG";

function recipe(id = runId): RewardRunRecipe {
  const accountKey = `${staker}:141:stx`;
  return {
    schemaVersion: 1,
    runId: id,
    prepareRequestSha256: "78".repeat(32),
    walletPrincipal: wallet,
    managerPrincipal: manager,
    pox5Contract: pox5,
    sbtcTokenContract: sbtc,
    sbtcRegistryContract: registry,
    network: "testnet",
    chainId: 0x8000_0005,
    cycle: 141,
    distribution: 1,
    orderedOperations: ["claim-staker-rewards"],
    accounts: [
      {
        accountKey,
        stakerPrincipal: staker,
        rewardCycle: 141,
        bondIndex: null,
        maximumGrossSats: "10000",
        payoutRoute: "direct-sbtc",
      },
    ],
    reviewedTotalSats: "10000",
    reviewedPaymentCount: 1,
    maxTransactions: 1,
    eligibleTransactions: 1,
    truncated: false,
    remainingTransactions: 0,
    feeCapUstx: "1000",
    gasBudgetUstx: "1000",
    managerSourceFingerprint: "12".repeat(32),
    pox5SourceFingerprint: "34".repeat(32),
    adapterRevisions: { "reference-manager-claim-staker-rewards": 2 },
    children: [
      {
        index: 0,
        operation: "claim-staker-rewards",
        adapterId: "reference-manager-claim-staker-rewards",
        adapterRevision: 2,
        accountKey,
        requestId: null,
        stakerPrincipal: staker,
        maximumAmountSats: "10000",
        withdrawalAmountSats: null,
        maxFeeSats: null,
      },
    ],
    preparedAnchor: {
      stacksBlockHeight: 9_000,
      burnBlockHeight: 4_100,
      indexBlockHash: `0x${"ab".repeat(32)}`,
    },
  };
}

function insertRun(store: SidekickStore, id = runId) {
  const sealed = recipe(id);
  return store.rewardRuns.insert({
    runId: id,
    walletPrincipal: wallet,
    recipeSha256: "56".repeat(32),
    recipe: sealed,
    approvalExpiresAt: "2026-08-22T12:30:00.000Z",
    children: sealed.children.map((child) => ({
      operation: child.operation,
      adapterId: child.adapterId,
      adapterRevision: child.adapterRevision,
      accountKey: child.accountKey,
      maximumAmountSats: child.maximumAmountSats,
    })),
    now,
  });
}

describe("reward run repository", () => {
  const stores: SidekickStore[] = [];
  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
  });

  it("persists a sealed recipe, durable cursor, attempts, and bounded child materialization", async () => {
    const { store } = await openSidekickStore(":memory:", now);
    stores.push(store);
    const inserted = insertRun(store);
    expect(inserted).toMatchObject({
      runId,
      status: "awaiting-approval",
      cursor: 0,
      progress: { completed: 0, total: 1, inFlight: 0 },
    });
    expect(store.rewardRuns.active(wallet)?.runId).toBe(runId);

    store.rewardRuns.transition({
      runId,
      from: ["awaiting-approval"],
      to: "approved",
      approvedAt: now,
      now,
    });
    store.rewardRuns.transition({
      runId,
      from: ["approved"],
      to: "running",
      startedAt: now,
      runtimeExpiresAt: "2026-08-22T18:00:00.000Z",
      now,
    });
    const plan = await planRewardOperation({
      authorization: {
        schemaVersion: 2,
        kind: "operator-run",
        runId,
        recipeSha256: "56".repeat(32),
      },
      network: { kind: "testnet", chainId: 0x8000_0005 },
      chainAnchor: recipe().preparedAnchor,
      sender: { principal: wallet, publicKey },
      managerSourceFingerprint: "12".repeat(32),
      nonce: 1n,
      feeUstx: 500n,
      kind: "claim-staker-rewards",
      managerContract: manager,
      sbtcTokenContract: sbtc,
      stakerPrincipal: staker,
      rewardCycle: 141n,
      bondIndex: null,
      payoutRoute: "direct-sbtc",
      grossSats: 9_000n,
      feeSats: 450n,
      expectedNetSats: 8_550n,
    });
    expect(() =>
      store.rewardRuns.materializeChild({
        runId,
        childIndex: 0,
        plan,
        amountSats: "10001",
        now,
      }),
    ).toThrow("exceeds its approved recipe bound");
    store.rewardRuns.materializeChild({
      runId,
      childIndex: 0,
      plan,
      amountSats: "9000",
      now,
    });
    store.rewardRuns.insertAttempt({
      runId,
      childIndex: 0,
      precomputedTxid: `0x${"cd".repeat(32)}`,
      nonce: "1",
      feeUstx: "500",
      state: "accepted",
      now,
    });
    store.rewardRuns.updateChild({
      runId,
      childIndex: 0,
      from: ["materialized"],
      to: "broadcast",
      txid: `0x${"cd".repeat(32)}`,
      provenance: "you",
      now,
    });
    store.rewardRuns.updateChild({
      runId,
      childIndex: 0,
      from: ["broadcast"],
      to: "confirmed",
      provenance: "you",
      now,
    });
    const advanced = store.rewardRuns.advanceCursor(runId, 0, "500", now);
    expect(advanced).toMatchObject({
      cursor: 1,
      gasSpentUstx: "500",
      progress: { completed: 1, total: 1, inFlight: 0 },
    });
    store.rewardRuns.transition({
      runId,
      from: ["running"],
      to: "completed",
      completedAt: now,
      now,
    });
    expect(store.rewardRuns.active(wallet)).toBeNull();
  });

  it("lists the runs sealed for one distribution target, oldest first", async () => {
    const { store } = await openSidekickStore(":memory:", now);
    stores.push(store);
    insertRun(store);
    expect(store.rewardRuns.listForTarget(141, 1).map((run) => run.runId)).toEqual([runId]);
    expect(store.rewardRuns.listForTarget(141, 2)).toEqual([]);
    expect(store.rewardRuns.listForTarget(140, 1)).toEqual([]);
  });

  it("enforces one active reward run or sweep per gas wallet", async () => {
    const { store } = await openSidekickStore(":memory:", now);
    stores.push(store);
    insertRun(store);
    expect(() => insertRun(store, secondRunId)).toThrow("active run or sweep");

    const sweepPlan = await planGasWalletSweep({
      network: "testnet",
      chainId: 0x8000_0005,
      sender: { principal: wallet, publicKey },
      recipient: staker,
      balanceUstx: 10_000n,
      feeUstx: 500n,
      nonce: 2n,
      indexBlockHash: `0x${"ab".repeat(32)}`,
      createdAt: new Date(now),
      expiresAt: new Date("2026-08-22T12:30:00.000Z"),
    });
    expect(() =>
      store.gasWalletSweeps.insert({
        sweepId,
        walletPrincipal: wallet,
        plan: sweepPlan,
        createdAt: now,
      }),
    ).toThrow("active reward run or sweep");

    store.rewardRuns.transition({
      runId,
      from: ["awaiting-approval"],
      to: "cancelled",
      completedAt: now,
      now,
    });
    store.gasWalletSweeps.insert({
      sweepId,
      walletPrincipal: wallet,
      plan: sweepPlan,
      createdAt: now,
    });
    expect(() => insertRun(store, secondRunId)).toThrow("active run or sweep");
    store.gasWalletSweeps.update(sweepId, { status: "cancelled", resolvedAt: now }, now);
    expect(insertRun(store, secondRunId).runId).toBe(secondRunId);
  });
});
