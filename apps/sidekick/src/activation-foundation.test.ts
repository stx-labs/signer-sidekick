import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  REFERENCE_MANAGER_PUBLIC_FUNCTIONS,
  REFERENCE_MANAGER_READ_ONLY_FUNCTIONS,
} from "@stx-labs/signer-sidekick-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { createAttachActivationPlan, createFreshActivationPlan } from "./activation-plan.js";
import type { ContractInterface } from "./chain-clients.js";
import { renderManagerDeployment } from "./manager-render.js";
import { verifyManagerArtifact } from "./manager-verification.js";
import type { PreflightResult } from "./preflight.js";
import type { RegistrationVerification } from "./registration-verification.js";
import type { PoolSetupStatus } from "./setup-status.js";

const root = resolve(import.meta.dirname, "../../..");
const contractsDirectory = resolve(root, "contracts");
const temporaryDirectories: string[] = [];
const adminPrincipal = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM";
const managerPrincipal = `${adminPrincipal}.signer-manager`;

function compatibleInterface(): ContractInterface {
  return {
    functions: [
      ...REFERENCE_MANAGER_PUBLIC_FUNCTIONS.map((name) => ({
        name,
        access: "public" as const,
        args: [],
        outputs: null,
      })),
      ...REFERENCE_MANAGER_READ_ONLY_FUNCTIONS.map((name) => ({
        name,
        access: "read_only" as const,
        args: [],
        outputs: null,
      })),
    ],
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("Fresh and attach activation foundation", () => {
  it("renders one immutable regtest artifact and carries it through both activation paths", async () => {
    const outputDirectory = await mkdtemp(resolve(tmpdir(), "sidekick-activation-"));
    temporaryDirectories.push(outputDirectory);
    const rendered = await renderManagerDeployment({
      network: "regtest",
      adminPrincipal,
      contractName: "signer-manager",
      contractsDirectory,
      outputDirectory,
    });
    const source = await readFile(rendered.sourcePath, "utf8");
    const committedSource = await readFile(
      resolve(contractsDirectory, "reference-manager/generated/regtest/signer-manager.clar"),
      "utf8",
    );

    expect(source).toBe(committedSource);
    expect(rendered.manifest).toMatchObject({
      network: "regtest",
      managerPrincipal,
      profile: {
        id: "stacks-4.0.0-regtest-reference-manager",
      },
      contracts: {
        pox5: "ST000000000000000000002AMW42H.pox-5",
        sbtcDeployer: "ST1F7QA2MDF17S807EPA36TSS8AMEFY4KA9TVGWXT",
      },
      artifact: {
        sourceSha256: "61db24eefbfe30ac778e0918d02019f2d33a831f376fbdb76e288fe16b070505",
      },
      operatorReviewRequired: true,
    });

    const verification = verifyManagerArtifact(
      "regtest",
      managerPrincipal,
      { source, publish_height: 10 },
      compatibleInterface(),
    );
    expect(verification).toMatchObject({
      source: {
        match: "exact",
        profileId: "stacks-4.0.0-regtest-reference-manager",
        recognized: true,
      },
      attachAllowed: true,
      automationEligible: false,
      recommendedMode: "observe",
    });

    const preflight = {
      status: "pass",
      network: "regtest",
      pox: { pox5ContractId: "ST000000000000000000002AMW42H.pox-5" },
    } as PreflightResult;
    const fresh = createFreshActivationPlan({
      network: "regtest",
      preflight,
      adminPrincipal,
      contractName: "signer-manager",
      outputDirectory,
      authId: "1",
    });
    expect(fresh).toMatchObject({
      path: "fresh",
      status: "ready",
      managerPrincipal,
      mode: "observe",
    });
    expect(fresh.steps.find(({ id }) => id === "render-manager")).toMatchObject({
      status: "ready",
    });
    expect(fresh.steps.find(({ id }) => id === "deploy-manager")).toMatchObject({
      status: "pending",
    });

    const attach = createAttachActivationPlan(
      preflight,
      verification,
      {
        registered: true,
        signerKeyGrantValid: true,
        reason: "Registration and grant are valid",
      } as RegistrationVerification,
      {
        eligibility: {
          current: null,
          next: {
            cycleId: 1,
            marginUstx: "0",
            meetsThreshold: true,
            inSignerSet: true,
          },
        },
      } as PoolSetupStatus,
    );
    expect(attach).toMatchObject({
      path: "attach",
      status: "ready",
      managerPrincipal,
      mode: "observe",
    });
    expect(attach.steps.find(({ id }) => id === "verify-manager")).toMatchObject({
      status: "complete",
    });
  });
});
