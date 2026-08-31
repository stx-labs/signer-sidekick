import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { bufferCV, someCV, trueCV, tupleCV, uintCV } from "@stacks/transactions";
import type { DashboardSnapshot } from "@stx-labs/signer-sidekick-api-contracts";
import {
  REFERENCE_MANAGER_PUBLIC_FUNCTIONS,
  REFERENCE_MANAGER_READ_ONLY_FUNCTIONS,
} from "@stx-labs/signer-sidekick-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RateLimitedError, type StacksApiClient, type StacksNodeClient } from "./chain-clients.js";
import type { SidekickConfig } from "./config.js";
import {
  buildAlerts,
  OperatorService,
  type OperatorServiceOptions,
  observeTransactionEngineSafely,
  sortPoolRoster,
  sortRewardStakers,
} from "./operator-service.js";
import { openSidekickStore, type SidekickStore } from "./storage/store.js";

const stores: SidekickStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function alertInput(options: {
  belowThreshold?: boolean;
  readinessBlocked?: boolean;
  cycles?: Array<{
    cycleId: number;
    status: "ready" | "attention";
    meetsThreshold: boolean;
    thresholdUstx?: string;
  }>;
}) {
  const thresholdUstx = "75000000000";
  return {
    preflight: {
      checks: [],
      cycle: { nextId: 144, isPreparePhase: false, blocksUntilPreparePhase: 100 },
    },
    manager: {
      attachAllowed: true,
      automationEligibilityReason: "Manager source is not recognized",
      source: { tier: "reference-built-in" },
      installedProfiles: { issues: [] },
    },
    readiness: options.readinessBlocked
      ? {
          status: "blocked",
          checks: [{ id: "signer-grant", status: "fail", message: "Grant is revoked" }],
        }
      : { status: "ready", checks: [] },
    forecast: {
      status: "attention",
      cycles: options.cycles?.map(
        ({ cycleId, status, meetsThreshold, thresholdUstx: cycleThreshold }) => ({
          cycleId,
          status,
          threshold: { meetsThreshold, thresholdUstx: cycleThreshold ?? thresholdUstx },
        }),
      ) ?? [
        {
          cycleId: 144,
          status: "attention",
          threshold: { meetsThreshold: !options.belowThreshold, thresholdUstx },
        },
      ],
    },
    rewards: null,
    activity: { pendingWithdrawalTotal: 0 },
  } as unknown as Parameters<typeof buildAlerts>[0];
}

describe("operator service", () => {
  it("sorts roster and reward pages before pagination", () => {
    const roster = [
      {
        stakerPrincipal: "SPZ",
        active: true,
        hasStx: true,
        stxNodeVerified: true,
        bond: null,
        position: {
          amountUstx: "10",
          firstRewardCycle: "12",
          numCycles: "1",
          unlockCycle: "13",
          unlockBurnHeight: "100",
          active: true,
        },
      },
      {
        stakerPrincipal: "SPA",
        active: true,
        hasStx: true,
        stxNodeVerified: true,
        bond: null,
        position: {
          amountUstx: "20",
          firstRewardCycle: "12",
          numCycles: "1",
          unlockCycle: "13",
          unlockBurnHeight: "100",
          active: true,
        },
      },
    ] as DashboardSnapshot["roster"];
    const stakers = [
      {
        stakerPrincipal: "SPZ",
        payout: { kind: "direct-sbtc", maxFeeSats: "0", poxAddress: null },
        rewards: { grossSats: "1", feeSats: "0", earnedSats: "1" },
        claimableByPolicy: false,
      },
      {
        stakerPrincipal: "SPA",
        payout: { kind: "direct-sbtc", maxFeeSats: "0", poxAddress: null },
        rewards: { grossSats: "20", feeSats: "0", earnedSats: "20" },
        claimableByPolicy: true,
      },
    ] as NonNullable<DashboardSnapshot["rewards"]>["stakers"];

    expect(
      sortPoolRoster(roster, "amount", "desc").map(({ stakerPrincipal }) => stakerPrincipal),
    ).toEqual(["SPA", "SPZ"]);
    expect(
      sortRewardStakers(stakers, "net", "desc").map(({ stakerPrincipal }) => stakerPrincipal),
    ).toEqual(["SPA", "SPZ"]);
  });

  it("persists and reuses the node-readable Bitcoin payout transaction", async () => {
    const { store } = await openSidekickStore(":memory:");
    stores.push(store);
    const registry = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-registry";
    const callReadOnly = vi
      .fn()
      .mockResolvedValueOnce(someCV(tupleCV({ status: someCV(trueCV()) })))
      .mockResolvedValueOnce(
        someCV(
          tupleCV({
            "sweep-txid": bufferCV(Uint8Array.from({ length: 32 }, () => 0x44)),
            "sweep-burn-height": uintCV(963_758),
            "sweep-burn-hash": bufferCV(Uint8Array.from({ length: 32 }, () => 0x55)),
          }),
        ),
      );
    const service = new OperatorService({
      config: {
        network: "mainnet",
        nodeRpcUrl: "http://127.0.0.1:20443",
        apiUrl: "https://api.mainnet.hiro.so",
        apiKeyHeader: "x-api-key",
        maxApiBurnBlockLag: 12,
        forecastHorizonCycles: 6,
        databasePath: ":memory:",
      },
      managerPrincipal: "SP000000000000000000002Q6VF78.signer-manager",
      store,
      node: { callReadOnly } as unknown as StacksNodeClient,
      api: {} as StacksApiClient,
    });
    const requests = [{ requestId: "2684", initiatedBlockHeight: 8_800_000 }];
    const first = await service.withdrawalRequestEvidence(registry, requests, undefined);
    expect(first.get("2684")).toMatchObject({
      status: "accepted",
      completion: { sweepTxId: `0x${"44".repeat(32)}`, bitcoinBlockHeight: 963_758 },
    });
    const second = await service.withdrawalRequestEvidence(registry, requests, undefined);
    expect(second).toEqual(first);
    expect(callReadOnly).toHaveBeenCalledTimes(2);
  });

  it("contains transaction-engine failures at the optional observation boundary", async () => {
    const failure = new Error("engine unavailable");
    const onError = vi.fn();

    await expect(
      observeTransactionEngineSafely(
        { observe: async () => await Promise.reject(failure), onError },
        {
          setup: {} as never,
          rewards: null,
          sourceId: "api:mainnet:test",
          observedAt: "2026-07-17T12:00:00.000Z",
        },
      ),
    ).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it("contains synchronous engine failures and coalesces slow observations", async () => {
    const syncError = new Error("sync engine failure");
    const throwingOnError = vi.fn(() => {
      throw new Error("reporter failure");
    });
    await expect(
      observeTransactionEngineSafely(
        {
          observe: () => {
            throw syncError;
          },
          onError: throwingOnError,
        },
        {
          setup: {} as never,
          rewards: null,
          sourceId: "api:mainnet:test",
          observedAt: "2026-07-17T12:00:00.000Z",
        },
      ),
    ).resolves.toBeUndefined();
    expect(throwingOnError).toHaveBeenCalledWith(syncError);

    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const hook = { observe: vi.fn(async () => pending) };
    const input = {
      setup: {} as never,
      rewards: null,
      sourceId: "api:mainnet:test",
      observedAt: "2026-07-17T12:00:00.000Z",
    };
    await observeTransactionEngineSafely(hook, input, 1);
    await observeTransactionEngineSafely(hook, input, 1);
    expect(hook.observe).toHaveBeenCalledOnce();
    release?.();
    await pending;
  });

  it("separates external signing from reviewed execution and keeps stable transition IDs", () => {
    const input = alertInput({});
    input.manager.source.tier = "unrecognized";
    input.trustTransition = {
      transition: "lost",
      reason: "Installed profile could not be reproduced",
      changedAt: "2026-07-16T12:00:00.000Z",
    };
    expect(buildAlerts(input)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "manager:custom-capabilities",
          severity: "info",
          title: "Custom Manager Connected",
          detail: expect.stringContaining("Core PoX-5 monitoring is available"),
        }),
        expect.objectContaining({
          id: "manager:trust-transition-lost:2026-07-16T12:00:00.000Z",
          severity: "critical",
          title: "Manager Execution Eligibility Lost",
        }),
      ]),
    );
  });

  it("surfaces recognition-only degradation without calling it eligibility loss", () => {
    const input = alertInput({});
    input.manager.source.tier = "unrecognized";
    input.trustTransition = {
      transition: "degraded",
      reason: "Installed profile was removed",
      changedAt: "2026-07-16T12:00:00.000Z",
    };
    expect(buildAlerts(input)).toContainEqual(
      expect.objectContaining({
        id: "manager:trust-transition-degraded:2026-07-16T12:00:00.000Z",
        severity: "warning",
        title: "Manager Recognition Degraded",
      }),
    );
  });

  it("describes connection and manager compatibility alerts", () => {
    const input = alertInput({});
    input.forecast = null;
    input.preflight.checks = [
      { id: "stacks-api", status: "fail", message: "Stacks API is unavailable" },
    ] as typeof input.preflight.checks;
    input.manager.attachAllowed = false;
    input.manager.reasons = ["Manager network does not match"];
    input.manager.installedProfiles.issues = [{}] as typeof input.manager.installedProfiles.issues;

    expect(buildAlerts(input)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "preflight:stacks-api",
          detail: "Stacks API is unavailable.",
        }),
        expect.objectContaining({
          id: "manager:unsupported",
          detail: "Manager network does not match.",
        }),
        expect.objectContaining({
          id: "manager:profile-load-issues",
          detail: "1 manager profile could not be loaded.",
        }),
      ]),
    );
  });

  it("uses the live threshold and preserves readiness alerts", () => {
    const alerts = buildAlerts(alertInput({ belowThreshold: true, readinessBlocked: true }));
    expect(alerts).toContainEqual(
      expect.objectContaining({
        id: "pool:forecast-attention",
        title: "Pool Below Signer-Set Threshold",
        detail: "The pool is below the 75,000 STX signer-set threshold in reward cycle 144.",
      }),
    );
    expect(alerts).toContainEqual(
      expect.objectContaining({
        id: "readiness:blocked",
        detail: "Grant is revoked.",
      }),
    );
  });

  it("keeps generic forecast attention separate from a threshold warning", () => {
    expect(buildAlerts(alertInput({}))).toContainEqual(
      expect.objectContaining({
        title: "Pool Forecast Needs Attention",
        detail: "Pool checks need attention for reward cycle 144.",
      }),
    );
  });

  it("limits the signer-set threshold alert to the next cycle", () => {
    const alerts = buildAlerts({
      ...alertInput({
        cycles: [
          { cycleId: 5, status: "ready", meetsThreshold: true },
          { cycleId: 6, status: "attention", meetsThreshold: false },
          {
            cycleId: 7,
            status: "attention",
            meetsThreshold: false,
            thresholdUstx: "80000000000",
          },
        ],
      }),
      preflight: {
        checks: [],
        cycle: { nextId: 6, isPreparePhase: false, blocksUntilPreparePhase: 100 },
      },
    } as Parameters<typeof buildAlerts>[0]);

    expect(alerts).toContainEqual(
      expect.objectContaining({
        title: "Pool Below Signer-Set Threshold",
        detail: "The pool is below the 75,000 STX signer-set threshold in reward cycle 6.",
      }),
    );
  });

  it("does not alert for attention beyond the next cycle", () => {
    const alerts = buildAlerts(
      alertInput({
        cycles: [
          { cycleId: 5, status: "ready", meetsThreshold: true },
          { cycleId: 6, status: "ready", meetsThreshold: true },
          { cycleId: 7, status: "attention", meetsThreshold: false },
          { cycleId: 8, status: "attention", meetsThreshold: false },
          { cycleId: 9, status: "attention", meetsThreshold: false },
          { cycleId: 10, status: "attention", meetsThreshold: false },
        ],
      }),
    );

    expect(alerts).not.toContainEqual(expect.objectContaining({ id: "pool:forecast-attention" }));
  });

  it("does not present a locked signer set as a required action", () => {
    const input = alertInput({
      cycles: [
        { cycleId: 143, status: "attention", meetsThreshold: false },
        { cycleId: 144, status: "attention", meetsThreshold: false },
        { cycleId: 145, status: "ready", meetsThreshold: true },
      ],
    });
    input.preflight.cycle = {
      nextId: 144,
      isPreparePhase: true,
      blocksUntilPreparePhase: 0,
    } as typeof input.preflight.cycle;

    expect(buildAlerts(input)).not.toContainEqual(
      expect.objectContaining({ id: "pool:forecast-attention" }),
    );
  });

  it("moves the threshold action to the first cycle that can still change", () => {
    const input = alertInput({
      cycles: [
        { cycleId: 143, status: "ready", meetsThreshold: true },
        { cycleId: 144, status: "attention", meetsThreshold: false },
        { cycleId: 145, status: "attention", meetsThreshold: false },
      ],
    });
    input.preflight.cycle = {
      nextId: 144,
      isPreparePhase: true,
      blocksUntilPreparePhase: 0,
    } as typeof input.preflight.cycle;

    expect(buildAlerts(input)).toContainEqual(
      expect.objectContaining({
        id: "pool:forecast-attention",
        detail: "The pool is below the 75,000 STX signer-set threshold in reward cycle 145.",
      }),
    );
  });

  it("describes incomplete roster and pending withdrawal alerts", () => {
    const input = alertInput({});
    input.forecast = null;
    input.rewards = { status: "attention" } as typeof input.rewards;
    input.activity.pendingWithdrawalTotal = 2;
    expect(buildAlerts(input)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "rewards:incomplete",
          detail: "The individual staker roster has not been synced.",
        }),
        expect.objectContaining({
          id: "withdrawals:pending",
          title: "Bitcoin Withdrawals Await Resolution",
          detail: "2 Bitcoin withdrawal requests remain pending.",
        }),
      ]),
    );
  });

  it("does not classify informational manager modes as required actions", () => {
    const input = alertInput({});
    input.forecast = null;
    input.manager.source.tier = "custom-observe";
    const alert = buildAlerts(input).find(({ id }) => id === "manager:custom-capabilities");
    expect(alert).toMatchObject({
      severity: "info",
      title: "Custom Manager Connected",
      detail: expect.stringContaining("reviewed adapter"),
    });
    expect(alert).not.toHaveProperty("action");
  });

  it("waits for an older load before starting a forced snapshot", async () => {
    const { store } = await openSidekickStore(":memory:");
    stores.push(store);
    const config: SidekickConfig = {
      network: "mainnet",
      nodeRpcUrl: "http://127.0.0.1:20443",
      apiUrl: "https://api.mainnet.hiro.so",
      apiKeyHeader: "x-api-key",
      maxApiBurnBlockLag: 12,
      forecastHorizonCycles: 6,
      databasePath: ":memory:",
    };
    const service = new OperatorService({
      config,
      managerPrincipal: "SP000000000000000000002Q6VF78.signer-manager",
      store,
      node: {} as StacksNodeClient,
      api: {} as StacksApiClient,
    } satisfies OperatorServiceOptions);
    let releaseFirst: ((value: unknown) => void) | undefined;
    const first = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const internal = service as unknown as { load: () => Promise<unknown> };
    internal.load = async () => {
      calls += 1;
      return calls === 1 ? await first : { version: 2 };
    };

    const stale = service.snapshot();
    const forced = service.snapshot(true);
    await Promise.resolve();
    expect(calls).toBe(1);
    releaseFirst?.({ version: 1 });
    await expect(stale).resolves.toEqual({ version: 1 });
    await expect(forced).resolves.toEqual({ version: 2 });
    expect(calls).toBe(2);
  });

  it("serves last-good summary metadata after a refresh failure", async () => {
    const { store } = await openSidekickStore(":memory:");
    stores.push(store);
    const service = new OperatorService({
      config: {
        network: "mainnet",
        nodeRpcUrl: "http://127.0.0.1:20443",
        apiUrl: "https://api.mainnet.hiro.so",
        apiKeyHeader: "x-api-key",
        maxApiBurnBlockLag: 12,
        forecastHorizonCycles: 6,
        databasePath: ":memory:",
      },
      managerPrincipal: "SP000000000000000000002Q6VF78.signer-manager",
      store,
      node: {} as StacksNodeClient,
      api: {} as StacksApiClient,
      cacheTtlMs: 0,
    });
    const generatedAt = "2026-07-19T18:00:00.000Z";
    const load = vi
      .fn()
      .mockResolvedValueOnce({
        generatedAt,
        roster: [],
        rewards: null,
        activity: { withdrawals: [] },
      })
      .mockRejectedValue(new Error("upstream unavailable"));
    (service as unknown as { load: typeof load }).load = load;

    await expect(service.summary()).resolves.toMatchObject({
      freshness: { status: "current", snapshotGeneratedAt: generatedAt, reason: null },
    });
    await expect(service.summary()).resolves.toMatchObject({
      generatedAt,
      freshness: { status: "stale", reason: "refreshing" },
    });
    await Promise.resolve();
    await Promise.resolve();
    await expect(service.summary()).resolves.toMatchObject({
      generatedAt,
      freshness: {
        status: "stale",
        snapshotGeneratedAt: generatedAt,
        reason: "refresh-failed",
      },
    });
  });

  it("retains the last chain-authoritative health context across cache invalidation", async () => {
    const { store } = await openSidekickStore(":memory:");
    stores.push(store);
    const service = new OperatorService({
      config: {
        network: "mainnet",
        nodeRpcUrl: "http://127.0.0.1:20443",
        apiUrl: "https://api.mainnet.hiro.so",
        apiKeyHeader: "x-api-key",
        maxApiBurnBlockLag: 12,
        forecastHorizonCycles: 6,
        databasePath: ":memory:",
      },
      managerPrincipal: "SP000000000000000000002Q6VF78.signer-manager",
      store,
      node: {} as StacksNodeClient,
      api: {} as StacksApiClient,
      cacheTtlMs: 0,
    });
    const generatedAt = "2026-07-19T18:00:00.000Z";
    const snapshot = {
      generatedAt,
      network: "mainnet",
      managerPrincipal: "SP000000000000000000002Q6VF78.signer-manager",
      preflight: { cycle: { currentId: 141, nextId: 142 } },
      registration: {
        registered: true,
        signerKeyHex: `02${"11".repeat(32)}`,
        signerKeyGrantValid: true,
      },
      forecast: {
        cycles: [
          { cycleId: 141, contract: { inSignerSet: true } },
          { cycleId: 142, contract: { inSignerSet: false } },
        ],
      },
    };
    const load = vi
      .fn()
      .mockResolvedValueOnce(snapshot)
      .mockRejectedValueOnce(new Error("upstream unavailable"));
    (service as unknown as { load: typeof load }).load = load;

    await expect(service.snapshot()).resolves.toBe(snapshot);
    const retained = service.healthMonitoringContext();
    expect(retained).toMatchObject({
      observedAt: generatedAt,
      currentRewardCycle: 141,
      expectedCurrentParticipation: true,
      expectedNextParticipation: false,
    });

    await expect(service.snapshot(true)).resolves.toBe(snapshot);
    expect(load).toHaveBeenCalledTimes(2);
    expect(service.healthMonitoringContext()).toEqual(retained);
  });

  it("serves a stale snapshot immediately while one background refresh is in progress", async () => {
    const { store } = await openSidekickStore(":memory:");
    stores.push(store);
    let now = 0;
    const service = new OperatorService({
      config: {
        network: "mainnet",
        nodeRpcUrl: "http://127.0.0.1:20443",
        apiUrl: "https://api.mainnet.hiro.so",
        apiKeyHeader: "x-api-key",
        maxApiBurnBlockLag: 12,
        forecastHorizonCycles: 6,
        databasePath: ":memory:",
      },
      managerPrincipal: "SP000000000000000000002Q6VF78.signer-manager",
      store,
      node: {} as StacksNodeClient,
      api: {} as StacksApiClient,
      cacheTtlMs: 10,
      now: () => now,
    });
    let releaseRefresh: ((value: unknown) => void) | undefined;
    const refresh = new Promise((resolve) => {
      releaseRefresh = resolve;
    });
    const load = vi
      .fn()
      .mockResolvedValueOnce({
        generatedAt: "first",
        roster: [],
        rewards: null,
        activity: { withdrawals: [] },
      })
      .mockImplementationOnce(async () => await refresh);
    (service as unknown as { load: typeof load }).load = load;

    await expect(service.summary()).resolves.toMatchObject({ freshness: { status: "current" } });
    now = 11;
    await expect(service.summary()).resolves.toMatchObject({
      generatedAt: "first",
      freshness: { status: "stale", reason: "refreshing" },
    });
    await expect(service.snapshot()).resolves.toMatchObject({ generatedAt: "first" });
    expect(load).toHaveBeenCalledTimes(2);

    releaseRefresh?.({
      generatedAt: "second",
      roster: [],
      rewards: null,
      activity: { withdrawals: [] },
    });
    await Promise.resolve();
    await Promise.resolve();
    await expect(service.summary()).resolves.toMatchObject({
      generatedAt: "second",
      freshness: { status: "current" },
    });
  });

  it("backs off refreshes after a rate limit while a usable stale snapshot remains", async () => {
    const { store } = await openSidekickStore(":memory:");
    stores.push(store);
    let now = 0;
    const service = new OperatorService({
      config: {
        network: "mainnet",
        nodeRpcUrl: "http://127.0.0.1:20443",
        apiUrl: "https://api.mainnet.hiro.so",
        apiKeyHeader: "x-api-key",
        maxApiBurnBlockLag: 12,
        forecastHorizonCycles: 6,
        databasePath: ":memory:",
      },
      managerPrincipal: "SP000000000000000000002Q6VF78.signer-manager",
      store,
      node: {} as StacksNodeClient,
      api: {} as StacksApiClient,
      cacheTtlMs: 10,
      now: () => now,
    });
    const load = vi
      .fn()
      .mockResolvedValueOnce({
        generatedAt: "first",
        roster: [],
        rewards: null,
        activity: { withdrawals: [] },
      })
      .mockRejectedValueOnce(
        new RateLimitedError("limited", 30_000, "https://api.mainnet.hiro.so/extended/v1/status"),
      );
    (service as unknown as { load: typeof load }).load = load;

    await service.summary();
    now = 11;
    await expect(service.summary()).resolves.toMatchObject({
      freshness: { status: "stale", reason: "refreshing" },
    });
    await Promise.resolve();
    await Promise.resolve();
    await expect(service.summary()).resolves.toMatchObject({
      freshness: {
        status: "stale",
        reason: "rate-limited",
        rateLimit: {
          source: "hiro-api",
          retryAfterSeconds: 30,
          apiKeyConfigured: false,
        },
      },
    });
    await expect(service.summary(true)).resolves.toMatchObject({
      freshness: { status: "stale", reason: "rate-limited" },
    });

    expect(load).toHaveBeenCalledTimes(2);
  });

  it("keeps last-good read views available through a longer upstream outage", async () => {
    const { store } = await openSidekickStore(":memory:");
    stores.push(store);
    let now = 0;
    const service = new OperatorService({
      config: {
        network: "mainnet",
        nodeRpcUrl: "http://127.0.0.1:20443",
        apiUrl: "https://api.mainnet.hiro.so",
        apiKeyHeader: "x-api-key",
        maxApiBurnBlockLag: 12,
        forecastHorizonCycles: 6,
        databasePath: ":memory:",
      },
      managerPrincipal: "SP000000000000000000002Q6VF78.signer-manager",
      store,
      node: {} as StacksNodeClient,
      api: {} as StacksApiClient,
      cacheTtlMs: 10,
      now: () => now,
    });
    const load = vi
      .fn()
      .mockResolvedValueOnce({
        generatedAt: "first",
        roster: [],
        rewards: null,
        activity: { withdrawals: [] },
      })
      .mockRejectedValue(new Error("upstream unavailable"));
    (service as unknown as { load: typeof load }).load = load;

    await service.summary();
    now = 600_000;
    await expect(service.summary()).resolves.toMatchObject({
      generatedAt: "first",
      freshness: { status: "stale", reason: "refreshing" },
    });
    await Promise.resolve();
    await Promise.resolve();
    await expect(service.summary()).resolves.toMatchObject({
      generatedAt: "first",
      freshness: { status: "stale", reason: "refresh-failed" },
    });
  });

  it("reads stored activity without requiring a live chain snapshot", async () => {
    const { store } = await openSidekickStore(":memory:");
    stores.push(store);
    const service = new OperatorService({
      config: {
        network: "testnet",
        nodeRpcUrl: "http://127.0.0.1:20443",
        apiUrl: "https://api.testnet-pox5.hiro.so",
        apiKeyHeader: "x-api-key",
        maxApiBurnBlockLag: 12,
        forecastHorizonCycles: 6,
        databasePath: ":memory:",
      },
      managerPrincipal: "ST000000000000000000002AMW42H.signer-manager",
      store,
      node: {} as StacksNodeClient,
      api: {} as StacksApiClient,
    });
    const load = vi.fn().mockRejectedValue(new Error("live sources must not be read"));
    (service as unknown as { load: typeof load }).load = load;

    await expect(service.activity()).resolves.toMatchObject({
      eventCount: 0,
      claims: [],
      withdrawals: [],
    });
    expect(load).not.toHaveBeenCalled();
  });

  it("records trust at startup without requiring a dashboard snapshot", async () => {
    const { store } = await openSidekickStore(":memory:");
    stores.push(store);
    let source = await readFile(
      resolve(
        import.meta.dirname,
        "../../../contracts/reference-manager/generated/devnet/signer-manager.clar",
      ),
      "utf8",
    );
    const node = {
      getContractSource: async () => ({ source, publish_height: 100 }),
      getContractInterface: async () => ({
        clarity_version: "Clarity6",
        epoch: "Epoch40",
        functions: [
          ...REFERENCE_MANAGER_PUBLIC_FUNCTIONS.map((name) => ({
            name,
            access: "public",
            args:
              name === "validate-stake!"
                ? [
                    { name: "staker", type: "principal" },
                    { name: "first-index", type: "uint128" },
                    { name: "num-indexes", type: "uint128" },
                    { name: "amount-ustx", type: "uint128" },
                    { name: "amount-sats", type: "uint128" },
                    { name: "is-bond", type: "bool" },
                    {
                      name: "signer-calldata",
                      type: { optional: { buffer: { length: 500 } } },
                    },
                  ]
                : [],
            outputs:
              name === "validate-stake!"
                ? { type: { response: { ok: "bool", error: "uint128" } } }
                : null,
          })),
          ...REFERENCE_MANAGER_READ_ONLY_FUNCTIONS.map((name) => ({
            name,
            access: "read_only",
            args: [],
            outputs: null,
          })),
        ],
      }),
    } as unknown as StacksNodeClient;
    const managerPrincipal = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.signer-manager";
    const service = new OperatorService({
      config: {
        network: "devnet",
        nodeRpcUrl: "http://127.0.0.1:20443",
        apiUrl: "http://127.0.0.1:3999",
        apiKeyHeader: "x-api-key",
        maxApiBurnBlockLag: 12,
        forecastHorizonCycles: 6,
        databasePath: ":memory:",
      },
      managerPrincipal,
      store,
      node,
      api: {} as StacksApiClient,
    });

    await expect(service.observeManagerTrustState()).resolves.toMatchObject({
      transition: { transition: "gained" },
    });
    await expect(service.observeManagerTrustState()).resolves.toMatchObject({ transition: null });
    source = "(define-public (custom) (ok true))";
    await expect(service.observeManagerTrustState()).resolves.toMatchObject({
      transition: { transition: "lost" },
    });
    expect(store.managerTrust.listAudit(managerPrincipal)).toMatchObject([
      { transition: "lost" },
      { transition: "gained" },
    ]);
  });
});
