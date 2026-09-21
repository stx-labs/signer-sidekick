import type {
  ActivityCoverage,
  ActivityDisplayStatus,
  ActivityGroupSummary,
  ActivityOutcome,
  RewardRunRecipe,
} from "@stx-labs/signer-sidekick-api-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ActivityProjectionError,
  ActivityProjectionService,
  engineJobActivityPresentation,
  engineJobActivityStage,
  engineJobActivityState,
  noncanonicalReobserveRecoveryMs,
  projectActivityPage,
  sortActiveActivity,
  walletIntentActivityStage,
  walletIntentActivityState,
  walletIntentSummaryText,
} from "./activity-projection.js";
import { managerEventStream } from "./manager-event-vocabulary.js";
import { pox5PoolActivityStream } from "./pox5-pool-activity-sync.js";
import { createChainSourceId, openSidekickStore, type SidekickStore } from "./storage/store.js";
import { canonicalJsonSha256, walletIntentStates } from "./storage/wallet-intent-repository.js";
import { buildRewardRunRecipe } from "./transaction-engine/reward-run-service.js";
import { transactionJobStates } from "./transaction-engine/state-machine.js";

const now = new Date("2026-08-14T12:00:00.000Z");
const managerPrincipal = "SP000000000000000000002Q6VF78.signer-manager";
const pox5ContractId = "SP000000000000000000002Q6VF78.pox-5";
const actorPrincipal = "SP000000000000000000002Q6VF78";
const txid = `0x${"11".repeat(32)}`;
const blockHash = `0x${"22".repeat(32)}`;
const indexBlockHash = `0x${"33".repeat(32)}`;
const sourceId = createChainSourceId("mainnet", "https://api.mainnet.hiro.so");
const stores: SidekickStore[] = [];

const sourceCoverage: ActivityCoverage = {
  source: "wallet-intents",
  status: "current",
  observedAt: now.toISOString(),
  anchor: null,
  reason: null,
};

function summary(
  activityId: string,
  displayStatus: ActivityDisplayStatus,
  outcome: ActivityOutcome,
  overrides: Partial<ActivityGroupSummary> = {},
): ActivityGroupSummary {
  return {
    schemaVersion: 1,
    activityId,
    kind: "operation",
    domain: "rewards",
    code: "claim-rewards",
    title: "Claim rewards",
    summary: "Operator activity",
    stage: "review-ready",
    operationScope: "claim-rewards:141",
    displayStatus,
    outcome,
    occurredAt: "2026-08-14T10:00:00.000Z",
    updatedAt: "2026-08-14T11:00:00.000Z",
    deadline: null,
    urgencyAt: null,
    actorPrincipal,
    txids: [],
    anchor: null,
    supersedesActivityId: null,
    supersededByActivityId: null,
    primaryAction:
      displayStatus === "action-required" ||
      displayStatus === "in-progress" ||
      displayStatus === "needs-attention"
        ? { kind: "resume-activity", activityId, label: "Resume operation" }
        : null,
    coverage: [{ ...sourceCoverage, source: "wallet-intents" }],
    ...overrides,
  };
}

function query(overrides: Partial<Parameters<typeof projectActivityPage>[0]["query"]> = {}) {
  return {
    status: "all" as const,
    type: "all" as const,
    domain: "all" as const,
    time: "all" as const,
    search: null,
    cursor: null,
    limit: 50,
    ...overrides,
  };
}

function record(value: ActivityGroupSummary) {
  return { summary: value, timeline: [], aliases: [value.activityId] };
}

async function memoryStore(): Promise<SidekickStore> {
  const { store } = await openSidekickStore(":memory:", now.toISOString());
  stores.push(store);
  return store;
}

function insertCompletedRewardRun(store: SidekickStore) {
  const runId = "00000000-0000-4000-8000-000000000141";
  const recipe: RewardRunRecipe = {
    schemaVersion: 1,
    runId,
    prepareRequestSha256: "44".repeat(32),
    walletPrincipal: actorPrincipal,
    managerPrincipal,
    pox5Contract: pox5ContractId,
    sbtcTokenContract: "SP000000000000000000002Q6VF78.sbtc-token",
    sbtcRegistryContract: "SP000000000000000000002Q6VF78.sbtc-registry",
    network: "mainnet",
    chainId: 1,
    cycle: 141,
    distribution: 1,
    orderedOperations: ["claim-rewards"],
    accounts: [],
    reviewedTotalSats: "1000",
    reviewedPaymentCount: 0,
    maxTransactions: 1,
    eligibleTransactions: 1,
    truncated: false,
    remainingTransactions: 0,
    feeCapUstx: "100000",
    gasBudgetUstx: "100000",
    managerSourceFingerprint: "55".repeat(32),
    pox5SourceFingerprint: "66".repeat(32),
    adapterRevisions: { "reference-manager-claim-rewards": 1 },
    children: [
      {
        index: 0,
        operation: "claim-rewards",
        adapterId: "reference-manager-claim-rewards",
        adapterRevision: 1,
        accountKey: null,
        requestId: null,
        stakerPrincipal: null,
        maximumAmountSats: "1000",
        withdrawalAmountSats: null,
        maxFeeSats: null,
      },
    ],
    preparedAnchor: {
      stacksBlockHeight: 8_750_000,
      burnBlockHeight: 962_000,
      indexBlockHash,
    },
  };
  store.rewardRuns.insert({
    runId,
    walletPrincipal: actorPrincipal,
    recipeSha256: "77".repeat(32),
    recipe,
    approvalExpiresAt: "2026-08-14T11:30:00.000Z",
    children: recipe.children.map((child) => ({
      operation: child.operation,
      adapterId: child.adapterId,
      adapterRevision: child.adapterRevision,
      accountKey: child.accountKey,
      maximumAmountSats: child.maximumAmountSats,
    })),
    now: "2026-08-14T11:00:00.000Z",
  });
  store.rewardRuns.transition({
    runId,
    from: ["awaiting-approval"],
    to: "approved",
    now: "2026-08-14T11:01:00.000Z",
    approvedAt: "2026-08-14T11:01:00.000Z",
    runtimeExpiresAt: "2026-08-14T17:01:00.000Z",
  });
  store.rewardRuns.transition({
    runId,
    from: ["approved"],
    to: "running",
    now: "2026-08-14T11:02:00.000Z",
    startedAt: "2026-08-14T11:02:00.000Z",
  });
  store.rewardRuns.updateChild({
    runId,
    childIndex: 0,
    from: ["pending"],
    to: "confirmed",
    now: "2026-08-14T11:05:00.000Z",
    txid,
    provenance: "you",
  });
  return store.rewardRuns.transition({
    runId,
    from: ["running"],
    to: "completed",
    now: "2026-08-14T11:05:00.000Z",
    completedAt: "2026-08-14T11:05:00.000Z",
  });
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

describe("Activity projection", () => {
  it("batches 100 child transactions and preserves summary evidence without constructing list timelines", async () => {
    const store = await memoryStore();
    const runId = "00000000-0000-4000-8000-000000000100";
    const recipe = buildRewardRunRecipe({
      runId,
      feeCapUstx: 500n,
      maximumTransactions: 100,
      request: { cycle: 141, distribution: 1, operations: ["claim-staker-rewards"] },
      facts: {
        walletPrincipal: actorPrincipal,
        managerPrincipal,
        pox5Contract: pox5ContractId,
        sbtcTokenContract: `${actorPrincipal}.sbtc-token`,
        sbtcRegistryContract: `${actorPrincipal}.sbtc-registry`,
        network: "mainnet",
        chainId: 1,
        cycle: 141,
        distribution: 1,
        preparedAnchor: { stacksBlockHeight: 9000, burnBlockHeight: 4100, indexBlockHash },
        managerSourceFingerprint: "12".repeat(32),
        pox5SourceFingerprint: "34".repeat(32),
        calculateRequired: false,
        collectRequired: false,
        maximumCollectSats: null,
        eligibleAccountCount: 100,
        eligibleWithdrawalCounts: { accepted: 0, rejected: 0 },
        withdrawals: [],
        accounts: Array.from({ length: 100 }, (_, index) => ({
          stakerPrincipal: actorPrincipal,
          rewardCycle: 141,
          bondIndex: String(index),
          maximumGrossSats: "1000",
          payoutRoute: "direct-sbtc",
        })),
      },
    });
    store.rewardRuns.insert({
      runId,
      walletPrincipal: actorPrincipal,
      recipeSha256: "ab".repeat(32),
      recipe,
      children: recipe.children,
      approvalExpiresAt: now.toISOString(),
      now: now.toISOString(),
    });
    store.chainState.upsertSource({
      sourceId,
      kind: "api",
      network: "mainnet",
      baseUrl: "https://api.mainnet.hiro.so",
      observedAt: now.toISOString(),
    });
    const changedAt = "2026-08-14T12:01:00.000Z";
    for (let index = 0; index < 100; index += 1) {
      const childTxid = `0x${index.toString(16).padStart(64, "0")}` as `0x${string}`;
      store.rewardRuns.updateChild({
        runId,
        childIndex: index,
        from: ["pending"],
        to: "confirmed",
        txid: childTxid,
        provenance: "you",
        now: now.toISOString(),
      });
      store.putChainEvent({
        chainId: 1,
        txId: childTxid,
        eventIndex: 0,
        occurredAt: now.toISOString(),
        blockHeight: 9000 + index,
        blockHash,
        indexBlockHash,
        microblockHash: null,
        microblockSequence: null,
        canonical: index !== 0,
        microblockCanonical: true,
        contractId: managerPrincipal,
        topic: "print",
        rawPayload: {},
        decodedSchemaVersion: 1,
        decodedPayload: {
          event: { kind: "claim-staker-rewards", stakerPrincipal: actorPrincipal },
        },
        sourceId,
        observedAt: changedAt,
      });
    }
    const events = vi.spyOn(store, "listManagerActivityChainEventsForTxids");
    const cursors = vi.spyOn(store.chainState, "getCursor");
    const service = new ActivityProjectionService({
      store,
      chainId: 1,
      managerPrincipal,
      pox5ContractId: () => pox5ContractId,
      sourceId: () => sourceId,
      now: () => now,
    });
    const page = service.page(query());
    expect(events).toHaveBeenCalledTimes(1);
    expect(events.mock.calls[0]?.[2]).toHaveLength(100);
    expect(cursors).toHaveBeenCalledTimes(3);
    expect(page.items).toEqual([]);
    expect(page.active[0]?.updatedAt).toBe(changedAt);
    expect(page.active[0]?.txids).toHaveLength(100);
    expect(page.active[0]?.coverage).toContainEqual(
      expect.objectContaining({
        source: "indexed-manager-history",
        status: "delayed",
        observedAt: changedAt,
      }),
    );
    const detail = service.detail(`reward-run:${runId}`);
    expect(detail?.summary).toEqual(page.active[0]);
    expect(detail?.timeline.filter(({ code }) => code === "verified-chain-event")).toHaveLength(99);
    expect(detail?.timeline.filter(({ code }) => code === "chain-event-noncanonical")).toHaveLength(
      1,
    );
    expect(detail?.aliases).toHaveLength(101);
    expect(detail?.timeline.map(({ occurredAt }) => occurredAt)).toEqual(
      detail?.timeline.map(({ occurredAt }) => occurredAt).sort(),
    );
  });
  it("maps every authoritative wallet-intent and engine state", () => {
    expect(walletIntentStates.map((state) => [state, walletIntentActivityState(state)])).toEqual([
      ["prepared", { displayStatus: "action-required", outcome: "pending" }],
      ["submitted", { displayStatus: "in-progress", outcome: "pending" }],
      ["mempool", { displayStatus: "in-progress", outcome: "pending" }],
      ["confirmed", { displayStatus: "in-progress", outcome: "pending" }],
      ["complete", { displayStatus: "complete", outcome: "succeeded" }],
      ["expired", { displayStatus: "superseded", outcome: "superseded" }],
      ["superseded", { displayStatus: "superseded", outcome: "superseded" }],
      ["failed", { displayStatus: "needs-attention", outcome: "failed" }],
      ["reobserve", { displayStatus: "in-progress", outcome: "pending" }],
    ]);
    expect(transactionJobStates.map((state) => [state, engineJobActivityState(state)])).toEqual([
      ["prepared", { displayStatus: "action-required", outcome: "pending" }],
      ["preflighted", { displayStatus: "action-required", outcome: "pending" }],
      ["awaiting_approval", { displayStatus: "action-required", outcome: "pending" }],
      ["nonce_reserved", { displayStatus: "in-progress", outcome: "pending" }],
      ["broadcast", { displayStatus: "in-progress", outcome: "pending" }],
      ["confirmed", { displayStatus: "in-progress", outcome: "pending" }],
      ["reconciled", { displayStatus: "complete", outcome: "succeeded" }],
      ["blocked", { displayStatus: "needs-attention", outcome: "pending" }],
      ["superseded", { displayStatus: "superseded", outcome: "superseded" }],
      ["ambiguous", { displayStatus: "needs-attention", outcome: "ambiguous" }],
      ["noncanonical_reobserve", { displayStatus: "in-progress", outcome: "pending" }],
    ]);
    expect(walletIntentStates.map((state) => [state, walletIntentActivityStage(state)])).toEqual([
      ["prepared", "review-ready"],
      ["submitted", "submitted"],
      ["mempool", "mempool"],
      ["confirmed", "confirmed"],
      ["complete", "complete"],
      ["expired", "superseded"],
      ["superseded", "superseded"],
      ["failed", "failed"],
      ["reobserve", "reobserving"],
    ]);
    expect(transactionJobStates.map((state) => [state, engineJobActivityStage(state)])).toEqual([
      ["prepared", "review-ready"],
      ["preflighted", "preflighted"],
      ["awaiting_approval", "awaiting-approval"],
      ["nonce_reserved", "nonce-reserved"],
      ["broadcast", "broadcast"],
      ["confirmed", "confirmed"],
      ["reconciled", "complete"],
      ["blocked", "blocked"],
      ["superseded", "superseded"],
      ["ambiguous", "ambiguous"],
      ["noncanonical_reobserve", "reobserving"],
    ]);
  });

  it("distinguishes a recorded transaction ID from verified chain evidence", () => {
    expect(walletIntentSummaryText({ state: "submitted" }, null)).toBe(
      "The transaction ID is recorded, but no canonical transaction evidence has been found yet. Refresh verification to check the local node and indexed API again.",
    );
    expect(walletIntentSummaryText({ state: "mempool" }, { outcome: "mempool" })).toBe(
      "The transaction is in the mempool and is waiting to be included in a block.",
    );
    expect(walletIntentSummaryText({ state: "confirmed" }, { outcome: "confirmed" })).toBe(
      "The transaction is canonical; Sidekick is verifying the expected on-chain result.",
    );
  });

  it("escalates noncanonical re-observation after its bounded recovery deadline", () => {
    const updatedAt = "2026-08-14T11:50:00.000Z";
    expect(
      engineJobActivityPresentation(
        "noncanonical_reobserve",
        updatedAt,
        new Date(Date.parse(updatedAt) + noncanonicalReobserveRecoveryMs - 1),
      ),
    ).toEqual({
      displayStatus: "in-progress",
      outcome: "pending",
      deadline: {
        kind: "time",
        at: new Date(Date.parse(updatedAt) + noncanonicalReobserveRecoveryMs).toISOString(),
      },
    });
    expect(
      engineJobActivityPresentation(
        "noncanonical_reobserve",
        updatedAt,
        new Date(Date.parse(updatedAt) + noncanonicalReobserveRecoveryMs),
      ),
    ).toMatchObject({ displayStatus: "needs-attention", outcome: "pending" });
  });

  it("sorts active work by status, overdue deadline, urgency, update, and id", () => {
    const context = {
      now,
      burnBlockHeight: 200,
      rewardCycleId: 141,
      phase: "reward" as const,
    };
    const items = [
      summary("activity:in-progress", "in-progress", "pending"),
      summary("activity:future", "action-required", "pending", {
        deadline: { kind: "burn-block", burnBlockHeight: 300, estimatedAt: null },
        urgencyAt: "2026-08-14T12:30:00.000Z",
      }),
      summary("activity:no-deadline", "action-required", "pending"),
      summary("activity:overdue-b", "action-required", "pending", {
        deadline: { kind: "burn-block", burnBlockHeight: 199, estimatedAt: null },
        urgencyAt: "2026-08-14T12:20:00.000Z",
      }),
      summary("activity:attention", "needs-attention", "ambiguous"),
      summary("activity:overdue-a", "action-required", "pending", {
        deadline: { kind: "burn-block", burnBlockHeight: 199, estimatedAt: null },
        urgencyAt: "2026-08-14T12:10:00.000Z",
      }),
    ];
    expect(sortActiveActivity(items, context).map(({ activityId }) => activityId)).toEqual([
      "activity:attention",
      "activity:overdue-a",
      "activity:overdue-b",
      "activity:future",
      "activity:no-deadline",
      "activity:in-progress",
    ]);
  });

  it("keeps old unresolved work visible and binds history cursors to the active filters", () => {
    const oldActive = summary("activity:old-active", "in-progress", "pending", {
      updatedAt: "2025-01-01T00:00:00.000Z",
    });
    const terminal = [
      summary("activity:a", "observed", "observed", {
        kind: "configuration-change",
        occurredAt: "2026-08-14T09:00:00.000Z",
        updatedAt: "2026-08-14T11:00:00.000Z",
      }),
      summary("activity:b", "complete", "succeeded", {
        occurredAt: "2026-08-14T10:00:00.000Z",
        updatedAt: "2026-08-14T10:00:00.000Z",
      }),
    ];
    const first = projectActivityPage({
      records: [record(oldActive), ...terminal.map(record)],
      coverage: [{ ...sourceCoverage, source: "wallet-intents" }],
      query: query({ time: "24h", limit: 1 }),
      context: { now, burnBlockHeight: null, rewardCycleId: null, phase: null },
    });
    expect(first.active.map(({ activityId }) => activityId)).toEqual(["activity:old-active"]);
    expect(first.items.map(({ activityId }) => activityId)).toEqual(["activity:b"]);
    expect(first.nextCursor).not.toBeNull();
    expect(
      projectActivityPage({
        records: terminal.map(record),
        coverage: [{ ...sourceCoverage, source: "wallet-intents" }],
        query: query({ time: "24h", cursor: first.nextCursor, limit: 1 }),
        context: { now, burnBlockHeight: null, rewardCycleId: null, phase: null },
      }).items.map(({ activityId }) => activityId),
    ).toEqual(["activity:a"]);
    expect(() =>
      projectActivityPage({
        records: terminal.map(record),
        coverage: [{ ...sourceCoverage, source: "wallet-intents" }],
        query: query({ status: "resolved", cursor: first.nextCursor, limit: 1 }),
        context: { now, burnBlockHeight: null, rewardCycleId: null, phase: null },
      }),
    ).toThrowError(ActivityProjectionError);
  });

  it("uses the same binary tie order for sorting and cursor continuation", () => {
    const records = ["activity:a", "activity:A", "activity:0"].map((id) =>
      record(summary(id, "complete", "succeeded")),
    );
    const context = { now, burnBlockHeight: null, rewardCycleId: null, phase: null };
    let cursor: string | null = null;
    const ids: string[] = [];
    do {
      const page = projectActivityPage({
        records,
        coverage: [sourceCoverage],
        query: query({ limit: 1, cursor }),
        context,
      });
      ids.push(...page.items.map(({ activityId }) => activityId));
      cursor = page.nextCursor;
    } while (cursor);
    expect(ids).toEqual(["activity:0", "activity:A", "activity:a"]);
  });

  it("keeps every closed Activity status reachable through its documented filter", () => {
    const records = [
      record(summary("activity:action", "action-required", "pending")),
      record(summary("activity:progress", "in-progress", "pending")),
      record(summary("activity:attention", "needs-attention", "ambiguous")),
      record(summary("activity:complete", "complete", "succeeded")),
      record(summary("activity:superseded", "superseded", "superseded")),
      record(summary("activity:observed", "observed", "observed", { kind: "chain-event" })),
    ];
    const context = { now, burnBlockHeight: null, rewardCycleId: null, phase: null };
    for (const status of ["action-required", "needs-attention", "in-progress"] as const) {
      const page = projectActivityPage({
        records,
        coverage: [sourceCoverage],
        query: query({ status }),
        context,
      });
      expect(page.active.map(({ displayStatus }) => displayStatus)).toEqual([status]);
      expect(page.items).toEqual([]);
    }
    const resolved = projectActivityPage({
      records,
      coverage: [sourceCoverage],
      query: query({ status: "resolved" }),
      context,
    });
    expect(new Set(resolved.items.map(({ displayStatus }) => displayStatus))).toEqual(
      new Set(["complete", "superseded", "observed"]),
    );
    expect(resolved.active).toEqual([]);
  });

  it("absorbs a verified chain transaction into its wallet operation and resolves the alias", async () => {
    const store = await memoryStore();
    store.chainState.upsertSource({
      sourceId,
      kind: "api",
      network: "mainnet",
      baseUrl: "https://api.mainnet.hiro.so",
      observedAt: now.toISOString(),
    });
    const manifest = { schemaVersion: 2, action: "claim-rewards" };
    const created = store.walletIntents.create({
      action: "claim-rewards",
      scope: "claim-rewards:141",
      factsSha256: "aa".repeat(32),
      manifestSha256: canonicalJsonSha256(manifest),
      manifest,
      requiredSender: actorPrincipal,
      network: "mainnet",
      chainId: 1,
      createdAt: "2026-08-14T10:00:00.000Z",
      expiresAt: "2026-08-14T10:10:00.000Z",
    }).intent;
    store.walletIntents.submit({
      id: created.id,
      txid,
      submittedAt: "2026-08-14T10:05:00.000Z",
    });
    store.walletIntents.appendObservation({
      intentId: created.id,
      outcome: "canonical-success",
      canonical: true,
      blockHeight: 8_750_000,
      indexBlockHash,
      observedAt: "2026-08-14T10:06:00.000Z",
      evidence: { decoded: { executionSource: "api" } },
    });
    store.putChainEvent({
      chainId: 1,
      txId: txid,
      eventIndex: 0,
      blockHeight: 8_750_000,
      blockHash,
      indexBlockHash,
      microblockHash: null,
      microblockSequence: null,
      canonical: true,
      microblockCanonical: true,
      contractId: managerPrincipal,
      topic: "print",
      rawPayload: { omitted: true },
      decodedSchemaVersion: 1,
      decodedPayload: {
        event: { kind: "claim-staker-rewards", stakerPrincipal: actorPrincipal },
      },
      sourceId,
      observedAt: "2026-08-14T10:06:00.000Z",
    });
    store.chainState.putCursor({
      sourceId,
      stream: managerEventStream(managerPrincipal, "generic-v1"),
      cursor: null,
      lastBlockHeight: 8_750_000,
      lastIndexBlockHash: indexBlockHash,
      updatedAt: "2026-08-14T10:06:00.000Z",
    });
    const service = new ActivityProjectionService({
      store,
      chainId: 1,
      managerPrincipal,
      sourceId: () => sourceId,
      now: () => now,
    });
    const page = service.page(query({ time: "all" }));
    expect(page.active).toHaveLength(1);
    expect(page.items).toHaveLength(0);
    expect(page.active[0]?.activityId).toBe(`wallet-intent:${created.id}`);

    const listActive = vi.spyOn(store.activity, "activeKeys");
    const listHistory = vi.spyOn(store.activity, "historyKeys");
    const listEngineHistory = vi.spyOn(store.transactionEngine, "listLogicalJobs");
    const listSettingsHistory = vi.spyOn(store.runtimeSettings, "listAudit");
    const alias = `chain-tx:1:${txid}`;
    const detail = service.detail(alias);
    expect(detail).toMatchObject({
      requestedActivityId: alias,
      canonicalActivityId: `wallet-intent:${created.id}`,
      aliases: expect.arrayContaining([alias, `wallet-intent:${created.id}`]),
    });
    expect(detail?.timeline.some(({ code }) => code === "transaction-id-reported")).toBe(true);
    expect(
      detail?.timeline.some(({ detail }) => detail.includes("Execution evidence: configured API.")),
    ).toBe(true);
    expect(detail?.timeline.some(({ code }) => code === "verified-chain-event")).toBe(true);
    expect(detail?.summary.coverage.map(({ source }) => source)).toEqual(
      expect.arrayContaining(["wallet-intents", "indexed-manager-history"]),
    );
    expect(listActive).not.toHaveBeenCalled();
    expect(listHistory).not.toHaveBeenCalled();
    expect(listEngineHistory).not.toHaveBeenCalled();
    expect(listSettingsHistory).not.toHaveBeenCalled();
  });

  it("shows verified staker actions for this pool without indexing other managers", async () => {
    const store = await memoryStore();
    store.chainState.upsertSource({
      sourceId,
      kind: "api",
      network: "mainnet",
      baseUrl: "https://api.mainnet.hiro.so",
      observedAt: now.toISOString(),
    });
    store.putChainEvent({
      chainId: 1,
      txId: txid,
      eventIndex: 3,
      blockHeight: 8_750_000,
      blockHash,
      indexBlockHash,
      microblockHash: null,
      microblockSequence: null,
      canonical: true,
      microblockCanonical: true,
      contractId: pox5ContractId,
      topic: "stake-update",
      rawPayload: { omitted: true },
      decodedSchemaVersion: 1,
      decodedPayload: {
        event: {
          kind: "stake-update",
          relationship: "joined",
          stakerPrincipal: actorPrincipal,
          signer: managerPrincipal,
        },
      },
      sourceId,
      occurredAt: "2026-08-01T09:30:00.000Z",
      observedAt: "2026-08-14T10:06:00.000Z",
    });
    store.chainState.putCursor({
      sourceId,
      stream: pox5PoolActivityStream(pox5ContractId, managerPrincipal),
      cursor: null,
      lastBlockHeight: 8_750_000,
      lastIndexBlockHash: indexBlockHash,
      updatedAt: "2026-08-14T10:06:00.000Z",
    });
    const service = new ActivityProjectionService({
      store,
      chainId: 1,
      managerPrincipal,
      pox5ContractId: () => pox5ContractId,
      sourceId: () => sourceId,
      now: () => now,
    });

    const page = service.page(query({ domain: "pool" }));
    expect(page.items).toEqual([
      expect.objectContaining({
        domain: "pool",
        title: "Staker moved into the pool",
        actorPrincipal,
        occurredAt: "2026-08-01T09:30:00.000Z",
        updatedAt: "2026-08-14T10:06:00.000Z",
        coverage: expect.arrayContaining([
          expect.objectContaining({ source: "indexed-pool-history", status: "current" }),
        ]),
      }),
    ]);
    expect(service.detail(`chain-tx:1:${txid}`)?.timeline).toContainEqual(
      expect.objectContaining({
        source: "indexed-pool-history",
        txid,
        occurredAt: "2026-08-01T09:30:00.000Z",
      }),
    );
    expect(service.page(query({ domain: "pool", time: "24h" })).items).toEqual([]);
  });

  it("attributes scheduled initiation without claiming a human approved the recipe", async () => {
    const store = await memoryStore();
    const run = insertCompletedRewardRun(store);
    const service = new ActivityProjectionService({
      store,
      chainId: 1,
      managerPrincipal,
      pox5ContractId: () => pox5ContractId,
      sourceId: () => sourceId,
      now: () => now,
    });
    const approval = () =>
      service
        .detail(`reward-run:${run.runId}`)
        ?.timeline.find((entry) => entry.code === "recipe-approved");
    expect(approval()?.detail).toContain("operator approved");
    store.rewardSchedule.track(run.runId, now.toISOString());
    expect(approval()?.detail).toContain("prepared by the automatic schedule");
    expect(approval()?.detail).not.toContain("operator approved");
  });

  it("groups transaction events and excludes an off-page owner before key pagination", async () => {
    const store = await memoryStore();
    const run = insertCompletedRewardRun(store);
    store.chainState.upsertSource({
      sourceId,
      kind: "api",
      network: "mainnet",
      baseUrl: "https://api.mainnet.hiro.so",
      observedAt: now.toISOString(),
    });
    const firstTx = `0x${"44".repeat(32)}`;
    const secondTx = `0x${"55".repeat(32)}`;
    for (const [txId, eventIndex, occurredAt] of [
      [txid, 0, "2026-08-14T12:00:00.000Z"],
      [firstTx, 0, "2026-08-14T12:00:00.000Z"],
      [firstTx, 1, "2026-08-14T11:30:00.000Z"],
      [secondTx, 0, "2026-08-14T11:45:00.000Z"],
    ] as const) {
      store.putChainEvent({
        chainId: 1,
        txId,
        eventIndex,
        occurredAt,
        blockHeight: 8_750_000,
        blockHash,
        indexBlockHash,
        microblockHash: null,
        microblockSequence: null,
        canonical: true,
        microblockCanonical: true,
        contractId: managerPrincipal,
        topic: "print",
        rawPayload: {},
        decodedSchemaVersion: 1,
        decodedPayload: {
          event: { kind: "claim-staker-rewards", stakerPrincipal: actorPrincipal },
        },
        sourceId,
        observedAt: now.toISOString(),
      });
    }
    const service = new ActivityProjectionService({
      store,
      chainId: 1,
      managerPrincipal,
      sourceId: () => sourceId,
      now: () => now,
    });
    let cursor: string | null = null;
    const ids: string[] = [];
    do {
      const page = service.page(query({ limit: 1, cursor }));
      ids.push(...page.items.map(({ activityId }) => activityId));
      cursor = page.nextCursor;
    } while (cursor);
    expect(ids).toEqual([
      `chain-tx:1:${secondTx}`,
      `chain-tx:1:${firstTx}`,
      `reward-run:${run.runId}`,
    ]);
    expect(service.detail(`chain-tx:1:${firstTx}`)?.timeline).toHaveLength(2);
  });

  it("projects completed recipe runs as actions and resolves their transaction aliases", async () => {
    const store = await memoryStore();
    const run = insertCompletedRewardRun(store);
    const service = new ActivityProjectionService({
      store,
      chainId: 1,
      managerPrincipal,
      sourceId: () => sourceId,
      now: () => now,
    });

    const page = service.page(query({ type: "actions" }));
    expect(page.items).toContainEqual(
      expect.objectContaining({
        activityId: `reward-run:${run.runId}`,
        title: "Collect rewards",
        displayStatus: "complete",
        outcome: "succeeded",
        deadline: null,
        urgencyAt: null,
        txids: [txid],
      }),
    );
    expect(service.detail(`chain-tx:1:${txid}`)).toMatchObject({
      canonicalActivityId: `reward-run:${run.runId}`,
      aliases: expect.arrayContaining([`chain-tx:1:${txid}`, `reward-run:${run.runId}`]),
      summary: { stage: "complete" },
    });
    store.rewardRuns.updateChild({
      runId: run.runId,
      childIndex: 0,
      from: ["confirmed"],
      to: "confirmed",
      now: now.toISOString(),
      provenance: "you",
      executionSource: "api",
    });
    expect(service.detail(`chain-tx:1:${txid}`)?.timeline).toContainEqual(
      expect.objectContaining({
        txid,
        detail: expect.stringContaining("Transaction execution evidence: configured API."),
      }),
    );
  });

  it("links an expired transaction review to the replacement for the same operation scope", async () => {
    const store = await memoryStore();
    const manifest = { schemaVersion: 2, action: "claim-rewards" };
    const first = store.walletIntents.create({
      action: "claim-rewards",
      scope: "claim-rewards:141",
      factsSha256: "aa".repeat(32),
      manifestSha256: canonicalJsonSha256(manifest),
      manifest,
      requiredSender: actorPrincipal,
      network: "mainnet",
      chainId: 1,
      createdAt: "2026-08-14T10:00:00.000Z",
      expiresAt: "2026-08-14T10:10:00.000Z",
    }).intent;
    const replacement = store.walletIntents.create({
      action: "claim-rewards",
      scope: "claim-rewards:141",
      factsSha256: "bb".repeat(32),
      manifestSha256: canonicalJsonSha256(manifest),
      manifest,
      requiredSender: actorPrincipal,
      network: "mainnet",
      chainId: 1,
      createdAt: "2026-08-14T11:00:00.000Z",
      expiresAt: "2026-08-14T11:10:00.000Z",
    }).intent;
    const service = new ActivityProjectionService({
      store,
      chainId: 1,
      managerPrincipal,
      sourceId: () => sourceId,
      now: () => now,
    });

    expect(service.detail(`wallet-intent:${first.id}`)?.summary).toMatchObject({
      displayStatus: "superseded",
      supersededByActivityId: `wallet-intent:${replacement.id}`,
    });
    expect(service.detail(`wallet-intent:${replacement.id}`)?.summary).toMatchObject({
      supersedesActivityId: `wallet-intent:${first.id}`,
    });
  });

  it("reads the cached chain context used for structured-deadline ordering", async () => {
    const store = await memoryStore();
    let contextReads = 0;
    const service = new ActivityProjectionService({
      store,
      chainId: 1,
      managerPrincipal,
      sourceId: () => sourceId,
      now: () => now,
      context: () => {
        contextReads += 1;
        return { burnBlockHeight: 962_250, rewardCycleId: 141, phase: "reward" };
      },
    });

    expect(service.page(query())).toMatchObject({
      schemaVersion: 1,
      active: [],
      items: [],
    });
    expect(contextReads).toBe(1);
  });

  it("uses batched summary evidence instead of per-record timeline reads on the polled page", async () => {
    const store = await memoryStore();
    const manifest = { schemaVersion: 2, action: "claim-rewards" };
    store.walletIntents.create({
      action: "claim-rewards",
      scope: "claim-rewards:141",
      factsSha256: "aa".repeat(32),
      manifestSha256: canonicalJsonSha256(manifest),
      manifest,
      requiredSender: actorPrincipal,
      network: "mainnet",
      chainId: 1,
      createdAt: "2026-08-14T10:00:00.000Z",
      expiresAt: "2026-08-14T10:10:00.000Z",
    });
    const listObservations = vi.spyOn(store.walletIntents, "listObservations");
    const listLatestObservations = vi.spyOn(
      store.walletIntents,
      "listLatestObservationsForActivity",
    );
    const listAttempts = vi.spyOn(store.transactionEngine, "listAttempts");
    const listAttemptsForActivity = vi.spyOn(store.transactionEngine, "listAttemptsForActivity");
    const service = new ActivityProjectionService({
      store,
      chainId: 1,
      managerPrincipal,
      sourceId: () => sourceId,
      now: () => now,
    });

    expect(service.page(query()).active).toHaveLength(1);
    expect(listLatestObservations).toHaveBeenCalledOnce();
    expect(listAttemptsForActivity).not.toHaveBeenCalled();
    expect(listObservations).not.toHaveBeenCalled();
    expect(listAttempts).not.toHaveBeenCalled();
  });

  it("paginates all terminal history instead of truncating the newest 10000", async () => {
    const store = await memoryStore();
    for (let index = 0; index < 10_001; index += 1) {
      store.runtimeSettings.put({
        settings: {},
        apiCredentials: {},
        changedFields: ["dataSources.nodeRpcUrl"],
        observedAt: new Date(now.getTime() - index * 1_000).toISOString(),
      });
    }
    const service = new ActivityProjectionService({
      store,
      chainId: 1,
      managerPrincipal,
      sourceId: () => sourceId,
      now: () => now,
    });
    const history = vi.spyOn(store.activity, "historyKeys");
    const detail = vi.spyOn(store.runtimeSettings, "getAudit");
    expect(service.active().active).toEqual([]);
    expect(history).not.toHaveBeenCalled();
    expect(detail).not.toHaveBeenCalled();
    const page = service.page(query({ type: "configuration", limit: 100 }));
    expect(page.items).toHaveLength(100);
    expect(detail).toHaveBeenCalledTimes(101);
    expect(page.coverage).toContainEqual(
      expect.objectContaining({
        source: "settings-audit",
        status: "current",
        reason: null,
      }),
    );
    let cursor = page.nextCursor;
    const ids = new Set(page.items.map(({ activityId }) => activityId));
    while (cursor) {
      const next = service.page(query({ type: "configuration", limit: 100, cursor }));
      for (const { activityId } of next.items) {
        expect(ids.has(activityId)).toBe(false);
        ids.add(activityId);
      }
      cursor = next.nextCursor;
    }
    expect(ids.size).toBe(10_001);
    expect(ids.has("settings:10001")).toBe(true);
  }, 30_000);

  it("bounds selective scans and returns a continuation even when a page has no matches", async () => {
    const store = await memoryStore();
    for (let index = 0; index < 205; index += 1) {
      store.runtimeSettings.put({
        settings: {},
        apiCredentials: {},
        changedFields: ["fee"],
        observedAt: new Date(now.getTime() - index * 1_000).toISOString(),
      });
    }
    const service = new ActivityProjectionService({
      store,
      chainId: 1,
      managerPrincipal,
      sourceId: () => sourceId,
      now: () => now,
    });
    const detail = vi.spyOn(store.runtimeSettings, "getAudit");
    const first = service.page(query({ search: "settings:205" }));
    expect(first.items).toEqual([]);
    expect(first.nextCursor).not.toBeNull();
    expect(detail).toHaveBeenCalledTimes(200);
    const last = service.page(query({ search: "settings:205", cursor: first.nextCursor }));
    expect(last.items.map(({ activityId }) => activityId)).toEqual(["settings:205"]);
    expect(last.nextCursor).toBeNull();
  });
});
