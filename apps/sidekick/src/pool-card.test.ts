import { describe, expect, it } from "vitest";
import type { PoolEnrollmentDocument } from "./enrollment-info.js";
import { createPoolCardArtifact } from "./pool-card.js";

const enrollment = {
  schemaVersion: 3,
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
    recognitionTier: "reference-built-in",
    profileOrigin: "built-in",
    automationEligible: true,
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
  staking: {
    enabled: false,
    l1MaxFeeSats: null,
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
    expect(artifact.body).toContain("Bitcoin block height");
    expect(artifact.body).not.toContain("<h1>Operator <Pool></h1>");
    expect(artifact.safety).toEqual({
      containsApiKey: false,
      containsGasPayer: false,
      containsPrivateKey: false,
      requiresSidekickPublicRoute: false,
    });
  });

  it("generates static HTML plus a versioned JSON artifact", () => {
    const artifact = createPoolCardArtifact(enrollment, "static", "https://api.example.com");
    expect(artifact.filename).toBe("signer-sidekick-pool.html");
    expect(artifact.body).toContain("Static snapshot");
    expect(artifact.body).not.toContain("fetch(data.publicApiUrl");
    expect(JSON.parse(artifact.json.body)).toMatchObject({
      schemaVersion: 2,
      generatedBy: "signer-sidekick",
      enrollment: { manager: { principal: enrollment.manager.principal } },
    });
    expect(artifact.liveFields).toEqual([]);
  });

  it("rejects hostile URL schemes at the rendering boundary", () => {
    expect(() =>
      createPoolCardArtifact(
        {
          ...enrollment,
          pool: { ...enrollment.pool, websiteUrl: "javascript:alert(1)" },
        } as PoolEnrollmentDocument,
        "static",
        "https://api.example.com",
      ),
    ).toThrow("must use http or https");
    expect(() => createPoolCardArtifact(enrollment, "live", "data:text/html,unsafe")).toThrow(
      "must use http or https",
    );
  });
});

const API_URL = "https://api.mainnet.hiro.so";

function staking(overrides: Partial<PoolEnrollmentDocument> = {}): PoolEnrollmentDocument {
  return {
    ...enrollment,
    staking: { enabled: true, l1MaxFeeSats: "10000" },
    userInteraction: {
      collectsAmount: true,
      collectsBitcoinAddress: true,
      connectsWallet: true,
      signsTransactions: true,
      submitsTransactions: false,
    },
    ...overrides,
  } as PoolEnrollmentDocument;
}

describe("pool card staking form", () => {
  it("renders the form and its runtime on a live mainnet page", () => {
    const artifact = createPoolCardArtifact(staking(), "live", API_URL);

    expect(artifact.stakingForm).toBe(true);
    expect(artifact.body).toContain("Stake STX to this pool");
    expect(artifact.body).toContain('id="sk-amount"');
    expect(artifact.body).toContain('id="sk-cycles"');
    expect(artifact.body).toContain('id="sk-btc"');
    expect(artifact.body).toContain("sidekickPoolSignup");
    expect(artifact.body).toContain('.request("getAddresses", { network: "mainnet" })');
    expect(artifact.body).toContain('postConditionMode: "deny"');
    // New stakes only; existing positions go through an official interface for stake-update.
    expect(artifact.body).toContain("This form creates new stakes only");
    // The safety notice must stop claiming the page never asks for a wallet.
    expect(artifact.body).not.toContain("It never asks for an amount");
  });

  it("states the operator fee budget and what it costs the staker", () => {
    const artifact = createPoolCardArtifact(staking(), "live", API_URL);

    expect(artifact.body).toContain("10000 sats is deducted");
    expect(artifact.body).toContain("only begin once your earned rewards exceed");
  });

  it("keeps the certified wallet list, and does not ship Connect", () => {
    const artifact = createPoolCardArtifact(staking(), "live", API_URL);

    expect(artifact.body).toContain("LeatherProvider");
    expect(artifact.body).not.toContain("@stacks/connect");
    expect(artifact.body).not.toContain("WalletConnect");
    expect(artifact.safety.requiresSidekickPublicRoute).toBe(false);
  });

  it.each([
    ["static mode cannot pin a current burn height", "static" as const, {}],
    [
      "a non-mainnet deployment",
      "live" as const,
      { chain: { ...enrollment.chain, network: "testnet" } },
    ],
    [
      "the operator left it off",
      "live" as const,
      { staking: { enabled: false, l1MaxFeeSats: null } },
    ],
  ])("omits the form when %s", (_label, mode, overrides) => {
    const artifact = createPoolCardArtifact(
      staking(overrides as Partial<PoolEnrollmentDocument>),
      mode,
      API_URL,
    );

    expect(artifact.stakingForm).toBe(false);
    expect(artifact.body).not.toContain("Stake STX to this pool");
    expect(artifact.body).not.toContain("sidekickPoolSignup");
    expect(artifact.body).toContain("It never asks for an amount");
  });

  it("corrects the published document when staking cannot actually run", () => {
    const artifact = createPoolCardArtifact(staking(), "static", API_URL);

    // The JSON artifact must describe the page that shipped, not the request that produced it.
    expect(artifact.enrollment.staking).toEqual({ enabled: false, l1MaxFeeSats: null });
    expect(artifact.enrollment.userInteraction).toEqual({
      collectsAmount: false,
      collectsBitcoinAddress: false,
      connectsWallet: false,
      signsTransactions: false,
      submitsTransactions: false,
    });
    expect(JSON.parse(artifact.json.body).enrollment.staking.enabled).toBe(false);
  });

  it("escapes operator-supplied strings inside the staking page", () => {
    const artifact = createPoolCardArtifact(staking(), "live", API_URL);

    expect(artifact.body).toContain("Operator &lt;Pool&gt;");
    expect(artifact.body).not.toContain("<Pool>");
  });
});

describe("pool card wallet request wiring", () => {
  it("uses Connect's address method and unwraps both wallet responses", () => {
    const artifact = createPoolCardArtifact(staking(), "live", API_URL);

    // Connect keys its address post-processing on `getAddresses`, not `stx_getAddresses`.
    expect(artifact.body).toContain('.request("getAddresses", { network: "mainnet" })');
    expect(artifact.body).not.toContain("stx_getAddresses");
    // Both responses arrive as JSON-RPC envelopes and must be unwrapped, or the address list reads
    // as empty and a successful contract call appears to have no txid.
    expect(artifact.body.match(/api\.unwrapResponse/g)).toHaveLength(2);
  });

  it("guards against a second wallet request while one is in flight", () => {
    const artifact = createPoolCardArtifact(staking(), "live", API_URL);

    expect(artifact.body).toContain("if (inFlight) return;");
    expect(artifact.body).toContain("setBusy(true)");
    expect(artifact.body).toContain("buttons[b].disabled = busy");
  });
});
