import { describe, expect, it } from "vitest";
import {
  createOperatorSupportBundle,
  operatorSupportApplication,
  operatorSupportBundleSchema,
} from "./support-bundle.js";

const managerPrincipal = "SP000000000000000000002Q6VF78.signer-manager";

const dashboardSnapshot = {
  generatedAt: "2026-08-13T12:00:00.000Z",
  network: "mainnet",
  managerPrincipal,
  preflight: { status: "pass" },
  manager: {},
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
      operator: async () => dashboardSnapshot,
      database: () => ({
        schemaVersion: 21,
        journalMode: "wal",
        synchronous: 2,
        foreignKeys: true,
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
        operator: { status: "ok", data: { network: "mainnet", managerPrincipal } },
        nodeAndSignerHealth: { status: "unavailable", data: null },
        database: { status: "ok", data: { schemaVersion: 21 } },
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
