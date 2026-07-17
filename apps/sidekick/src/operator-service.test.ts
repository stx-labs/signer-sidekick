import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  REFERENCE_MANAGER_PUBLIC_FUNCTIONS,
  REFERENCE_MANAGER_READ_ONLY_FUNCTIONS,
} from "@stx-labs/signer-sidekick-protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { StacksApiClient, StacksNodeClient } from "./chain-clients.js";
import type { SidekickConfig } from "./config.js";
import {
  buildAlerts,
  classifySupportContact,
  OperatorService,
  type OperatorServiceOptions,
} from "./operator-service.js";
import { openSidekickStore, type SidekickStore } from "./storage/store.js";

const stores: SidekickStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function alertInput(options: { belowThreshold?: boolean; setupBlocked?: boolean }) {
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
      ? { status: "blocked", checks: [{ status: "fail", message: "Grant is revoked" }] }
      : { status: "ready", checks: [] },
    forecast: {
      status: "attention",
      cycles: [
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
  it("uses calm read-only language and stable eligibility-transition alert IDs", () => {
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
          title: "Manager Not Recognized — Read-only",
          action: { kind: "navigate", label: "Review manager profiles", target: "settings" },
        }),
        expect.objectContaining({
          id: "manager:trust-transition-lost:2026-07-16T12:00:00.000Z",
          severity: "critical",
          title: "Manager Degraded to Read-only",
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
          detail:
            "Stacks API is unavailable. Open Settings to verify the configured node and API data sources.",
          action: { kind: "navigate", label: "Open Settings", target: "settings" },
        }),
        expect.objectContaining({
          id: "manager:unsupported",
          detail:
            "Manager network does not match. Open Initial Setup to review network compatibility and manager interface requirements.",
          action: { kind: "navigate", label: "Open Initial Setup", target: "setup" },
        }),
        expect.objectContaining({
          id: "manager:profile-load-issues",
          action: { kind: "navigate", label: "Review profile issues", target: "settings" },
        }),
      ]),
    );
  });

  it("uses the live threshold in below-threshold alerts and preserves setup alerts", () => {
    const alerts = buildAlerts(alertInput({ belowThreshold: true, setupBlocked: true }));
    expect(alerts).toContainEqual(
      expect.objectContaining({
        id: "pool:forecast-attention",
        title: "Pool Below Signer-Set Threshold",
        detail:
          "The pool is below the 75,000 STX signer-set threshold in reward cycle(s) 144. Open Initial Setup → Activate your signer for the manager principal and enrollment cutoff.",
        action: { kind: "navigate", label: "Open signer activation", target: "setup" },
      }),
    );
    expect(alerts).toContainEqual(
      expect.objectContaining({
        id: "setup:blocked",
        detail: "Grant is revoked. Open Initial Setup to review and resolve the blocked step.",
        action: { kind: "navigate", label: "Open Initial Setup", target: "setup" },
      }),
    );
  });

  it("keeps generic forecast attention separate from a threshold warning", () => {
    expect(buildAlerts(alertInput({}))).toContainEqual(
      expect.objectContaining({
        title: "Pool Forecast Needs Attention",
        detail: "Open Pool positions to review the roster changes affecting reward cycle(s) 144.",
        action: { kind: "navigate", label: "Review pool positions", target: "pool" },
      }),
    );
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
          detail:
            "Sidekick has not synchronized the individual staker roster. Run Reconcile now before relying on payout totals.",
          action: { kind: "reconcile", label: "Reconcile now" },
        }),
        expect.objectContaining({
          id: "withdrawals:pending",
          action: { kind: "navigate", label: "Review L1 withdrawals", target: "rewards" },
        }),
      ]),
    );
  });

  it("does not classify informational manager modes as required actions", () => {
    const input = alertInput({});
    input.forecast = null;
    input.manager.source.tier = "custom-observe";
    const alert = buildAlerts(input).find(({ id }) => id === "manager:custom-read-only");
    expect(alert).toMatchObject({ severity: "info" });
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
