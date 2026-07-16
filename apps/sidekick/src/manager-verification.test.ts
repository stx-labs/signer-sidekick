import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type ContractInterface,
  type StacksNodeClient,
  UpstreamHttpError,
} from "./chain-clients.js";
import { inspectManagerOrReportMissing, verifyManagerArtifact } from "./manager-verification.js";

const root = resolve(import.meta.dirname, "../../..");
const manager = "SP000000000000000000002Q6VF78.signer-manager";

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
