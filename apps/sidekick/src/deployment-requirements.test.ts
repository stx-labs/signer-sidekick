import type {
  ConnectionAssessment,
  DeploymentRequirements,
} from "@stx-labs/signer-sidekick-api-contracts";
import { describe, expect, it, vi } from "vitest";
import type { ApiCredential, SidekickConfig } from "./config.js";
import { DeploymentRequirementsService } from "./deployment-requirements.js";
import type { ObserverRuntimeStatus } from "./observer-server.js";

const config: SidekickConfig = {
  network: "mainnet",
  nodeRpcUrl: "http://127.0.0.1:20443",
  apiUrl: "https://api.mainnet.hiro.so",
  apiKeyHeader: "x-api-key",
  maxApiBurnBlockLag: 12,
  forecastHorizonCycles: 6,
  stakerPageLimit: 200,
  eventPageLimit: 100,
  databasePath: ":memory:",
  nodeMetricsUrl: "http://127.0.0.1:9153/metrics",
  signerMonitoringUrl: "http://127.0.0.1:30001",
  hiroReferenceApiUrl: "https://api.mainnet.hiro.so",
  hiroReferenceApiKeyHeader: "x-api-key",
};

const connected: ConnectionAssessment = {
  schemaVersion: 1,
  status: "connected",
  outcomeCode: null,
  checkedAt: "2026-08-15T12:00:00.000Z",
  stale: false,
  configured: {
    network: "mainnet",
    networkId: 1,
    nodeRpcUrl: config.nodeRpcUrl,
    managerPrincipal: "SP000000000000000000002Q6VF78.manager",
  },
  observed: {
    networkId: 1,
    parentNetworkId: null,
    stacksTipHeight: 8_750_000,
    burnBlockHeight: 962_500,
    pox5ContractId: "SP000000000000000000002Q6VF78.pox-5",
    manager: {
      deployed: true,
      traitCompatible: true,
      missingRequirements: [],
      publishHeight: 8_700_000,
      clarityVersion: "Clarity3",
      epoch: "Epoch33",
    },
  },
  lastSuccessful: null,
  deploymentIdentity: { status: "unbound", stored: null, reason: null },
  checks: [
    { id: "deployment-identity", status: "pass", message: "Identity verified" },
    { id: "node-network", status: "pass", message: "Node verified" },
    { id: "pox5", status: "pass", message: "PoX-5 verified" },
    { id: "principal-network", status: "pass", message: "Principal verified" },
    { id: "manager-trait", status: "pass", message: "Manager verified" },
  ],
};

function observer(overrides: Partial<ObserverRuntimeStatus> = {}): ObserverRuntimeStatus {
  return {
    schemaVersion: 1,
    enabled: true,
    listening: true,
    listener: { host: "127.0.0.1", port: 3700, maxBodyBytes: 4_194_304 },
    inbox: {
      schemaVersion: 1,
      uniqueDeliveries: 1,
      deliveryAttempts: 1,
      processingAttempts: 1,
      duplicates: 0,
      queueDepth: 0,
      processing: 0,
      nodeVerified: 1,
      quarantined: 0,
      expired: 0,
      retainedPayloadBytes: 0,
      prunedPayloads: 1,
      lastReceivedAt: "2026-08-15T11:59:55.000Z",
      lastProcessedAt: "2026-08-15T11:59:56.000Z",
      oldestPendingAt: null,
      lastClaimedStacksBlock: null,
      lastVerifiedStacksBlock: {
        height: 8_750_000,
        indexBlockHash: `0x${"11".repeat(32)}`,
        receivedAt: "2026-08-15T11:59:55.000Z",
        verifiedAt: "2026-08-15T11:59:56.000Z",
      },
      lastClaimedBurnBlock: null,
      lastQuarantine: null,
    },
    reconciliation: null,
    gap: null,
    ...overrides,
  };
}

function service(
  options: {
    config?: SidekickConfig;
    connection?: ConnectionAssessment | null;
    observer?: ObserverRuntimeStatus;
    transactionIndex?: "enabled" | "disabled" | "unavailable";
    testSource?: (
      kind: "node-metrics" | "signer-monitoring" | "hiro-reference",
      url: string,
      credential?: ApiCredential,
    ) => Promise<{
      status: "connected";
      signals: number;
    }>;
  } = {},
) {
  return new DeploymentRequirementsService({
    getConfig: () => options.config ?? config,
    getConnection: () => (options.connection === undefined ? connected : options.connection),
    getObserverStatus: () => options.observer ?? observer(),
    probeTransactionIndex: async () => options.transactionIndex ?? "enabled",
    testSource: options.testSource ?? (async () => ({ status: "connected" as const, signals: 12 })),
    now: () => new Date("2026-08-15T12:00:00.000Z"),
  });
}

function check(result: DeploymentRequirements, id: string) {
  const found = result.checks.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Missing ${id}`);
  return found;
}

describe("deployment requirements", () => {
  it("reports a ready deployment from bounded live checks", async () => {
    const result = await service().check(true);

    expect(result).toMatchObject({ status: "ready", requiredReady: true });
    expect(result.checks).toHaveLength(6);
    expect(result.checks.every(({ status }) => status === "pass")).toBe(true);
    expect(check(result, "node-transaction-index").observed).toContain("enabled-endpoint");
  });

  it("keeps a disabled txindex non-blocking and provides exact TOML to opt into it", async () => {
    const result = await service({ transactionIndex: "disabled" }).check(true);
    const index = check(result, "node-transaction-index");

    // Verification falls back to reading canonical blocks, so a disabled index is a
    // performance choice rather than a missing requirement.
    expect(result).toMatchObject({ status: "attention", requiredReady: true });
    expect(index).toMatchObject({ importance: "recommended", status: "not-configured" });
    expect(index.summary).toContain("reading canonical blocks");
    expect(index.remediation?.configuration).toContainEqual({
      label: "Stacks node [node] table",
      format: "toml",
      content: "[node]\ntxindex = true",
    });
    expect(index.remediation?.restartServices).toEqual(["stacks-node"]);
  });

  it("keeps missing diagnostics non-blocking while explaining how to enable them", async () => {
    const result = await service({
      config: { ...config, nodeMetricsUrl: undefined, signerMonitoringUrl: undefined },
      observer: observer({
        inbox: { ...observer().inbox, lastVerifiedStacksBlock: null, nodeVerified: 0 },
      }),
    }).check(true);

    expect(result).toMatchObject({ status: "attention", requiredReady: true });
    expect(check(result, "node-metrics").status).toBe("not-configured");
    expect(check(result, "signer-monitoring").remediation?.configuration[0]?.content).toContain(
      "metrics_endpoint",
    );
    expect(check(result, "sidekick-event-observer")).toMatchObject({
      importance: "recommended",
      status: "attention",
    });
  });

  it("reports configured monitoring endpoints that fail their live tests", async () => {
    const testSource = vi.fn().mockRejectedValue(new Error("connection refused"));
    const result = await service({ testSource }).check(true);

    expect(result.status).toBe("attention");
    expect(check(result, "node-metrics")).toMatchObject({
      status: "unavailable",
      observed: config.nodeMetricsUrl,
    });
    expect(check(result, "signer-monitoring").summary).toContain("connection refused");
  });

  it("tests the network comparison API with its origin-bound credential", async () => {
    const testSource = vi.fn(async () => ({ status: "connected" as const, signals: 2 }));
    const result = await service({
      config: {
        ...config,
        hiroReferenceApiKey: "reference-secret",
        hiroReferenceApiKeyOrigin: "https://api.mainnet.hiro.so",
      },
      testSource,
    }).check(true);

    expect(check(result, "hiro-reference")).toMatchObject({ status: "pass" });
    expect(testSource).toHaveBeenCalledWith("hiro-reference", "https://api.mainnet.hiro.so", {
      headerName: "x-api-key",
      value: "reference-secret",
    });
  });

  it("does not accept a generic metrics endpoint with no recognized signals", async () => {
    const result = await service({
      testSource: async () => ({ status: "connected", signals: 0 }),
    }).check(true);

    expect(check(result, "node-metrics")).toMatchObject({ status: "attention" });
    expect(check(result, "node-metrics").summary).toContain("did not recognize");
  });

  it("does not probe txindex when the core node connection is unavailable", async () => {
    const probe = vi.fn();
    const disconnected = {
      ...connected,
      status: "unavailable" as const,
      outcomeCode: "node-unreachable" as const,
    };
    const requirements = new DeploymentRequirementsService({
      getConfig: () => config,
      getConnection: () => disconnected,
      getObserverStatus: () => observer(),
      probeTransactionIndex: probe,
      testSource: async () => ({ status: "connected", signals: 1 }),
    });

    const result = await requirements.check(true);

    expect(result.status).toBe("blocked");
    expect(check(result, "node-rpc").status).toBe("unavailable");
    expect(probe).not.toHaveBeenCalled();
  });

  it("invalidates its cache when a runtime endpoint changes", async () => {
    let currentConfig: SidekickConfig = { ...config };
    delete currentConfig.nodeMetricsUrl;
    const testSource = vi.fn(async () => ({ status: "connected" as const, signals: 4 }));
    const requirements = new DeploymentRequirementsService({
      getConfig: () => currentConfig,
      getConnection: () => connected,
      getObserverStatus: () => observer(),
      probeTransactionIndex: async () => "enabled",
      testSource,
      now: () => new Date("2026-08-15T12:00:00.000Z"),
    });

    expect(check(await requirements.check(), "node-metrics").status).toBe("not-configured");
    currentConfig = { ...config, nodeMetricsUrl: "http://127.0.0.1:9154/metrics" };
    expect(check(await requirements.check(), "node-metrics").status).toBe("pass");
    expect(testSource).toHaveBeenCalledWith("node-metrics", "http://127.0.0.1:9154/metrics");
  });
});
