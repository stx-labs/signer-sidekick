import { describe, expect, it } from "vitest";
import {
  createOperatorSupportBundle,
  operatorSupportApplication,
  operatorSupportBundleSchema,
} from "./support-bundle.js";

const managerPrincipal = "SP000000000000000000002Q6VF78.signer-manager";
const connectionAssessment = {
  schemaVersion: 1,
  status: "connected",
  outcomeCode: null,
  checkedAt: "2026-08-13T12:00:00.000Z",
  stale: false,
  configured: {
    network: "mainnet",
    networkId: 1,
    nodeRpcUrl: "http://127.0.0.1:20443",
    managerPrincipal,
  },
  observed: {
    networkId: 1,
    parentNetworkId: 0,
    stacksTipHeight: 8_750_000,
    burnBlockHeight: 962_250,
    pox5ContractId: "SP000000000000000000002Q6VF78.pox-5",
    manager: {
      deployed: true,
      traitCompatible: true,
      missingRequirements: [],
      publishHeight: 8_700_000,
      clarityVersion: "Clarity4",
      epoch: "Epoch40",
    },
  },
  lastSuccessful: {
    schemaVersion: 1,
    network: "mainnet",
    networkId: 1,
    parentNetworkId: 0,
    managerPrincipal,
    bindingSource: "new",
    boundAt: "2026-08-13T12:00:00.000Z",
    lastVerifiedAt: "2026-08-13T12:00:00.000Z",
    lastStacksTipHeight: 8_750_000,
    lastBurnBlockHeight: 962_250,
    lastPox5ContractId: "SP000000000000000000002Q6VF78.pox-5",
  },
  deploymentIdentity: {
    status: "bound",
    stored: {
      schemaVersion: 1,
      network: "mainnet",
      networkId: 1,
      parentNetworkId: 0,
      managerPrincipal,
      bindingSource: "new",
      boundAt: "2026-08-13T12:00:00.000Z",
      lastVerifiedAt: "2026-08-13T12:00:00.000Z",
      lastStacksTipHeight: 8_750_000,
      lastBurnBlockHeight: 962_250,
      lastPox5ContractId: "SP000000000000000000002Q6VF78.pox-5",
    },
    reason: null,
  },
  checks: [
    { id: "deployment-identity", status: "pass", message: "Identity matches." },
    { id: "node-network", status: "pass", message: "Network matches." },
    { id: "pox5", status: "pass", message: "PoX-5 is active." },
    { id: "principal-network", status: "pass", message: "Principal matches." },
    { id: "manager-trait", status: "pass", message: "Trait matches." },
  ],
};

const dashboardSnapshot = {
  schemaVersion: 1,
  generatedAt: "2026-08-13T12:00:00.000Z",
  network: "mainnet",
  managerPrincipal,
  preflight: { status: "pass" },
  manager: {
    capabilities: {
      signerManagerTrait: { compatible: true, reason: "Exact trait signature" },
      observedFunctions: { public: [], readOnly: [] },
      sourceReview: { exactReviewed: false, reason: "Observe-only fixture" },
      eventVocabulary: {
        id: "reference-manager-v1",
        normalizationAvailable: false,
        adapter: null,
        reason: "Observe-only fixture",
      },
      actions: [],
    },
  },
  activity: { withdrawals: [] },
  roster: [],
  alerts: [],
};

describe("operator support bundle", () => {
  const collectedAt = new Date("2026-08-13T12:01:00.000Z");
  const application = operatorSupportApplication(
    {
      SIDEKICK_BUILD_VERSION: "1.2.3",
      SIDEKICK_BUILD_COMMIT: "abcdef1234567",
      STACKS_API_KEY: "must-not-enter-application-metadata",
    },
    collectedAt,
    120,
  );

  it("collects a versioned diagnostic artifact and marks unavailable sources", async () => {
    const bundle = await createOperatorSupportBundle({
      application,
      connection: async () => connectionAssessment,
      runtimeSettings: () => ({
        schemaVersion: 1,
        revision: 0,
        updatedAt: null,
        pool: { displayName: "", websiteUrl: "", supportContact: "", leatherUrl: "" },
        display: { defaultTheme: "system" },
        dataSources: {
          nodeRpcUrl: "http://127.0.0.1:20443",
          apiUrl: "https://api.mainnet.hiro.so",
          apiKeyHeader: "x-api-key",
          apiKeyConfigured: false,
          apiKeySource: "none",
          nodeMetricsUrl: "",
          signerMonitoringUrl: "",
          hiroReferenceApiUrl: "",
        },
        forecast: { horizonCycles: 6 },
        embed: { publicApiUrl: "" },
        audit: [],
      }),
      operator: async () => dashboardSnapshot,
      database: () => ({
        schemaVersion: 21,
        journalMode: "wal",
        synchronous: 2,
        foreignKeys: true,
      }),
      observer: () => ({
        schemaVersion: 1,
        enabled: true,
        listening: true,
        listener: { host: "127.0.0.1", port: 3700, maxBodyBytes: 4_194_304 },
        inbox: {
          schemaVersion: 1,
          uniqueDeliveries: 12,
          deliveryAttempts: 14,
          processingAttempts: 11,
          duplicates: 2,
          queueDepth: 1,
          processing: 0,
          nodeVerified: 9,
          quarantined: 1,
          expired: 1,
          lastReceivedAt: "2026-08-13T12:00:30.000Z",
          lastProcessedAt: "2026-08-13T12:00:31.000Z",
          oldestPendingAt: "2026-08-13T12:00:30.000Z",
          lastClaimedStacksBlock: {
            height: 8_750_000,
            blockHash: `0x${"11".repeat(32)}`,
            indexBlockHash: `0x${"22".repeat(32)}`,
          },
          lastClaimedBurnBlock: { height: 962_250, blockHash: `0x${"33".repeat(32)}` },
          lastQuarantine: {
            endpointKind: "new-block",
            reason: "invalid-payload-shape:block_hash:required",
            receivedAt: "2026-08-13T11:59:00.000Z",
          },
        },
      }),
      bundleId: "10000000-0000-4000-8000-000000000001",
      now: () => collectedAt,
    });

    expect(() => operatorSupportBundleSchema.parse(bundle)).not.toThrow();
    expect(bundle).toMatchObject({
      documentType: "signer-sidekick-operator-support-bundle",
      collectionStatus: "partial",
      application: {
        version: "1.2.3",
        buildCommit: "abcdef1234567",
        runtime: { uptimeSeconds: 120 },
      },
      sections: {
        connection: { status: "ok", data: { status: "connected" } },
        runtimeSettings: {
          status: "ok",
          data: { dataSources: { nodeRpcUrl: "http://127.0.0.1:20443" } },
        },
        operator: { status: "ok", data: { network: "mainnet", managerPrincipal } },
        nodeAndSignerHealth: { status: "unavailable", data: null },
        database: { status: "ok", data: { schemaVersion: 21 } },
        observer: {
          status: "ok",
          data: { enabled: true, listening: true, inbox: { queueDepth: 1, duplicates: 2 } },
        },
      },
      safety: {
        apiKeyValueIncluded: false,
        operatorCredentialIncluded: false,
        privateKeyMaterialIncluded: false,
        rawLogsIncluded: false,
      },
    });
    expect(JSON.stringify(bundle)).not.toContain("must-not-enter-application-metadata");
  });

  it("fails only the affected section when a forbidden field is presented", async () => {
    const bundle = await createOperatorSupportBundle({
      application,
      operator: async () => ({ ...dashboardSnapshot, apiKey: "sentinel-api-key" }),
      now: () => collectedAt,
    });

    expect(bundle.collectionStatus).toBe("failed");
    expect(bundle.sections.operator).toMatchObject({
      status: "failed",
      data: null,
      error: { code: "Error" },
    });
    expect(JSON.stringify(bundle)).not.toContain("sentinel-api-key");
  });

  it("redacts credentials from collection errors while retaining other sections", async () => {
    const bundle = await createOperatorSupportBundle({
      application,
      operator: async () => dashboardSnapshot,
      health: async () => {
        throw new Error("Authorization: Bearer sentinel-bearer-token");
      },
      now: () => collectedAt,
    });

    expect(bundle.collectionStatus).toBe("partial");
    expect(bundle.sections.nodeAndSignerHealth).toMatchObject({
      status: "failed",
      error: { message: "Authorization: Bearer <redacted>" },
    });
    expect(JSON.stringify(bundle)).not.toContain("sentinel-bearer-token");
  });
});
