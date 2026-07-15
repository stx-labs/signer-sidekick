import { describe, expect, it } from "vitest";
import type { PoolEnrollmentDocument } from "./enrollment-info.js";
import { createPoolCardArtifact } from "./pool-card.js";

const enrollment = {
  schemaVersion: 1,
  documentType: "stx-only-pool-enrollment-info",
  pool: {
    displayName: "Operator <Pool>",
    websiteUrl: "https://pool.example.com",
    support: { email: "pool@example.com" },
  },
  chain: {
    network: "mainnet",
    burnBlockHeight: 962_184,
    stacksTipHeight: 8_700_000,
    rewardCycleId: 141,
    pox5ContractId: "SP000000000000000000002Q6VF78.pox-5",
  },
  manager: {
    principal: "SP000000000000000000002Q6VF78.signer-manager",
    profileId: "mainnet",
    sourceMatch: "exact",
    sourceSha256: "a".repeat(64),
    sourceRecognized: true,
  },
  signer: { publicKeyHex: `02${"a".repeat(64)}`, registered: true, grantValid: true },
  fee: {
    currentConfiguredBips: 500,
    source: "operator-config",
    effectiveFeePolicy:
      "The manager snapshots the effective fee for a reward cycle when it first claims that cycle; an existing snapshot is not overwritten by later fee changes.",
  },
  rewardDestinations: { directSbtc: true, bitcoinL1: true },
  durationPolicy: { minimumCycles: 1, maximumCycles: 96 },
  enrollmentWindow: {
    status: "open",
    targetCycleId: 142,
    preparePhaseStartBurnHeight: 964_000,
    blocksUntilPreparePhase: 1_816,
  },
  eligibility: {
    current: {
      cycleId: 141,
      delegatedUstx: "128400000000",
      thresholdUstx: "50000000000",
      marginUstx: "78400000000",
      meetsThreshold: true,
      inSignerSet: true,
      thresholdAndMembershipAgree: true,
    },
    next: null,
  },
  readiness: { setupStatus: "ready", enrollmentReady: true, notices: [] },
  links: {
    managerExplorer: "https://explorer.hiro.so/address/manager?chain=mainnet",
    officialPlatforms: [
      {
        id: "leather",
        label: "Leather Stacking",
        url: "https://earn.leather.io",
        integration: "link-only",
      },
    ],
  },
  userInteraction: {
    collectsAmount: false,
    collectsBitcoinAddress: false,
    connectsWallet: false,
    signsTransactions: false,
    submitsTransactions: false,
  },
} satisfies PoolEnrollmentDocument;

describe("pool card artifacts", () => {
  it("generates escaped self-contained live HTML without operator secrets", () => {
    const artifact = createPoolCardArtifact(enrollment, "live", "https://api.mainnet.hiro.so");
    expect(artifact.filename).toBe("signer-sidekick-pool.html");
    expect(artifact.body).toContain('fetch(data.publicApiUrl + "/v2/pox"');
    expect(artifact.body).toContain("Operator &lt;Pool&gt;");
    expect(artifact.body).not.toContain("<h1>Operator <Pool></h1>");
    expect(artifact.safety).toEqual({
      containsApiKey: false,
      containsGasPayer: false,
      containsPrivateKey: false,
      requiresSidekickPublicRoute: false,
    });
  });

  it("generates a static versioned JSON artifact", () => {
    const artifact = createPoolCardArtifact(enrollment, "static", "https://api.example.com");
    expect(artifact.filename).toBe("signer-sidekick-pool.json");
    expect(JSON.parse(artifact.body)).toMatchObject({
      schemaVersion: 1,
      generatedBy: "signer-sidekick",
      enrollment: { manager: { principal: enrollment.manager.principal } },
    });
    expect(artifact.liveFields).toEqual([]);
  });
});
