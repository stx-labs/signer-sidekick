import type {
  ActivityCoverage,
  ActivityDisplayStatus,
  ActivityGroupSummary,
  ActivityOutcome,
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
} from "./activity-projection.js";
import { managerEventStream } from "./manager-event-vocabulary.js";
import { createChainSourceId, openSidekickStore, type SidekickStore } from "./storage/store.js";
import { canonicalJsonSha256, walletIntentStates } from "./storage/wallet-intent-repository.js";
import { transactionJobStates } from "./transaction-engine/state-machine.js";

const now = new Date("2026-08-14T12:00:00.000Z");
const managerPrincipal = "SP000000000000000000002Q6VF78.signer-manager";
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

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

describe("Activity projection", () => {
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
        updatedAt: "2026-08-14T11:00:00.000Z",
      }),
      summary("activity:b", "complete", "succeeded", {
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
    expect(first.items.map(({ activityId }) => activityId)).toEqual(["activity:a"]);
    expect(first.nextCursor).not.toBeNull();
    expect(() =>
      projectActivityPage({
        records: terminal.map(record),
        coverage: [{ ...sourceCoverage, source: "wallet-intents" }],
        query: query({ status: "resolved", cursor: first.nextCursor, limit: 1 }),
        context: { now, burnBlockHeight: null, rewardCycleId: null, phase: null },
      }),
    ).toThrowError(ActivityProjectionError);
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
    store.upsertChainSource({
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
    store.putCursor({
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

    const alias = `chain-tx:1:${txid}`;
    const detail = service.detail(alias);
    expect(detail).toMatchObject({
      requestedActivityId: alias,
      canonicalActivityId: `wallet-intent:${created.id}`,
      aliases: expect.arrayContaining([alias, `wallet-intent:${created.id}`]),
    });
    expect(detail?.timeline.some(({ code }) => code === "transaction-id-reported")).toBe(true);
    expect(detail?.timeline.some(({ code }) => code === "verified-chain-event")).toBe(true);
    expect(detail?.summary.coverage.map(({ source }) => source)).toEqual(
      expect.arrayContaining(["wallet-intents", "indexed-manager-history"]),
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
    expect(listAttemptsForActivity).toHaveBeenCalledOnce();
    expect(listObservations).not.toHaveBeenCalled();
    expect(listAttempts).not.toHaveBeenCalled();
  });

  it("degrades bounded terminal coverage instead of failing the Activity page", () => {
    const settingsAudit = Array.from({ length: 10_001 }, (_, index) => ({
      revision: index + 1,
      changedFields: ["dataSources.nodeRpcUrl"],
      changedAt: new Date(now.getTime() - index * 1_000).toISOString(),
    }));
    const store = {
      walletIntents: {
        listForActivity: () => [],
        listActiveForActivity: () => [],
        listObservations: () => [],
        listLatestObservationsForActivity: () => new Map(),
      },
      transactionEngine: {
        listLogicalJobs: () => ({ items: [], nextCursor: null, total: 0 }),
        listAttemptsForActivity: () => new Map(),
      },
      listManagerActivityChainEvents: () => [],
      listSettingsAudit: () => settingsAudit,
      getCursor: () => null,
    } as unknown as SidekickStore;
    const service = new ActivityProjectionService({
      store,
      chainId: 1,
      managerPrincipal,
      sourceId: () => sourceId,
      now: () => now,
    });

    const page = service.page(query());
    expect(page.items).toHaveLength(50);
    expect(page.items[0]?.coverage).toContainEqual(
      expect.objectContaining({ source: "settings-audit", status: "current" }),
    );
    expect(page.coverage).toContainEqual(
      expect.objectContaining({
        source: "settings-audit",
        status: "delayed",
        reason: expect.stringContaining("newest 10000"),
      }),
    );
  });
});
