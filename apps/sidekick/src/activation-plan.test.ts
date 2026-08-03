import { describe, expect, it } from "vitest";
import {
  activationPlanSchema,
  createAttachActivationPlan,
  createFreshActivationPlan,
} from "./activation-plan.js";
import type { ManagerVerificationReport } from "./manager-verification.js";
import type { PreflightResult } from "./preflight.js";
import type { RegistrationVerification } from "./registration-verification.js";
import type { PoolSetupStatus } from "./setup-status.js";

const managerPrincipal = "SP000000000000000000002Q6VF78.signer-manager";
const pox5ContractId = "SP000000000000000000002Q6VF78.pox-5";

const preflight = {
  status: "pass",
  network: "mainnet",
  pox: { pox5ContractId },
} as PreflightResult;

describe("activation plans", () => {
  it("walks a fresh operator through every external-signing boundary", () => {
    const result = createFreshActivationPlan({
      network: "mainnet",
      preflight,
      adminPrincipal: "SP000000000000000000002Q6VF78",
      contractName: "signer-manager",
      outputDirectory: "/tmp/manager output",
      authId: "42",
      signerConfigPath: "/home/signer/config.toml",
    });

    expect(result).toMatchObject({
      path: "fresh",
      managerPrincipal,
      mode: "observe",
      status: "ready",
      safety: {
        deploysContract: false,
        readsSignerConfig: false,
        signsTransaction: false,
        broadcastsTransaction: false,
      },
    });
    expect(result.steps.find(({ id }) => id === "deploy-manager")).toMatchObject({
      status: "pending",
      command: null,
    });
    expect(result.steps.find(({ id }) => id === "prepare-signer-grant")?.command).toContain(" 42 ");
    expect(result.steps.find(({ id }) => id === "render-manager")?.command).toContain(
      "'/tmp/manager output'",
    );
    expect(result.steps.find(({ id }) => id === "verify-signer-grant")?.command).toContain(
      "<SIGNER_OUTPUT_JSON>",
    );
    expect(() => activationPlanSchema.parse(result)).not.toThrow();
  });

  it("does not present a fixed signer set as an unfinished attach step", () => {
    const setup = {
      status: "ready",
      enrollmentWindow: { status: "prepare-phase" },
      eligibility: {
        next: {
          cycleId: 142,
          meetsThreshold: false,
          inSignerSet: false,
          marginUstx: "-1000000",
        },
      },
    } as PoolSetupStatus;
    const result = createAttachActivationPlan(
      preflight,
      {
        managerPrincipal,
        attachAllowed: true,
        source: { tier: "reference-built-in", profileId: "reference" },
      } as ManagerVerificationReport,
      { registered: true, signerKeyGrantValid: true } as RegistrationVerification,
      setup,
    );

    expect(result.steps.find(({ id }) => id === "verify-next-cycle-eligibility")).toMatchObject({
      status: "complete",
      detail: "Cycle 142 signer-set eligibility is fixed for this prepare phase",
    });
  });

  it("keeps pre-activation signer work blocked until the node exposes PoX-5", () => {
    const result = createFreshActivationPlan({
      network: "mainnet",
      preflight: {
        ...preflight,
        status: "warn",
        pox: { ...preflight.pox, pox5ContractId: null },
      },
      adminPrincipal: "SP000000000000000000002Q6VF78",
      contractName: "signer-manager",
      outputDirectory: "/tmp/manager",
      authId: "1",
    });

    expect(result.steps.find(({ id }) => id === "prepare-signer-grant")).toMatchObject({
      status: "blocked",
      command: null,
    });
  });

  it("uses an operator-provided compatibility artifact without a Sidekick release", () => {
    const result = createFreshActivationPlan({
      network: "testnet",
      preflight: {
        ...preflight,
        network: "testnet",
        pox: { ...preflight.pox, pox5ContractId: "ST000000000000000000002AMW42H.pox-5" },
        compatibility: {
          managerProfileId: "public-testnet-pox5-reference-manager",
        },
      } as PreflightResult,
      adminPrincipal: "ST000000000000000000002AMW42H",
      contractName: "signer-manager",
      outputDirectory: "/tmp/manager",
      authId: "1",
    });

    expect(result.steps.find(({ id }) => id === "render-manager")?.detail).toBe(
      "Create the contract that represents your pool, registers your signer, and manages rewards.",
    );
    expect(result.steps.find(({ id }) => id === "deploy-manager")).toMatchObject({
      status: "pending",
    });
  });

  it("lets an operator-provided mainnet profile supersede the compiled manager artifact", () => {
    const result = createFreshActivationPlan({
      network: "mainnet",
      preflight: {
        ...preflight,
        compatibility: {
          ...preflight.compatibility,
          managerProfileId: "operator-mainnet-upgrade-reference-manager",
        },
      },
      adminPrincipal: "SP000000000000000000002Q6VF78",
      contractName: "signer-manager",
      outputDirectory: "/tmp/manager",
      authId: "1",
    });

    expect(result.steps.find(({ id }) => id === "render-manager")?.detail).toBe(
      "Create the contract that represents your pool, registers your signer, and manages rewards.",
    );
    expect(result.steps.find(({ id }) => id === "deploy-manager")).toMatchObject({
      status: "pending",
    });
  });

  it("turns attached live state into a concise remaining-work plan", () => {
    const manager = {
      managerPrincipal,
      attachAllowed: true,
      source: {
        recognized: true,
        profileId: "stacks-4.0.0-mainnet-reference-manager",
        tier: "reference-built-in",
        origin: "built-in",
      },
    } as ManagerVerificationReport;
    const registration = {
      registered: true,
      signerKeyGrantValid: true,
      reason: "Registration and grant are valid",
    } as RegistrationVerification;
    const setup = {
      eligibility: {
        current: null,
        next: {
          cycleId: 141,
          marginUstx: "2000000000",
          meetsThreshold: true,
          inSignerSet: true,
        },
      },
    } as PoolSetupStatus;

    const result = createAttachActivationPlan(preflight, manager, registration, setup);

    expect(result.status).toBe("ready");
    expect(result.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "verify-manager", status: "complete" }),
        expect.objectContaining({ id: "verify-registration", status: "complete" }),
        expect.objectContaining({ id: "verify-signer-grant", status: "complete" }),
        expect.objectContaining({ id: "verify-next-cycle-eligibility", status: "complete" }),
        expect.objectContaining({ id: "publish-enrollment-info", status: "ready" }),
      ]),
    );
  });

  it("blocks attach completion when the live grant is invalid", () => {
    const result = createAttachActivationPlan(
      preflight,
      {
        managerPrincipal,
        attachAllowed: true,
        source: { recognized: false, profileId: null },
      } as ManagerVerificationReport,
      {
        registered: true,
        signerKeyGrantValid: false,
        reason: "Grant is revoked",
      } as RegistrationVerification,
      { eligibility: { current: null, next: null } } as PoolSetupStatus,
    );

    expect(result.status).toBe("blocked");
    expect(result.steps.find(({ id }) => id === "verify-signer-grant")?.status).toBe("blocked");
  });
});
