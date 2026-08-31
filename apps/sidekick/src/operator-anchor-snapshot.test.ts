import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runOperatorPreflight: vi.fn(),
  inspectDeployedManager: vi.fn(),
  inspectManagerOrReportMissing: vi.fn(),
  verifyManagerRegistration: vi.fn(),
  readOperatorReadiness: vi.fn(),
  captureNodeChainAnchor: vi.fn(),
  nodeProvesChainAnchorCanonical: vi.fn(),
}));

vi.mock("./preflight.js", () => ({ runOperatorPreflight: mocks.runOperatorPreflight }));
vi.mock("./manager-verification.js", () => ({
  inspectDeployedManager: mocks.inspectDeployedManager,
  inspectManagerOrReportMissing: mocks.inspectManagerOrReportMissing,
}));
vi.mock("./registration-verification.js", () => ({
  verifyManagerRegistration: mocks.verifyManagerRegistration,
}));
vi.mock("./operator-readiness.js", () => ({ readOperatorReadiness: mocks.readOperatorReadiness }));
vi.mock("./chain-clients.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./chain-clients.js")>()),
  captureNodeChainAnchor: mocks.captureNodeChainAnchor,
}));
vi.mock("./node-chain-anchor-proof.js", () => ({
  nodeProvesChainAnchorCanonical: mocks.nodeProvesChainAnchorCanonical,
}));

import { ChainAnchorError } from "./chain-clients.js";
import { readOperatorAnchorSnapshot } from "./operator-anchor-snapshot.js";

const config = { network: "mainnet" } as never;
const node = {} as never;
const api = {} as never;
const managerPrincipal = "SP000000000000000000002Q6VF78.signer-manager";
const waitBeforeRetry = vi.fn(async () => {});
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

describe("operator anchor snapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.captureNodeChainAnchor.mockResolvedValue(chainAnchor);
    mocks.nodeProvesChainAnchorCanonical.mockResolvedValue(false);
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
    mocks.readOperatorReadiness.mockResolvedValue(setup);

    await expect(
      readOperatorAnchorSnapshot({
        config,
        node,
        api,
        managerPrincipal,
        managerVerification: undefined,
      }),
    ).resolves.toEqual({ chainAnchor, preflight, manager, registration, readiness: setup });
    expect(mocks.verifyManagerRegistration).toHaveBeenCalledWith(
      node,
      preflight.pox.pox5ContractId,
      managerPrincipal,
      { tip: chainAnchor.indexBlockHash },
    );
    expect(mocks.inspectDeployedManager).toHaveBeenCalledWith(
      node,
      config.network,
      managerPrincipal,
      undefined,
      { tip: chainAnchor.indexBlockHash },
    );
    expect(mocks.readOperatorReadiness).toHaveBeenCalledWith(
      node,
      preflight,
      manager,
      registration,
      {
        tip: chainAnchor.indexBlockHash,
      },
    );
  });

  it("preserves blocked readiness detail when registration cannot be read", async () => {
    const preflight = {
      node: { stacksTipHeight: 10, burnBlockHeight: 5 },
      cycle: { currentId: 2 },
      pox: { pox5ContractId: null },
    };
    const manager = { attachAllowed: false };
    const setup = { status: "blocked" };
    mocks.runOperatorPreflight.mockResolvedValue(preflight);
    mocks.inspectDeployedManager.mockResolvedValue(manager);
    mocks.readOperatorReadiness.mockResolvedValue(setup);

    await expect(
      readOperatorAnchorSnapshot({
        config,
        node,
        api,
        managerPrincipal,
        managerVerification: undefined,
      }),
    ).resolves.toEqual({ chainAnchor, preflight, manager, registration: null, readiness: setup });
    expect(mocks.verifyManagerRegistration).not.toHaveBeenCalled();
    expect(mocks.readOperatorReadiness).toHaveBeenCalledWith(node, preflight, manager, null, {
      tip: chainAnchor.indexBlockHash,
    });
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
    mocks.readOperatorReadiness.mockResolvedValue(setup);

    await readOperatorAnchorSnapshot({
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

  it("retries the whole setup snapshot when a moved anchor cannot be proven canonical", async () => {
    const moved = { ...chainAnchor, indexBlockHash: `0x${"cd".repeat(32)}` };
    mocks.captureNodeChainAnchor.mockResolvedValueOnce(chainAnchor).mockResolvedValueOnce(moved);
    mocks.runOperatorPreflight.mockResolvedValue({
      node: { stacksTipHeight: 10, burnBlockHeight: 5 },
      cycle: { currentId: 2 },
      pox: { pox5ContractId: null },
    });
    mocks.inspectDeployedManager.mockResolvedValue({ attachAllowed: false });
    mocks.readOperatorReadiness.mockResolvedValue({ status: "blocked" });

    await expect(
      readOperatorAnchorSnapshot({
        config,
        node,
        api,
        managerPrincipal,
        managerVerification: undefined,
        waitBeforeRetry,
      }),
    ).resolves.toMatchObject({ chainAnchor });
    expect(mocks.captureNodeChainAnchor).toHaveBeenCalledTimes(4);
    expect(mocks.runOperatorPreflight).toHaveBeenCalledTimes(2);
    expect(mocks.inspectDeployedManager).toHaveBeenCalledTimes(2);
    expect(mocks.readOperatorReadiness).toHaveBeenCalledTimes(2);
    expect(mocks.nodeProvesChainAnchorCanonical).toHaveBeenCalledOnce();
    expect(waitBeforeRetry).toHaveBeenCalledOnce();
  });

  it("retries the whole setup snapshot when anchor capture observes a moving tip", async () => {
    mocks.captureNodeChainAnchor
      .mockRejectedValueOnce(new ChainAnchorError("tip moved", { retryable: true }))
      .mockResolvedValue(chainAnchor);
    mocks.runOperatorPreflight.mockResolvedValue({
      node: { stacksTipHeight: 10, burnBlockHeight: 5 },
      cycle: { currentId: 2 },
      pox: { pox5ContractId: null },
    });
    mocks.inspectDeployedManager.mockResolvedValue({ attachAllowed: false });
    mocks.readOperatorReadiness.mockResolvedValue({ status: "blocked" });

    await expect(
      readOperatorAnchorSnapshot({
        config,
        node,
        api,
        managerPrincipal,
        managerVerification: undefined,
        waitBeforeRetry,
      }),
    ).resolves.toMatchObject({ chainAnchor });
    expect(mocks.captureNodeChainAnchor).toHaveBeenCalledTimes(3);
    expect(mocks.runOperatorPreflight).toHaveBeenCalledOnce();
    expect(waitBeforeRetry).toHaveBeenCalledOnce();
  });

  it("uses 250ms and 500ms backoff before exhausting three anchor attempts", async () => {
    vi.useFakeTimers();
    try {
      mocks.captureNodeChainAnchor.mockRejectedValue(
        new ChainAnchorError("tip moved", { retryable: true }),
      );
      const outcome = readOperatorAnchorSnapshot({
        config,
        node,
        api,
        managerPrincipal,
        managerVerification: undefined,
      }).then(
        () => null,
        (error: unknown) => error,
      );

      await vi.advanceTimersByTimeAsync(249);
      expect(mocks.captureNodeChainAnchor).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(mocks.captureNodeChainAnchor).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(499);
      expect(mocks.captureNodeChainAnchor).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);

      await expect(outcome).resolves.toMatchObject({ name: ChainAnchorError.name });
      expect(mocks.captureNodeChainAnchor).toHaveBeenCalledTimes(3);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps setup reads anchored when the live node learns a newer Bitcoin block", async () => {
    const advanced = {
      ...chainAnchor,
      burnBlockHeight: 6,
      cyclePosition: 4,
    };
    mocks.captureNodeChainAnchor.mockResolvedValueOnce(chainAnchor).mockResolvedValueOnce(advanced);
    mocks.nodeProvesChainAnchorCanonical.mockResolvedValue(true);
    const preflight = {
      node: { stacksTipHeight: 10, burnBlockHeight: 5 },
      cycle: { currentId: 2 },
      pox: { pox5ContractId: null },
    };
    mocks.runOperatorPreflight.mockResolvedValue({
      ...preflight,
      node: { stacksTipHeight: 10, burnBlockHeight: 6 },
    });
    mocks.inspectDeployedManager.mockResolvedValue({ attachAllowed: false });
    mocks.readOperatorReadiness.mockResolvedValue({ status: "blocked" });

    await expect(
      readOperatorAnchorSnapshot({
        config,
        node,
        api,
        managerPrincipal,
        managerVerification: undefined,
        waitBeforeRetry,
      }),
    ).resolves.toMatchObject({ chainAnchor });
    expect(mocks.captureNodeChainAnchor).toHaveBeenCalledTimes(2);
    expect(mocks.runOperatorPreflight).toHaveBeenCalledOnce();
    expect(mocks.nodeProvesChainAnchorCanonical).toHaveBeenCalledWith(node, chainAnchor, advanced);
    expect(mocks.inspectDeployedManager).toHaveBeenCalledWith(
      node,
      config.network,
      managerPrincipal,
      undefined,
      { tip: chainAnchor.indexBlockHash },
    );
  });

  it("keeps pinned setup reads when the live node advances by Nakamoto blocks", async () => {
    const advanced = {
      ...chainAnchor,
      stacksBlockHeight: 11,
      indexBlockHash: `0x${"cd".repeat(32)}` as const,
    };
    mocks.captureNodeChainAnchor.mockResolvedValueOnce(chainAnchor).mockResolvedValueOnce(advanced);
    mocks.nodeProvesChainAnchorCanonical.mockResolvedValue(true);
    const preflight = {
      node: { stacksTipHeight: 11, burnBlockHeight: 5 },
      cycle: { currentId: 2 },
      pox: { pox5ContractId: null },
    };
    mocks.runOperatorPreflight.mockResolvedValue(preflight);
    mocks.inspectDeployedManager.mockResolvedValue({ attachAllowed: false });
    mocks.readOperatorReadiness.mockResolvedValue({ status: "blocked" });

    await expect(
      readOperatorAnchorSnapshot({
        config,
        node,
        api,
        managerPrincipal,
        managerVerification: undefined,
        waitBeforeRetry,
      }),
    ).resolves.toMatchObject({ chainAnchor });
    expect(mocks.captureNodeChainAnchor).toHaveBeenCalledTimes(2);
    expect(mocks.runOperatorPreflight).toHaveBeenCalledOnce();
    expect(waitBeforeRetry).not.toHaveBeenCalled();
    expect(mocks.nodeProvesChainAnchorCanonical).toHaveBeenCalledWith(node, chainAnchor, advanced);
    expect(mocks.inspectDeployedManager).toHaveBeenCalledWith(
      node,
      config.network,
      managerPrincipal,
      undefined,
      { tip: chainAnchor.indexBlockHash },
    );
  });

  it("retries when preflight cannot prove the shared anchor is present on the node", async () => {
    const matchingPreflight = {
      node: { stacksTipHeight: 10, burnBlockHeight: 5 },
      cycle: { currentId: 2 },
      pox: { pox5ContractId: null },
    };
    mocks.runOperatorPreflight
      .mockResolvedValueOnce({
        ...matchingPreflight,
        node: { stacksTipHeight: 9, burnBlockHeight: 5 },
      })
      .mockResolvedValue(matchingPreflight);
    mocks.inspectDeployedManager.mockResolvedValue({ attachAllowed: false });
    mocks.readOperatorReadiness.mockResolvedValue({ status: "blocked" });

    await expect(
      readOperatorAnchorSnapshot({
        config,
        node,
        api,
        managerPrincipal,
        managerVerification: undefined,
        waitBeforeRetry,
      }),
    ).resolves.toMatchObject({ chainAnchor });
    expect(mocks.captureNodeChainAnchor).toHaveBeenCalledTimes(4);
    expect(mocks.runOperatorPreflight).toHaveBeenCalledTimes(2);
    expect(waitBeforeRetry).toHaveBeenCalledOnce();
  });

  it("retries when the live PoX cycle differs from the shared anchor", async () => {
    const matchingPreflight = {
      node: { stacksTipHeight: 10, burnBlockHeight: 5 },
      cycle: { currentId: 2 },
      pox: { pox5ContractId: null },
    };
    mocks.runOperatorPreflight
      .mockResolvedValueOnce({
        ...matchingPreflight,
        node: { stacksTipHeight: 10, burnBlockHeight: 6 },
        cycle: { currentId: 3 },
      })
      .mockResolvedValue(matchingPreflight);
    mocks.inspectDeployedManager.mockResolvedValue({ attachAllowed: false });
    mocks.readOperatorReadiness.mockResolvedValue({ status: "blocked" });

    await expect(
      readOperatorAnchorSnapshot({
        config,
        node,
        api,
        managerPrincipal,
        managerVerification: undefined,
        waitBeforeRetry,
      }),
    ).resolves.toMatchObject({ chainAnchor });
    expect(mocks.captureNodeChainAnchor).toHaveBeenCalledTimes(4);
    expect(mocks.runOperatorPreflight).toHaveBeenCalledTimes(2);
    expect(waitBeforeRetry).toHaveBeenCalledOnce();
  });

  it("fails closed after three incoherent setup snapshot attempts", async () => {
    const moved = { ...chainAnchor, indexBlockHash: `0x${"cd".repeat(32)}` };
    mocks.captureNodeChainAnchor
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
    mocks.readOperatorReadiness.mockResolvedValue({ status: "blocked" });

    await expect(
      readOperatorAnchorSnapshot({
        config,
        node,
        api,
        managerPrincipal,
        managerVerification: undefined,
        waitBeforeRetry,
      }),
    ).rejects.toThrow("without preserving a canonical operator snapshot anchor");
    expect(mocks.captureNodeChainAnchor).toHaveBeenCalledTimes(6);
    expect(mocks.nodeProvesChainAnchorCanonical).toHaveBeenCalledTimes(3);
    expect(waitBeforeRetry).toHaveBeenCalledTimes(2);
  });

  it("retries instead of carrying a canonical anchor across a distribution boundary", async () => {
    const nextWindow = {
      ...chainAnchor,
      stacksBlockHeight: 11,
      indexBlockHash: `0x${"cd".repeat(32)}` as const,
      burnBlockHeight: 7,
      cyclePosition: 5,
      checkpoint: "second-half" as const,
    };
    mocks.captureNodeChainAnchor
      .mockResolvedValueOnce(chainAnchor)
      .mockResolvedValueOnce(nextWindow)
      .mockResolvedValue(nextWindow);
    mocks.runOperatorPreflight.mockResolvedValue({
      node: { stacksTipHeight: 11, burnBlockHeight: 7 },
      cycle: { currentId: 2 },
      pox: { pox5ContractId: null },
    });
    mocks.inspectDeployedManager.mockResolvedValue({ attachAllowed: false });
    mocks.readOperatorReadiness.mockResolvedValue({ status: "blocked" });

    await expect(
      readOperatorAnchorSnapshot({
        config,
        node,
        api,
        managerPrincipal,
        managerVerification: undefined,
        waitBeforeRetry,
      }),
    ).resolves.toMatchObject({ chainAnchor: nextWindow });
    expect(mocks.nodeProvesChainAnchorCanonical).not.toHaveBeenCalled();
    expect(waitBeforeRetry).toHaveBeenCalledOnce();
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
      readOperatorAnchorSnapshot({
        config,
        node,
        api,
        managerPrincipal,
        managerVerification: undefined,
      }),
    ).rejects.toBe(managerFailure);
    expect(mocks.captureNodeChainAnchor).toHaveBeenCalledOnce();
    expect(mocks.inspectDeployedManager).toHaveBeenCalledOnce();
  });
});
