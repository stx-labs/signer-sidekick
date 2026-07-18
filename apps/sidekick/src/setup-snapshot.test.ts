import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runOperatorPreflight: vi.fn(),
  inspectDeployedManager: vi.fn(),
  inspectManagerOrReportMissing: vi.fn(),
  verifyManagerRegistration: vi.fn(),
  readPoolSetupStatus: vi.fn(),
  captureChainAnchor: vi.fn(),
}));

vi.mock("./preflight.js", () => ({ runOperatorPreflight: mocks.runOperatorPreflight }));
vi.mock("./manager-verification.js", () => ({
  inspectDeployedManager: mocks.inspectDeployedManager,
  inspectManagerOrReportMissing: mocks.inspectManagerOrReportMissing,
}));
vi.mock("./registration-verification.js", () => ({
  verifyManagerRegistration: mocks.verifyManagerRegistration,
}));
vi.mock("./setup-status.js", () => ({ readPoolSetupStatus: mocks.readPoolSetupStatus }));
vi.mock("./chain-clients.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./chain-clients.js")>()),
  captureChainAnchor: mocks.captureChainAnchor,
}));

import { ChainAnchorError } from "./chain-clients.js";
import { readSetupSnapshot } from "./setup-snapshot.js";

const config = { network: "mainnet" } as never;
const node = {} as never;
const api = {} as never;
const managerPrincipal = "SP000000000000000000002Q6VF78.signer-manager";
const chainAnchor = {
  stacksBlockHeight: 10,
  indexBlockHash: `0x${"ab".repeat(32)}`,
  burnBlockHeight: 5,
  rewardCycle: 2,
  rewardCycleLength: 10,
  prepareCycleLength: 2,
  cyclePosition: 3,
  phase: "reward",
  checkpoint: "first-half",
} as const;

describe("setup snapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.captureChainAnchor.mockResolvedValue(chainAnchor);
  });

  it("returns one canonical quartet and verifies registration when it is readable", async () => {
    const preflight = {
      node: { stacksTipHeight: 10, burnBlockHeight: 5 },
      cycle: { currentId: 2 },
      pox: { pox5ContractId: "SP000000000000000000002Q6VF78.pox-5" },
    };
    const manager = { attachAllowed: true };
    const registration = { registered: true };
    const setup = { status: "ready" };
    mocks.runOperatorPreflight.mockResolvedValue(preflight);
    mocks.inspectDeployedManager.mockResolvedValue(manager);
    mocks.verifyManagerRegistration.mockResolvedValue(registration);
    mocks.readPoolSetupStatus.mockResolvedValue(setup);

    await expect(
      readSetupSnapshot({
        config,
        node,
        api,
        managerPrincipal,
        managerVerification: undefined,
      }),
    ).resolves.toEqual({ chainAnchor, preflight, manager, registration, setup });
    expect(mocks.verifyManagerRegistration).toHaveBeenCalledWith(
      node,
      preflight.pox.pox5ContractId,
      managerPrincipal,
    );
    expect(mocks.readPoolSetupStatus).toHaveBeenCalledWith(node, preflight, manager, registration);
  });

  it("preserves blocked setup detail when registration cannot be read", async () => {
    const preflight = {
      node: { stacksTipHeight: 10, burnBlockHeight: 5 },
      cycle: { currentId: 2 },
      pox: { pox5ContractId: null },
    };
    const manager = { attachAllowed: false };
    const setup = { status: "blocked" };
    mocks.runOperatorPreflight.mockResolvedValue(preflight);
    mocks.inspectDeployedManager.mockResolvedValue(manager);
    mocks.readPoolSetupStatus.mockResolvedValue(setup);

    await expect(
      readSetupSnapshot({
        config,
        node,
        api,
        managerPrincipal,
        managerVerification: undefined,
      }),
    ).resolves.toEqual({ chainAnchor, preflight, manager, registration: null, setup });
    expect(mocks.verifyManagerRegistration).not.toHaveBeenCalled();
    expect(mocks.readPoolSetupStatus).toHaveBeenCalledWith(node, preflight, manager, null);
  });

  it("uses the missing-manager report for read-only operator snapshots", async () => {
    const preflight = {
      node: { stacksTipHeight: 10, burnBlockHeight: 5 },
      cycle: { currentId: 2 },
      pox: { pox5ContractId: null },
    };
    const manager = { attachAllowed: false };
    const setup = { status: "blocked" };
    mocks.runOperatorPreflight.mockResolvedValue(preflight);
    mocks.inspectManagerOrReportMissing.mockResolvedValue(manager);
    mocks.readPoolSetupStatus.mockResolvedValue(setup);

    await readSetupSnapshot({
      config,
      node,
      api,
      managerPrincipal,
      managerVerification: undefined,
      reportMissingManager: true,
    });

    expect(mocks.inspectManagerOrReportMissing).toHaveBeenCalledOnce();
    expect(mocks.inspectDeployedManager).not.toHaveBeenCalled();
  });

  it("retries the whole setup snapshot when its exact chain anchor moves", async () => {
    const moved = { ...chainAnchor, indexBlockHash: `0x${"cd".repeat(32)}` };
    mocks.captureChainAnchor.mockResolvedValueOnce(chainAnchor).mockResolvedValueOnce(moved);
    mocks.runOperatorPreflight.mockResolvedValue({
      node: { stacksTipHeight: 10, burnBlockHeight: 5 },
      cycle: { currentId: 2 },
      pox: { pox5ContractId: null },
    });
    mocks.inspectDeployedManager.mockResolvedValue({ attachAllowed: false });
    mocks.readPoolSetupStatus.mockResolvedValue({ status: "blocked" });

    await expect(
      readSetupSnapshot({
        config,
        node,
        api,
        managerPrincipal,
        managerVerification: undefined,
      }),
    ).resolves.toMatchObject({ chainAnchor });
    expect(mocks.captureChainAnchor).toHaveBeenCalledTimes(4);
    expect(mocks.runOperatorPreflight).toHaveBeenCalledTimes(2);
    expect(mocks.inspectDeployedManager).toHaveBeenCalledTimes(2);
    expect(mocks.readPoolSetupStatus).toHaveBeenCalledTimes(2);
  });

  it("retries the whole setup snapshot when anchor capture observes a moving tip", async () => {
    mocks.captureChainAnchor
      .mockRejectedValueOnce(new ChainAnchorError("tip moved", { retryable: true }))
      .mockResolvedValue(chainAnchor);
    mocks.runOperatorPreflight.mockResolvedValue({
      node: { stacksTipHeight: 10, burnBlockHeight: 5 },
      cycle: { currentId: 2 },
      pox: { pox5ContractId: null },
    });
    mocks.inspectDeployedManager.mockResolvedValue({ attachAllowed: false });
    mocks.readPoolSetupStatus.mockResolvedValue({ status: "blocked" });

    await expect(
      readSetupSnapshot({
        config,
        node,
        api,
        managerPrincipal,
        managerVerification: undefined,
      }),
    ).resolves.toMatchObject({ chainAnchor });
    expect(mocks.captureChainAnchor).toHaveBeenCalledTimes(3);
    expect(mocks.runOperatorPreflight).toHaveBeenCalledOnce();
  });

  it("retries when preflight facts do not match the snapshot anchor", async () => {
    const matchingPreflight = {
      node: { stacksTipHeight: 10, burnBlockHeight: 5 },
      cycle: { currentId: 2 },
      pox: { pox5ContractId: null },
    };
    mocks.runOperatorPreflight
      .mockResolvedValueOnce({
        ...matchingPreflight,
        node: { stacksTipHeight: 11, burnBlockHeight: 5 },
      })
      .mockResolvedValue(matchingPreflight);
    mocks.inspectDeployedManager.mockResolvedValue({ attachAllowed: false });
    mocks.readPoolSetupStatus.mockResolvedValue({ status: "blocked" });

    await expect(
      readSetupSnapshot({
        config,
        node,
        api,
        managerPrincipal,
        managerVerification: undefined,
      }),
    ).resolves.toMatchObject({ chainAnchor });
    expect(mocks.captureChainAnchor).toHaveBeenCalledTimes(4);
    expect(mocks.runOperatorPreflight).toHaveBeenCalledTimes(2);
  });

  it("fails closed after three incoherent setup snapshot attempts", async () => {
    const moved = { ...chainAnchor, indexBlockHash: `0x${"cd".repeat(32)}` };
    mocks.captureChainAnchor
      .mockResolvedValueOnce(chainAnchor)
      .mockResolvedValueOnce(moved)
      .mockResolvedValueOnce(chainAnchor)
      .mockResolvedValueOnce(moved)
      .mockResolvedValueOnce(chainAnchor)
      .mockResolvedValueOnce(moved);
    mocks.runOperatorPreflight.mockResolvedValue({
      node: { stacksTipHeight: 10, burnBlockHeight: 5 },
      cycle: { currentId: 2 },
      pox: { pox5ContractId: null },
    });
    mocks.inspectDeployedManager.mockResolvedValue({ attachAllowed: false });
    mocks.readPoolSetupStatus.mockResolvedValue({ status: "blocked" });

    await expect(
      readSetupSnapshot({
        config,
        node,
        api,
        managerPrincipal,
        managerVerification: undefined,
      }),
    ).rejects.toThrow("Chain position moved");
    expect(mocks.captureChainAnchor).toHaveBeenCalledTimes(6);
  });

  it("does not retry non-coherence failures", async () => {
    const managerFailure = new Error("manager source unavailable");
    mocks.runOperatorPreflight.mockResolvedValue({
      node: { stacksTipHeight: 10, burnBlockHeight: 5 },
      cycle: { currentId: 2 },
      pox: { pox5ContractId: null },
    });
    mocks.inspectDeployedManager.mockRejectedValue(managerFailure);

    await expect(
      readSetupSnapshot({
        config,
        node,
        api,
        managerPrincipal,
        managerVerification: undefined,
      }),
    ).rejects.toBe(managerFailure);
    expect(mocks.captureChainAnchor).toHaveBeenCalledOnce();
    expect(mocks.inspectDeployedManager).toHaveBeenCalledOnce();
  });
});
