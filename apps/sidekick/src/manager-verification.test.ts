import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { TESTNET_COMPATIBILITY } from "@stx-labs/signer-sidekick-protocol/known-network-compatibility";
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
    clarity_version: "Clarity6",
    epoch: "Epoch40",
    functions: [
      ...publicFunctions.map((name) =>
        name === "validate-stake!"
          ? {
              name,
              access: "public",
              args: [
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
              ],
              outputs: { type: { response: { ok: "bool", error: "uint128" } } },
            }
          : { name, access: "public", args: [], outputs: null },
      ),
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
  it.each([
    ["missing final newline", (source: string) => source.trimEnd()],
    ["CRLF", (source: string) => source.replaceAll("\n", "\r\n")],
    [
      "comments and whitespace",
      (source: string) => `;; an operator note with "quotes"\n\n${source.replaceAll("  ", "\t")}\n`,
    ],
  ])("admits the reviewed program with %s while binding execution to deployed bytes", async (_, transform) => {
    const original = await readFile(
      resolve(root, "contracts/reference-manager/generated/mainnet/signer-manager.clar"),
      "utf8",
    );
    const source = transform(original);
    const report = verifyManagerArtifact(
      "mainnet",
      manager,
      { source, publish_height: 8_600_000 },
      compatibleInterface(),
    );
    expect(report.source).toMatchObject({ match: "canonical", recognized: true });
    expect(report.capabilities.sourceReview).toMatchObject({
      reviewed: true,
      match: "canonical",
      artifactId: "stacks-4.0.0-mainnet-reference-manager",
    });
    expect(report.capabilities.eventVocabulary.normalizationAvailable).toBe(true);
    expect(report.capabilities.actions.every(({ executionAvailable }) => executionAvailable)).toBe(
      true,
    );
    expect(
      report.capabilities.actions.every(
        ({ adapter }) => adapter?.reviewedSourceSha256 === claritySourceSha256(source),
      ),
    ).toBe(true);
    expect(claritySourceSha256(source)).not.toBe(claritySourceSha256(original));
    // Program recognition is not production approval or authorization for unattended execution.
    expect(report.automationEligible).toBe(false);
  });

  it.each([
    ["constant", (source: string) => source.replace("u10000", "u10001")],
    ["caller", (source: string) => source.replace("tx-sender", "contract-caller")],
    [
      "identifier boundary",
      (source: string) =>
        source.replace("(define-public (claim-rewards", "(define-public (claim- rewards"),
    ],
    [
      "string literal",
      (source: string) => source.replace('"claim-staker-rewards"', '"claim-staker-reward"'),
    ],
  ])("does not admit an unreviewed %s change", async (_, transform) => {
    const original = await readFile(
      resolve(root, "contracts/reference-manager/generated/mainnet/signer-manager.clar"),
      "utf8",
    );
    const source = transform(original);
    expect(source).not.toBe(original);
    const report = verifyManagerArtifact(
      "mainnet",
      manager,
      { source, publish_height: 8_600_000 },
      compatibleInterface(),
    );
    expect(report.capabilities.sourceReview.reviewed).toBe(false);
    expect(report.capabilities.eventVocabulary.normalizationAvailable).toBe(false);
    expect(report.capabilities.actions.every(({ executionAvailable }) => !executionAvailable)).toBe(
      true,
    );
  });

  it.each([
    "Clarity4",
    undefined,
  ])("still rejects a canonical match with unreviewed execution semantics: %s", async (clarityVersion) => {
    const source = (
      await readFile(
        resolve(root, "contracts/reference-manager/generated/mainnet/signer-manager.clar"),
        "utf8",
      )
    ).trimEnd();
    const contractInterface = compatibleInterface();
    contractInterface.clarity_version = clarityVersion;
    const report = verifyManagerArtifact(
      "mainnet",
      manager,
      { source, publish_height: 8_600_000 },
      contractInterface,
    );
    expect(report.source.match).toBe("canonical");
    expect(report.capabilities.sourceReview.reviewed).toBe(false);
    expect(report.capabilities.actions.every(({ executionAvailable }) => !executionAvailable)).toBe(
      true,
    );
  });

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
      "Mainnet profile stacks-4.0.0-mainnet-reference-manager is not production-approved",
    );
  });

  it("does not unlock execution when reviewed source bytes use different Clarity semantics", async () => {
    const source = await readFile(
      resolve(root, "contracts/reference-manager/generated/mainnet/signer-manager.clar"),
      "utf8",
    );
    const contractInterface = compatibleInterface();
    contractInterface.clarity_version = "Clarity4";
    const report = verifyManagerArtifact(
      "mainnet",
      manager,
      { source, publish_height: 8_600_000 },
      contractInterface,
    );

    expect(report).toMatchObject({
      attachAllowed: true,
      capabilities: { sourceReview: { reviewed: false } },
    });
    expect(report.capabilities.actions.every(({ executionAvailable }) => !executionAvailable)).toBe(
      true,
    );
    expect(report.capabilities.sourceReview.reason).toContain(
      "deployed execution semantics Clarity4/Epoch40",
    );
  });

  it("fails closed when a reviewed artifact or node omits execution semantics", async () => {
    const source = await readFile(
      resolve(root, "contracts/reference-manager/generated/mainnet/signer-manager.clar"),
      "utf8",
    );
    const contractInterface = compatibleInterface();
    delete contractInterface.clarity_version;
    delete contractInterface.epoch;
    const report = verifyManagerArtifact(
      "mainnet",
      manager,
      { source, publish_height: 8_600_000 },
      contractInterface,
    );

    expect(report.capabilities.sourceReview).toMatchObject({ reviewed: false });
    expect(report.capabilities.actions.every(({ executionAvailable }) => !executionAvailable)).toBe(
      true,
    );
    expect(report.capabilities.sourceReview.reason).toContain(
      "deployed execution semantics unknown Clarity version/unknown epoch",
    );
  });

  it("allows technical use of an unknown manager without granting Assist", () => {
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
    expect(report.automationEligibilityReason).toContain("No reviewed reference program");
  });

  it("recognizes a reference manager derived from operator compatibility data", async () => {
    const profilesDirectory = await mkdtemp(resolve(tmpdir(), "sidekick-network-profile-"));
    temporaryDirectories.push(profilesDirectory);
    const profileTemplate = {
      ...TESTNET_COMPATIBILITY,
      revision: 2,
      publishedAt: "2026-07-17T00:00:00.000Z",
      sbtc: {
        tokenContract: "ST1F7QA2MDF17S807EPA36TSS8AMEFY4KA9TVGWXT.sbtc-token",
        registryContract: "ST1F7QA2MDF17S807EPA36TSS8AMEFY4KA9TVGWXT.sbtc-registry",
      },
      referenceManager: {
        ...TESTNET_COMPATIBILITY.referenceManager,
        profileId: "operator-private-1-reference-manager",
      },
    };
    const upstreamSource = await readFile(
      resolve(root, "contracts/reference-manager/upstream/signer-manager.clar"),
      "utf8",
    );
    const rendered = generateManagerArtifact(
      upstreamSource,
      managerArtifactFromNetworkProfile(profileTemplate).profile,
    );
    const profile = {
      ...profileTemplate,
      referenceManager: {
        ...profileTemplate.referenceManager,
        sourceSha256: rendered.metadata.outputSha256,
        canonicalSha256: rendered.metadata.canonicalOutputSha256,
      },
    };
    await writeFile(resolve(profilesDirectory, "private-1.json"), JSON.stringify(profile));
    const artifact = managerArtifactFromNetworkProfile(profile);
    const generated = generateManagerArtifact(upstreamSource, artifact.profile);
    const context = await createManagerVerificationContext({
      contractsDirectory: resolve(root, "contracts"),
      compatibilityProfilesDirectory: profilesDirectory,
      expectedNetworkId: TESTNET_COMPATIBILITY.networkId,
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
    expect(report.automationEligibilityReason).toContain(
      "Operator-provided network data cannot grant executable manager capabilities",
    );
  });

  it("enables the byte-exact built-in testnet reference manager", async () => {
    const upstreamSource = await readFile(
      resolve(root, "contracts/reference-manager/upstream/signer-manager.clar"),
      "utf8",
    );
    const artifact = managerArtifactFromNetworkProfile(TESTNET_COMPATIBILITY);
    const generated = generateManagerArtifact(upstreamSource, artifact.profile);
    const context = await createManagerVerificationContext({
      contractsDirectory: resolve(root, "contracts"),
      expectedNetworkId: TESTNET_COMPATIBILITY.networkId,
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
        tier: "reference-built-in",
        profileId: TESTNET_COMPATIBILITY.referenceManager.profileId,
      },
      attachAllowed: true,
      automationEligible: true,
    });
    expect(report.capabilities.sourceReview).toMatchObject({ reviewed: true });
    expect(report.capabilities.actions.some(({ executionAvailable }) => executionAvailable)).toBe(
      true,
    );
  });

  it("allows the built-in regtest reference manager without production approval", async () => {
    const source = await readFile(
      resolve(root, "contracts/reference-manager/generated/regtest/signer-manager.clar"),
      "utf8",
    );
    const report = verifyManagerArtifact(
      "regtest",
      "ST000000000000000000002AMW42H.signer-manager",
      { source, publish_height: 1 },
      compatibleInterface(),
    );

    expect(report).toMatchObject({
      networkMatches: true,
      source: { match: "exact", recognized: true, tier: "reference-built-in" },
      interface: { compatible: true },
      attachAllowed: true,
      automationEligible: true,
      recommendedMode: "observe",
    });
    expect(report.automationEligibilityReason).toContain("non-mainnet profile");
  });

  it("does not recognize a manager hash merely asserted by operator network data", async () => {
    const profilesDirectory = await mkdtemp(resolve(tmpdir(), "sidekick-network-profile-"));
    temporaryDirectories.push(profilesDirectory);
    const customSource = "(define-public (custom) (ok true))";
    const profile = {
      ...TESTNET_COMPATIBILITY,
      revision: 2,
      publishedAt: "2026-07-17T00:00:00.000Z",
      referenceManager: {
        ...TESTNET_COMPATIBILITY.referenceManager,
        profileId: "operator-forged-reference-manager",
        sourceSha256: claritySourceSha256(customSource),
        canonicalSha256: claritySourceSha256(canonicalizeClaritySource(customSource)),
      },
    };
    await writeFile(resolve(profilesDirectory, "forged.json"), JSON.stringify(profile));
    const context = await createManagerVerificationContext({
      contractsDirectory: resolve(root, "contracts"),
      compatibilityProfilesDirectory: profilesDirectory,
      expectedNetworkId: TESTNET_COMPATIBILITY.networkId,
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

  it("attaches through the trait while reporting a missing reference capability", () => {
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

    expect(report.interface).toMatchObject({
      compatible: true,
      missingFunctions: [],
      clarityVersion: "Clarity6",
      epoch: "Epoch40",
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(report.attachAllowed).toBe(true);
    expect(
      report.capabilities.actions.find(({ id }) => id === "reference-reward-claims"),
    ).toMatchObject({
      interfaceAvailable: false,
      executionAvailable: false,
      missingFunctions: ["claim-staker-rewards"],
    });
  });

  it("rejects attachment when validate-stake! does not match the trait signature", () => {
    const contractInterface = compatibleInterface();
    const trait = contractInterface.functions.find(({ name }) => name === "validate-stake!");
    if (!trait) throw new Error("Missing validate-stake! fixture");
    trait.outputs = { type: { response: { ok: "uint128", error: "uint128" } } };

    const report = verifyManagerArtifact(
      "mainnet",
      manager,
      { source: "(ok true)", publish_height: 1 },
      contractInterface,
    );

    expect(report).toMatchObject({
      attachAllowed: false,
      interface: { compatible: false, missingFunctions: ["validate-stake!"] },
      capabilities: {
        signerManagerTrait: { compatible: false, reason: expect.stringContaining("response") },
      },
    });
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
