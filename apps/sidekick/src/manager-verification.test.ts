import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { POX5_TESTNET_COMPATIBILITY } from "@stx-labs/signer-sidekick-protocol/known-network-compatibility";
import {
  canonicalizeClaritySource,
  claritySourceSha256,
} from "@stx-labs/signer-sidekick-protocol/manager-adapter";
import { generateManagerArtifact } from "@stx-labs/signer-sidekick-protocol/manager-artifact";
import { managerArtifactFromNetworkProfile } from "@stx-labs/signer-sidekick-protocol/network-manager-artifact";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ContractInterface,
  type StacksNodeClient,
  UpstreamHttpError,
} from "./chain-clients.js";
import {
  createManagerVerificationContext,
  inspectManagerOrReportMissing,
  verifyManagerArtifact,
} from "./manager-verification.js";

const root = resolve(import.meta.dirname, "../../..");
const manager = "SP000000000000000000002Q6VF78.signer-manager";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
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

describe("deployed manager verification", () => {
  it("recognizes the mainnet reference artifact but keeps it in observe mode until approval", async () => {
    const source = await readFile(
      resolve(root, "contracts/reference-manager/generated/mainnet/signer-manager.clar"),
      "utf8",
    );
    const report = verifyManagerArtifact(
      "mainnet",
      manager,
      { source, publish_height: 8_600_000 },
      compatibleInterface(),
    );

    expect(report).toMatchObject({
      networkMatches: true,
      source: { match: "exact", recognized: true },
      interface: { compatible: true },
      attachAllowed: true,
      automationEligible: false,
      recommendedMode: "observe",
    });
    expect(report.reasons).toContain(
      "Profile stacks-4.0.0-mainnet-reference-manager is not production-approved",
    );
  });

  it("allows an unknown custom manager to attach only in observe mode", () => {
    const report = verifyManagerArtifact(
      "mainnet",
      manager,
      { source: "(define-public (custom) (ok true))", publish_height: 8_600_000 },
      compatibleInterface(),
    );

    expect(report).toMatchObject({
      source: { match: "unknown", recognized: false },
      attachAllowed: true,
      automationEligible: false,
      recommendedMode: "observe",
    });
  });

  it("recognizes a reference manager derived from operator compatibility data", async () => {
    const profilesDirectory = await mkdtemp(resolve(tmpdir(), "sidekick-network-profile-"));
    temporaryDirectories.push(profilesDirectory);
    const profile = {
      ...POX5_TESTNET_COMPATIBILITY,
      revision: 2,
      publishedAt: "2026-07-17T00:00:00.000Z",
      referenceManager: {
        ...POX5_TESTNET_COMPATIBILITY.referenceManager,
        profileId: "operator-private-1-reference-manager",
      },
    };
    await writeFile(resolve(profilesDirectory, "private-1.json"), JSON.stringify(profile));
    const upstreamSource = await readFile(
      resolve(root, "contracts/reference-manager/upstream/signer-manager.clar"),
      "utf8",
    );
    const artifact = managerArtifactFromNetworkProfile(profile);
    const generated = generateManagerArtifact(upstreamSource, artifact.profile);
    const context = await createManagerVerificationContext({
      contractsDirectory: resolve(root, "contracts"),
      compatibilityProfilesDirectory: profilesDirectory,
      expectedNetworkId: POX5_TESTNET_COMPATIBILITY.networkId,
    });
    const report = verifyManagerArtifact(
      "testnet",
      "ST000000000000000000002AMW42H.signer-manager",
      { source: generated.source, publish_height: 202 },
      compatibleInterface(),
      context,
    );

    expect(report).toMatchObject({
      source: {
        match: "exact",
        recognized: true,
        tier: "reference-render",
        profileId: profile.referenceManager.profileId,
        origin: "operator-installed",
      },
      attachAllowed: true,
      automationEligible: false,
      recommendedMode: "observe",
    });
  });

  it("does not recognize a manager hash merely asserted by operator network data", async () => {
    const profilesDirectory = await mkdtemp(resolve(tmpdir(), "sidekick-network-profile-"));
    temporaryDirectories.push(profilesDirectory);
    const customSource = "(define-public (custom) (ok true))";
    const profile = {
      ...POX5_TESTNET_COMPATIBILITY,
      revision: 2,
      publishedAt: "2026-07-17T00:00:00.000Z",
      referenceManager: {
        ...POX5_TESTNET_COMPATIBILITY.referenceManager,
        profileId: "operator-forged-reference-manager",
        sourceSha256: claritySourceSha256(customSource),
        canonicalSha256: claritySourceSha256(canonicalizeClaritySource(customSource)),
      },
    };
    await writeFile(resolve(profilesDirectory, "forged.json"), JSON.stringify(profile));
    const context = await createManagerVerificationContext({
      contractsDirectory: resolve(root, "contracts"),
      compatibilityProfilesDirectory: profilesDirectory,
      expectedNetworkId: POX5_TESTNET_COMPATIBILITY.networkId,
    });

    const report = verifyManagerArtifact(
      "testnet",
      "ST000000000000000000002AMW42H.signer-manager",
      { source: customSource, publish_height: 202 },
      compatibleInterface(),
      context,
    );

    expect(report.source).toMatchObject({ recognized: false, tier: "unrecognized" });
    expect(report.automationEligible).toBe(false);
  });

  it("rejects a manager principal from the wrong network", () => {
    expect(() =>
      verifyManagerArtifact(
        "testnet",
        manager,
        { source: "(ok true)", publish_height: 1 },
        compatibleInterface(),
      ),
    ).not.toThrow();

    const report = verifyManagerArtifact(
      "testnet",
      manager,
      { source: "(ok true)", publish_height: 1 },
      compatibleInterface(),
    );
    expect(report).toMatchObject({ networkMatches: false, attachAllowed: false });
  });

  it("reports required ABI functions that are absent", () => {
    const contractInterface = compatibleInterface();
    contractInterface.functions = contractInterface.functions.filter(
      (entry) => entry.name !== "claim-staker-rewards",
    );
    const report = verifyManagerArtifact(
      "mainnet",
      manager,
      { source: "(ok true)", publish_height: 1 },
      contractInterface,
    );

    expect(report.interface).toEqual({
      compatible: false,
      missingFunctions: ["claim-staker-rewards"],
    });
    expect(report.attachAllowed).toBe(false);
  });

  it("reports an expected pre-deployment 404 without hiding other node failures", async () => {
    const missingNode = {
      getContractSource: async () => {
        throw new UpstreamHttpError("not found", 404);
      },
      getContractInterface: async () => {
        throw new UpstreamHttpError("not found", 404);
      },
    } as unknown as StacksNodeClient;
    await expect(
      inspectManagerOrReportMissing(missingNode, "mainnet", manager),
    ).resolves.toMatchObject({
      attachAllowed: false,
      source: { recognized: false, sha256: "" },
      reasons: ["Manager contract is not deployed yet"],
    });

    const failedNode = {
      getContractSource: async () => {
        throw new UpstreamHttpError("node failed", 500);
      },
      getContractInterface: async () => compatibleInterface(),
    } as unknown as StacksNodeClient;
    await expect(
      inspectManagerOrReportMissing(failedNode, "mainnet", manager),
    ).rejects.toMatchObject({ status: 500 });
  });
});
