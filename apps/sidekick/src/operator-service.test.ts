import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  REFERENCE_MANAGER_PUBLIC_FUNCTIONS,
  REFERENCE_MANAGER_READ_ONLY_FUNCTIONS,
} from "@stx-labs/signer-sidekick-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RateLimitedError, type StacksApiClient, type StacksNodeClient } from "./chain-clients.js";
import type { SidekickConfig } from "./config.js";
import {
  buildAlerts,
  classifySupportContact,
  OperatorService,
  type OperatorServiceOptions,
  observeTransactionEngineSafely,
} from "./operator-service.js";
import { openSidekickStore, type SidekickStore } from "./storage/store.js";

const stores: SidekickStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function alertInput(options: {
  belowThreshold?: boolean;
  setupBlocked?: boolean;
  cycles?: Array<{
    cycleId: number;
    status: "ready" | "attention";
    meetsThreshold: boolean;
    thresholdUstx?: string;
  }>;
}) {
  const thresholdUstx = "75000000000";
  return {
    preflight: { checks: [] },
    manager: {
      attachAllowed: true,
      automationEligibilityReason: "Manager source is not recognized",
      source: { tier: "reference-built-in" },
      installedProfiles: { issues: [] },
    },
    setup: options.setupBlocked
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

  it("separates external signing from Assist and keeps stable transition IDs", () => {
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
          id: "manager:not-recognized-read-only",
          severity: "warning",
          title: "Manager Source Not Recognized",
          detail: expect.stringContaining("wallet or manual signing"),
          action: { kind: "navigate", label: "Review manager profiles", target: "settings" },
        }),
        expect.objectContaining({
          id: "manager:trust-transition-lost:2026-07-16T12:00:00.000Z",
          severity: "critical",
          title: "Manager Assist Eligibility Lost",
          action: { kind: "navigate", label: "Review manager profiles", target: "settings" },
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
        action: { kind: "navigate", label: "Review manager profiles", target: "settings" },
      }),
    );
  });

  it("routes connection and manager compatibility alerts to their repair screens", () => {
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
          action: { kind: "navigate", label: "Open Settings", target: "settings" },
        }),
        expect.objectContaining({
          id: "manager:unsupported",
          detail: "Manager network does not match.",
          action: { kind: "navigate", label: "Open Initial Setup", target: "setup" },
        }),
        expect.objectContaining({
          id: "manager:profile-load-issues",
          detail: "1 manager profile could not be loaded.",
          action: { kind: "navigate", label: "Review profile issues", target: "settings" },
        }),
      ]),
    );
  });

  it("uses the live threshold, routes to the pool, and preserves setup alerts", () => {
    const alerts = buildAlerts(alertInput({ belowThreshold: true, setupBlocked: true }));
    expect(alerts).toContainEqual(
      expect.objectContaining({
        id: "pool:forecast-attention",
        title: "Pool Below Signer-Set Threshold",
        detail: "The pool is below the 75,000 STX signer-set threshold in reward cycle 144.",
        action: { kind: "navigate", label: "Review pool positions", target: "pool" },
      }),
    );
    expect(alerts).toContainEqual(
      expect.objectContaining({
        id: "setup:blocked",
        detail: "Grant is revoked.",
        action: {
          kind: "navigate",
          label: "Repair signer authorization",
          target: "manager",
          managerAction: "register-self",
        },
      }),
    );
  });

  it("keeps generic forecast attention separate from a threshold warning", () => {
    expect(buildAlerts(alertInput({}))).toContainEqual(
      expect.objectContaining({
        title: "Pool Forecast Needs Attention",
        detail: "Pool checks need attention for reward cycle 144.",
        action: { kind: "navigate", label: "Review pool positions", target: "pool" },
      }),
    );
  });

  it("limits the signer-set threshold alert to the next cycle", () => {
    const alerts = buildAlerts(
      alertInput({
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
    );

    expect(alerts).toContainEqual(
      expect.objectContaining({
        title: "Pool Below Signer-Set Threshold",
        detail: "The pool is below the 75,000 STX signer-set threshold in reward cycle 6.",
        action: { kind: "navigate", label: "Review pool positions", target: "pool" },
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

  it("attaches the resolving control to roster and withdrawal alerts", () => {
    const input = alertInput({});
    input.forecast = null;
    input.rewards = { status: "attention" } as typeof input.rewards;
    input.activity.pendingWithdrawalTotal = 2;
    expect(buildAlerts(input)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "rewards:incomplete",
          detail: "The individual staker roster has not been synced.",
          action: { kind: "reconcile", label: "Sync now" },
        }),
        expect.objectContaining({
          id: "withdrawals:pending",
          title: "Bitcoin Withdrawals Await Resolution",
          detail: "2 Bitcoin withdrawal requests remain pending.",
          action: {
            kind: "navigate",
            label: "Review Bitcoin withdrawals",
            target: "rewards",
          },
        }),
      ]),
    );
  });

  it("does not classify informational manager modes as required actions", () => {
    const input = alertInput({});
    input.forecast = null;
    input.manager.source.tier = "custom-observe";
    const alert = buildAlerts(input).find(({ id }) => id === "manager:custom-read-only");
    expect(alert).toMatchObject({
      severity: "info",
      title: "Custom Manager",
      detail: expect.stringContaining("wallet or manual signing"),
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
        functions: [
          ...REFERENCE_MANAGER_PUBLIC_FUNCTIONS.map((name) => ({
            name,
            access: "public",
            args: [],
            outputs: null,
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
    expect(store.listManagerTrustAudit(managerPrincipal)).toMatchObject([
      { transition: "lost" },
      { transition: "gained" },
    ]);
  });

  it("classifies support contacts by email validity rather than an at-sign heuristic", () => {
    expect(classifySupportContact("pool@example.com")).toEqual({ email: "pool@example.com" });
    expect(classifySupportContact("https://user@example.com/support")).toEqual({
      url: "https://user@example.com/support",
    });
    expect(classifySupportContact("")).toBeUndefined();
  });
});
