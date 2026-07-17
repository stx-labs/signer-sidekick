import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { parseManagerProfile } from "@stx-labs/signer-sidekick-protocol";
import { parseInstalledManagerProfile } from "@stx-labs/signer-sidekick-protocol/installed-manager-profile";
import {
  DEVNET_REFERENCE_MANAGER,
  MAINNET_REFERENCE_MANAGER,
} from "@stx-labs/signer-sidekick-protocol/known-managers";
import {
  canonicalizeClaritySource,
  claritySourceSha256,
} from "@stx-labs/signer-sidekick-protocol/manager-adapter";
import { generateManagerArtifact } from "@stx-labs/signer-sidekick-protocol/manager-artifact";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContractInterface, StacksNodeClient } from "./chain-clients.js";
import { loadConfig } from "./config.js";
import type { InstalledManagerProfileStore } from "./manager-profile-store.js";
import {
  createInstalledManagerProfile,
  inferReferencePrincipals,
  parseManagerTrustArguments,
  writeInstalledManagerProfile,
} from "./manager-trust.js";
import {
  createManagerVerificationContext,
  inspectDeployedManager,
  invalidateManagerVerificationCache,
  type ManagerVerificationContext,
  verifyManagerArtifact,
} from "./manager-verification.js";

const root = resolve(import.meta.dirname, "../../..");
const manager = "ST3PF13W7Z0RRM42A8VZRVFQ75SV1K26RXEP8YGKJ.signer-manager";
const mainnetManager = "SP000000000000000000002Q6VF78.signer-manager";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function compatibleInterface(): ContractInterface {
  const publicFunctions = [
    "validate-stake!",
    "claim-rewards",
    "claim-staker-rewards",
    "reclaim-failed-withdrawal",
    "settle-accepted-withdrawal",
    "update-admin",
    "update-fees",
    "withdraw-fees",
    "sweep-fee-refunds",
    "register-self",
  ];
  const readOnlyFunctions = [
    "get-earned-staker-rewards",
    "is-admin",
    "get-fee-bips-for-cycle",
    "get-earned-fees",
    "get-withdrawal-liability",
    "get-unclaimed-staker-rewards",
    "get-pox-addr",
    "get-withdrawal-request-staker",
    "check-pox-addr",
  ];
  return {
    functions: [
      ...publicFunctions.map((name) => ({ name, access: "public", args: [], outputs: null })),
      ...readOnlyFunctions.map((name) => ({
        name,
        access: "read_only",
        args: [],
        outputs: null,
      })),
    ],
  };
}

async function renderedSource(network: "devnet" | "testnet" = "devnet") {
  const upstreamSource = await readFile(
    resolve(root, "contracts/reference-manager/upstream/signer-manager.clar"),
    "utf8",
  );
  const profile = parseManagerProfile({
    ...DEVNET_REFERENCE_MANAGER.profile,
    id: `test-${network}-alternate-render`,
    network,
    contracts: {
      pox5: "ST000000000000000000002AMW42H.pox-5",
      sbtcDeployer: "ST1F7QA2MDF17S807EPA36TSS8AMEFY4KA9TVGWXT",
    },
    productionApproved: false,
  });
  return { upstreamSource, source: generateManagerArtifact(upstreamSource, profile).source };
}

function context(
  upstreamSource: string,
  store: InstalledManagerProfileStore,
  expectedNetworkId?: number,
): ManagerVerificationContext {
  return {
    installedProfiles: store,
    upstreamSource,
    upstreamSourceError: null,
    ...(expectedNetworkId !== undefined ? { expectedNetworkId } : {}),
    sourceCache: new Map(),
  };
}

describe("manager trust profiles", () => {
  it("parses trust CLI options without treating flags as output paths", () => {
    expect(
      parseManagerTrustArguments([manager, "--observe-only", "--output", "manager.json"]),
    ).toEqual({ managerPrincipal: manager, outputPath: "manager.json", observeOnly: true });
    expect(() => parseManagerTrustArguments([manager, "--output", "--observe-only"])).toThrow(
      "--output requires a file path",
    );
    expect(() =>
      parseManagerTrustArguments([manager, "--output", "one.json", "--output", "two.json"]),
    ).toThrow("--output may only be provided once");
    expect(() => parseManagerTrustArguments([manager, "--unknown"])).toThrow(
      "Unknown manager trust option",
    );
  });

  it("writes profiles atomically and refuses overwrite", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "sidekick-manager-trust-"));
    temporaryDirectories.push(directory);
    const path = resolve(directory, "manager.json");
    const profile = parseInstalledManagerProfile({
      schemaVersion: 1,
      id: "custom-read-only",
      managerPrincipal: manager,
      network: "testnet",
      sourceSha256: "a".repeat(64),
      canonicalSha256: "b".repeat(64),
      createdAt: "2026-07-16T12:00:00.000Z",
      proofVersion: 1,
      tier: "custom-observe",
    });
    await expect(writeInstalledManagerProfile(path, profile)).resolves.toBe(path);
    await expect(writeInstalledManagerProfile(path, profile)).rejects.toThrow(
      "Refusing to overwrite",
    );
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(profile);
  });

  it("infers embedded reference principals and creates a data-only proof claim", async () => {
    const { upstreamSource, source } = await renderedSource();
    expect(inferReferencePrincipals(source)).toEqual({
      pox5: "ST000000000000000000002AMW42H.pox-5",
      sbtcDeployer: "ST1F7QA2MDF17S807EPA36TSS8AMEFY4KA9TVGWXT",
    });
    const config = loadConfig({
      SIDEKICK_NETWORK: "devnet",
      SIDEKICK_NETWORK_ID: "256",
      STACKS_NODE_RPC_URL: "http://node:20443",
      STACKS_API_URL: "http://api:3999",
    });
    const result = createInstalledManagerProfile({
      config,
      managerPrincipal: manager,
      contractSource: { source, publish_height: 100 },
      contractInterface: compatibleInterface(),
      upstreamSource,
      observeOnly: false,
      createdAt: "2026-07-16T12:00:00.000Z",
    });
    expect(result.profile).toMatchObject({
      tier: "reference-render",
      networkId: 256,
      reference: { upstreamProfileId: DEVNET_REFERENCE_MANAGER.profile.id },
    });
    expect(result.profile).not.toHaveProperty("automationEligible");
    expect(result.profile).not.toHaveProperty("productionApproved");
  });

  it("rejects missing or ambiguous embedded reference principals", () => {
    expect(() => inferReferencePrincipals("(ok true)")).toThrow(
      "Expected exactly one embedded PoX-5 deployer, found 0",
    );
    expect(() =>
      inferReferencePrincipals(
        "'ST000000000000000000002AMW42H.pox-5 'ST1F7QA2MDF17S807EPA36TSS8AMEFY4KA9TVGWXT.pox-5",
      ),
    ).toThrow("Expected exactly one embedded PoX-5 deployer, found 2");
  });

  it("short-circuits a built-in artifact without writing a profile", async () => {
    const source = await readFile(
      resolve(root, "contracts/reference-manager/generated/mainnet/signer-manager.clar"),
      "utf8",
    );
    const result = createInstalledManagerProfile({
      config: loadConfig({
        SIDEKICK_NETWORK: "mainnet",
        STACKS_NODE_RPC_URL: "http://node:20443",
      }),
      managerPrincipal: mainnetManager,
      contractSource: { source, publish_height: 100 },
      contractInterface: compatibleInterface(),
      upstreamSource: await readFile(
        resolve(root, "contracts/reference-manager/upstream/signer-manager.clar"),
        "utf8",
      ),
      observeOnly: false,
    });
    expect(result).toMatchObject({ status: "already-built-in", profile: null });
  });

  it("requires explicit observe-only mode for a semantically modified manager", async () => {
    const { upstreamSource, source } = await renderedSource();
    const modified = source.replace(
      "(define-constant ERR_NO_CLAIMABLE_REWARDS (err u1001))",
      "(define-constant ERR_NO_CLAIMABLE_REWARDS (err u1999))",
    );
    const input = {
      config: loadConfig({
        SIDEKICK_NETWORK: "devnet",
        STACKS_NODE_RPC_URL: "http://node:20443",
        STACKS_API_URL: "http://api:3999",
      }),
      managerPrincipal: manager,
      contractSource: { source: modified, publish_height: 100 },
      contractInterface: compatibleInterface(),
      upstreamSource,
    };
    expect(() => createInstalledManagerProfile({ ...input, observeOnly: false })).toThrow(
      "Re-run with --observe-only",
    );
    expect(createInstalledManagerProfile({ ...input, observeOnly: true }).profile).toMatchObject({
      tier: "custom-observe",
    });
    expect(
      createInstalledManagerProfile({ ...input, upstreamSource: null, observeOnly: true }).profile,
    ).toMatchObject({ tier: "custom-observe" });
  });

  it("rejects alternate mainnet principals in both profile creation and verification", async () => {
    const upstreamSource = await readFile(
      resolve(root, "contracts/reference-manager/upstream/signer-manager.clar"),
      "utf8",
    );
    const alternateSbtcDeployer = "SP2JXKMSH007NPYAQHKJPQMAQYAD90NQGTVJVQ02B";
    const renderProfile = parseManagerProfile({
      ...MAINNET_REFERENCE_MANAGER.profile,
      id: "test-mainnet-alternate-render",
      contracts: {
        ...MAINNET_REFERENCE_MANAGER.profile.contracts,
        sbtcDeployer: alternateSbtcDeployer,
      },
      productionApproved: false,
    });
    const source = generateManagerArtifact(upstreamSource, renderProfile).source;
    const config = loadConfig({
      SIDEKICK_NETWORK: "mainnet",
      STACKS_NODE_RPC_URL: "http://node:20443",
    });
    const input = {
      config,
      managerPrincipal: mainnetManager,
      contractSource: { source, publish_height: 100 },
      contractInterface: compatibleInterface(),
      upstreamSource,
    };
    expect(() => createInstalledManagerProfile({ ...input, observeOnly: false })).toThrow(
      "fixed canonical PoX-5 and sBTC principals",
    );
    expect(createInstalledManagerProfile({ ...input, observeOnly: true }).profile).toMatchObject({
      tier: "custom-observe",
    });

    const profile = parseInstalledManagerProfile({
      schemaVersion: 1,
      id: "crafted-mainnet-alternate-render",
      managerPrincipal: mainnetManager,
      network: "mainnet",
      sourceSha256: claritySourceSha256(source),
      canonicalSha256: claritySourceSha256(canonicalizeClaritySource(source)),
      createdAt: "2026-07-16T12:00:00.000Z",
      proofVersion: 1,
      tier: "reference-render",
      reference: {
        upstreamProfileId: MAINNET_REFERENCE_MANAGER.profile.id,
        upstream: MAINNET_REFERENCE_MANAGER.profile.upstream,
        pox5: MAINNET_REFERENCE_MANAGER.profile.contracts.pox5,
        sbtcDeployer: alternateSbtcDeployer,
      },
    });
    const report = verifyManagerArtifact(
      "mainnet",
      mainnetManager,
      { source, publish_height: 100 },
      compatibleInterface(),
      context(upstreamSource, {
        directory: "/profiles",
        profiles: [{ fileName: "crafted-mainnet.json", profile }],
        issues: [],
      }),
    );
    expect(report).toMatchObject({
      source: { tier: "unrecognized" },
      provenance: { status: "failed" },
      automationEligible: false,
    });
    expect(report.automationEligibilityReason).toContain("fixed canonical PoX-5 and sBTC");
  });

  it("reproduces an installed devnet render but cannot promote a forged semantic edit", async () => {
    const { upstreamSource, source } = await renderedSource();
    const config = loadConfig({
      SIDEKICK_NETWORK: "devnet",
      STACKS_NODE_RPC_URL: "http://node:20443",
      STACKS_API_URL: "http://api:3999",
    });
    const created = createInstalledManagerProfile({
      config,
      managerPrincipal: manager,
      contractSource: { source, publish_height: 100 },
      contractInterface: compatibleInterface(),
      upstreamSource,
      observeOnly: false,
    });
    const profile = created.profile;
    if (!profile) throw new Error("Expected an installed profile");
    const store = {
      directory: "/profiles",
      profiles: [{ fileName: "manager.json", profile }],
      issues: [],
    };
    const report = verifyManagerArtifact(
      "devnet",
      manager,
      { source, publish_height: 100 },
      compatibleInterface(),
      context(upstreamSource, store),
    );
    expect(report).toMatchObject({
      source: { tier: "reference-render", origin: "operator-installed" },
      provenance: { status: "verified" },
      attachAllowed: true,
      automationEligible: true,
    });

    if (profile.tier !== "reference-render") throw new Error("Expected a reference render");
    const staleProvenance = parseInstalledManagerProfile({
      ...profile,
      reference: {
        ...profile.reference,
        upstream: { ...profile.reference.upstream, commit: "0".repeat(40) },
      },
    });
    expect(
      verifyManagerArtifact(
        "devnet",
        manager,
        { source, publish_height: 100 },
        compatibleInterface(),
        context(upstreamSource, {
          directory: "/profiles",
          profiles: [{ fileName: "stale.json", profile: staleProvenance }],
          issues: [],
        }),
      ),
    ).toMatchObject({
      source: { tier: "unrecognized" },
      provenance: { status: "failed" },
      automationEligible: false,
    });

    const modified = source.replace(
      "(define-constant ERR_NO_CLAIMABLE_REWARDS (err u1001))",
      "(define-constant ERR_NO_CLAIMABLE_REWARDS (err u1999))",
    );
    expect(modified).not.toBe(source);
    const forged = parseInstalledManagerProfile({
      ...profile,
      sourceSha256: claritySourceSha256(modified),
      canonicalSha256: claritySourceSha256(canonicalizeClaritySource(modified)),
    });
    const forgedReport = verifyManagerArtifact(
      "devnet",
      manager,
      { source: modified, publish_height: 100 },
      compatibleInterface(),
      context(upstreamSource, {
        directory: "/profiles",
        profiles: [{ fileName: "forged.json", profile: forged }],
        issues: [],
      }),
    );
    expect(forgedReport).toMatchObject({
      source: { tier: "unrecognized", recognized: false },
      provenance: { status: "failed" },
      attachAllowed: true,
      automationEligible: false,
    });
  });

  it("does not inherit approval from an unrelated network profile", async () => {
    const { upstreamSource, source } = await renderedSource("testnet");
    const config = loadConfig({
      SIDEKICK_NETWORK: "pox5-testnet",
      SIDEKICK_NETWORK_ID: "256",
      STACKS_NODE_RPC_URL: "http://node:20443",
    });
    const created = createInstalledManagerProfile({
      config,
      managerPrincipal: manager,
      contractSource: { source, publish_height: 100 },
      contractInterface: compatibleInterface(),
      upstreamSource,
      observeOnly: false,
    });
    if (!created.profile) throw new Error("Expected an installed profile");
    const report = verifyManagerArtifact(
      "testnet",
      manager,
      { source, publish_height: 100 },
      compatibleInterface(),
      context(
        upstreamSource,
        {
          directory: "/profiles",
          profiles: [{ fileName: "private.json", profile: created.profile }],
          issues: [],
        },
        256,
      ),
    );
    expect(report).toMatchObject({
      source: { tier: "reference-render" },
      provenance: { status: "verified" },
      attachAllowed: true,
      automationEligible: false,
    });
    expect(report.automationEligibilityReason).toContain(
      "no matching testnet built-in profile is production-approved",
    );
  });

  it("cannot inherit devnet approval through a crafted testnet profile", async () => {
    const { upstreamSource, source } = await renderedSource("testnet");
    const config = loadConfig({
      SIDEKICK_NETWORK: "pox5-testnet",
      SIDEKICK_NETWORK_ID: "256",
      STACKS_NODE_RPC_URL: "http://node:20443",
    });
    const created = createInstalledManagerProfile({
      config,
      managerPrincipal: manager,
      contractSource: { source, publish_height: 100 },
      contractInterface: compatibleInterface(),
      upstreamSource,
      observeOnly: false,
    });
    if (created.profile?.tier !== "reference-render") {
      throw new Error("Expected a reference render profile");
    }
    const crafted = parseInstalledManagerProfile({
      ...created.profile,
      reference: {
        ...created.profile.reference,
        upstreamProfileId: DEVNET_REFERENCE_MANAGER.profile.id,
        upstream: DEVNET_REFERENCE_MANAGER.profile.upstream,
      },
    });
    const report = verifyManagerArtifact(
      "testnet",
      manager,
      { source, publish_height: 100 },
      compatibleInterface(),
      context(
        upstreamSource,
        {
          directory: "/profiles",
          profiles: [{ fileName: "crafted.json", profile: crafted }],
          issues: [],
        },
        256,
      ),
    );
    expect(report).toMatchObject({
      source: { tier: "reference-render" },
      provenance: { status: "verified" },
      attachAllowed: true,
      automationEligible: false,
    });
    expect(report.automationEligibilityReason).toContain(
      "no matching testnet built-in profile is production-approved",
    );
  });

  it("does not apply an operator profile on the wrong private network ID", () => {
    const source = "(define-public (custom) (ok true))";
    const profile = parseInstalledManagerProfile({
      schemaVersion: 1,
      id: "private-256-custom",
      managerPrincipal: manager,
      network: "testnet",
      networkId: 256,
      sourceSha256: claritySourceSha256(source),
      canonicalSha256: claritySourceSha256(canonicalizeClaritySource(source)),
      createdAt: "2026-07-16T12:00:00.000Z",
      proofVersion: 1,
      tier: "custom-observe",
    });
    const report = verifyManagerArtifact(
      "testnet",
      manager,
      { source, publish_height: 100 },
      compatibleInterface(),
      context(
        "",
        {
          directory: "/profiles",
          profiles: [{ fileName: "private.json", profile }],
          issues: [],
        },
        512,
      ),
    );
    expect(report).toMatchObject({
      source: { tier: "unrecognized" },
      provenance: { status: "failed" },
      attachAllowed: true,
      automationEligible: false,
    });
    expect(report.automationEligibilityReason).toContain("does not match configured network ID");
  });

  it("identifies a matching custom profile without enabling reference automation", () => {
    const source = "(define-public (custom) (ok true))";
    const profile = parseInstalledManagerProfile({
      schemaVersion: 1,
      id: "custom-read-only",
      managerPrincipal: manager,
      network: "testnet",
      sourceSha256: claritySourceSha256(source),
      canonicalSha256: claritySourceSha256(canonicalizeClaritySource(source)),
      createdAt: "2026-07-16T12:00:00.000Z",
      proofVersion: 1,
      tier: "custom-observe",
    });
    const report = verifyManagerArtifact(
      "testnet",
      manager,
      { source, publish_height: 100 },
      compatibleInterface(),
      context("", {
        directory: "/profiles",
        profiles: [{ fileName: "custom.json", profile }],
        issues: [],
      }),
    );
    expect(report).toMatchObject({
      source: { tier: "custom-observe", origin: "operator-installed", recognized: true },
      provenance: { status: "not-applicable" },
      attachAllowed: true,
      automationEligible: false,
    });
  });

  it("loads and re-proves an installed profile in a fresh runtime context after restart", async () => {
    const { upstreamSource, source } = await renderedSource();
    const config = loadConfig({
      SIDEKICK_NETWORK: "devnet",
      STACKS_NODE_RPC_URL: "http://node:20443",
      STACKS_API_URL: "http://api:3999",
    });
    const created = createInstalledManagerProfile({
      config,
      managerPrincipal: manager,
      contractSource: { source, publish_height: 100 },
      contractInterface: compatibleInterface(),
      upstreamSource,
      observeOnly: false,
    });
    if (!created.profile) throw new Error("Expected an installed profile");
    const directory = await mkdtemp(resolve(tmpdir(), "sidekick-manager-restart-"));
    temporaryDirectories.push(directory);
    await writeInstalledManagerProfile(resolve(directory, "manager.json"), created.profile);
    const node = {
      getContractSource: vi.fn().mockResolvedValue({ source, publish_height: 100 }),
      getContractInterface: vi.fn().mockResolvedValue(compatibleInterface()),
    } as unknown as StacksNodeClient;

    for (let restart = 0; restart < 2; restart += 1) {
      const runtime = await createManagerVerificationContext({
        trustedProfilesDirectory: directory,
        contractsDirectory: resolve(root, "contracts"),
      });
      await expect(inspectDeployedManager(node, "devnet", manager, runtime)).resolves.toMatchObject(
        {
          source: { tier: "reference-render", origin: "operator-installed" },
          provenance: { status: "verified" },
          automationEligible: true,
        },
      );
    }
    expect(node.getContractSource).toHaveBeenCalledTimes(2);
  });

  it("caches immutable deployed source until explicit invalidation", async () => {
    const source = await readFile(
      resolve(root, "contracts/reference-manager/generated/mainnet/signer-manager.clar"),
      "utf8",
    );
    const node = {
      getContractSource: vi.fn().mockResolvedValue({ source, publish_height: 100 }),
      getContractInterface: vi.fn().mockResolvedValue(compatibleInterface()),
    } as unknown as StacksNodeClient;
    const managerPrincipal = "SP000000000000000000002Q6VF78.signer-manager";
    const verificationContext = context("", {
      directory: null,
      profiles: [],
      issues: [],
    });
    await inspectDeployedManager(node, "mainnet", managerPrincipal, verificationContext);
    await inspectDeployedManager(node, "mainnet", managerPrincipal, verificationContext);
    expect(node.getContractSource).toHaveBeenCalledTimes(1);
    invalidateManagerVerificationCache(verificationContext, managerPrincipal);
    await inspectDeployedManager(node, "mainnet", managerPrincipal, verificationContext);
    expect(node.getContractSource).toHaveBeenCalledTimes(2);
  });
});
