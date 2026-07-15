import { falseCV, trueCV, uintCV } from "@stacks/transactions";
import { describe, expect, it, vi } from "vitest";
import type { ManagerVerificationReport } from "./manager-verification.js";
import type { PreflightResult } from "./preflight.js";
import type { RegistrationVerification } from "./registration-verification.js";
import { readPoolSetupStatus } from "./setup-status.js";

const managerPrincipal = "SP000000000000000000002Q6VF78.signer-manager";
const pox5ContractId = "SP000000000000000000002Q6VF78.pox-5";

const preflight: PreflightResult = {
  status: "pass",
  network: "mainnet",
  node: { networkId: 1, burnBlockHeight: 960_240, stacksTipHeight: 8_600_000 },
  api: {
    serverVersion: "stacks-blockchain-api v9.0.0",
    burnBlockHeight: 960_240,
    stacksTipHeight: 8_600_000,
    burnBlockLag: 0,
  },
  pox: {
    activeContractId: pox5ContractId,
    rewardCycleId: 141,
    rewardCycleLength: 2_100,
    prepareCycleLength: 100,
    pox5Available: true,
    pox5ContractId,
    blocksUntilEpoch4: 0,
  },
  cycle: {
    currentId: 141,
    currentMinThresholdUstx: "50000000000",
    currentStackedUstx: "500000000000000",
    nextId: 142,
    nextMinThresholdUstx: "50000000000",
    nextStackedUstx: "75000000000",
    preparePhaseStartBurnHeight: 962_050,
    blocksUntilPreparePhase: 1_810,
    rewardPhaseStartBurnHeight: 962_150,
    blocksUntilRewardPhase: 1_910,
    isPreparePhase: false,
  },
  checks: [],
};

const manager: ManagerVerificationReport = {
  managerPrincipal,
  configuredNetwork: "mainnet",
  principalNetwork: "mainnet",
  networkMatches: true,
  publishHeight: 8_599_000,
  source: {
    match: "exact",
    profileId: "stacks-4.0.0-mainnet-reference-manager",
    sha256: "a".repeat(64),
    canonicalSha256: "b".repeat(64),
    recognized: true,
  },
  interface: { compatible: true, missingFunctions: [] },
  attachAllowed: true,
  automationEligible: false,
  recommendedMode: "observe",
  reasons: [],
};

const registration: RegistrationVerification = {
  managerPrincipal,
  pox5ContractId,
  registered: true,
  signerKeyHex: `02${"11".repeat(32)}`,
  signerKeyGrantValid: true,
  reason: "valid",
};

describe("pool setup status", () => {
  it("reads exact current and next cycle eligibility from PoX-5", async () => {
    const callReadOnly = vi
      .fn()
      .mockResolvedValueOnce(uintCV(49_000_000_000n))
      .mockResolvedValueOnce(falseCV())
      .mockResolvedValueOnce(uintCV(51_000_000_000n))
      .mockResolvedValueOnce(trueCV());

    const result = await readPoolSetupStatus({ callReadOnly }, preflight, manager, registration);

    expect(result.status).toBe("ready");
    expect(result.eligibility.current).toMatchObject({
      cycleId: 141,
      delegatedUstx: "49000000000",
      thresholdUstx: "50000000000",
      marginUstx: "-1000000000",
      meetsThreshold: false,
      inSignerSet: false,
    });
    expect(result.eligibility.next).toMatchObject({
      cycleId: 142,
      delegatedUstx: "51000000000",
      marginUstx: "1000000000",
      meetsThreshold: true,
      inSignerSet: true,
    });
    expect(callReadOnly).toHaveBeenCalledTimes(4);
  });

  it("surfaces threshold and signer-set disagreement instead of hiding it", async () => {
    const callReadOnly = vi
      .fn()
      .mockResolvedValueOnce(uintCV(50_000_000_000n))
      .mockResolvedValueOnce(trueCV())
      .mockResolvedValueOnce(uintCV(51_000_000_000n))
      .mockResolvedValueOnce(falseCV());

    const result = await readPoolSetupStatus({ callReadOnly }, preflight, manager, registration);

    expect(result.status).toBe("attention");
    expect(result.eligibility.next?.thresholdAndMembershipAgree).toBe(false);
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        id: "next-cycle-eligibility-consistency",
        status: "warn",
      }),
    );
  });

  it("closes enrollment one block before prepare phase because the next transaction executes too late", async () => {
    const callReadOnly = vi
      .fn()
      .mockResolvedValueOnce(uintCV(50_000_000_000n))
      .mockResolvedValueOnce(trueCV())
      .mockResolvedValueOnce(uintCV(50_000_000_000n))
      .mockResolvedValueOnce(trueCV());

    const result = await readPoolSetupStatus(
      { callReadOnly },
      {
        ...preflight,
        cycle: { ...preflight.cycle, blocksUntilPreparePhase: 1, isPreparePhase: false },
      },
      manager,
      registration,
    );

    expect(result.enrollmentWindow.status).toBe("prepare-phase");
    expect(result.checks).toContainEqual(
      expect.objectContaining({ id: "enrollment-window", status: "warn" }),
    );
  });

  it("blocks setup when registration and PoX-5 state are unavailable", async () => {
    const result = await readPoolSetupStatus(
      { callReadOnly: vi.fn() },
      {
        ...preflight,
        status: "fail",
        pox: { ...preflight.pox, pox5Available: false, pox5ContractId: null },
      },
      manager,
      null,
    );

    expect(result.status).toBe("blocked");
    expect(result.eligibility).toEqual({ current: null, next: null });
  });
});
