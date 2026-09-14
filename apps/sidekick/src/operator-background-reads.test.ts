import { uintCV } from "@stacks/transactions";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackgroundContractReads } from "./background-contract-reads.js";
import type { StacksApiClient, StacksNodeClient } from "./chain-clients.js";
import type { SidekickConfig } from "./config.js";
import { readOperatorAnchorSnapshot } from "./operator-anchor-snapshot.js";
import { OperatorService } from "./operator-service.js";
import { readPoolForecast } from "./pool-forecast.js";
import { openSidekickStore, type SidekickStore } from "./storage/store.js";

vi.mock("./operator-anchor-snapshot.js", async (original) => ({
  ...(await original<typeof import("./operator-anchor-snapshot.js")>()),
  readOperatorAnchorSnapshot: vi.fn(),
}));
vi.mock("./pool-forecast.js", async (original) => ({
  ...(await original<typeof import("./pool-forecast.js")>()),
  readPoolForecast: vi.fn(),
}));
const stores: SidekickStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

describe("operator background contract-read boundary", () => {
  it("wraps only background projections after fresh canonical setup, never explicit or manager-claim preparation", async () => {
    const { store } = await openSidekickStore(":memory:");
    stores.push(store);
    const node = {
      getDataVar: vi.fn(async () => uintCV(1)),
      getMapEntry: vi.fn(),
      callReadOnly: vi.fn(),
    } as unknown as StacksNodeClient;
    const tip = `0x${"ab".repeat(32)}` as const;
    vi.mocked(readOperatorAnchorSnapshot).mockResolvedValue({
      chainAnchor: {
        stacksBlockHeight: 200,
        indexBlockHash: tip,
        burnBlockHeight: 1100,
        rewardCycle: 1,
        rewardCycleLength: 2100,
        prepareCycleLength: 100,
        cyclePosition: 1100,
        phase: "reward",
        checkpoint: "second-half",
      },
      preflight: {
        node: { stacksTipHeight: 200, burnBlockHeight: 1100, networkId: 1 },
        pox: { pox5ContractId: "SP000000000000000000002Q6VF78.pox-5", firstRewardCycleId: 0 },
        cycle: { currentId: 1 },
      },
      manager: {
        attachAllowed: true,
        source: {
          tier: "unrecognized",
          profileId: null,
          origin: null,
          sha256: "aa".repeat(32),
          canonicalSha256: "bb".repeat(32),
        },
        automationEligible: false,
        automationEligibilityReason: "Observe only",
      },
    } as unknown as Awaited<ReturnType<typeof readOperatorAnchorSnapshot>>);
    const service = new OperatorService({
      config: {
        network: "mainnet",
        nodeRpcUrl: "http://node.invalid",
        apiUrl: "http://api.invalid",
        apiKeyHeader: "x-api-key",
        forecastHorizonCycles: 6,
      } as SidekickConfig,
      node,
      api: {} as StacksApiClient,
      store,
      managerPrincipal: "SP000000000000000000002Q6VF78.manager",
    });
    const wrap = vi.spyOn(BackgroundContractReads.prototype, "at");
    const clear = vi.spyOn(BackgroundContractReads.prototype, "clear");
    const receivedNodes: unknown[] = [];
    // Stop at the projection boundary: no invented financial fixture is needed to test routing.
    vi.mocked(readPoolForecast).mockImplementation(async (options) => {
      receivedNodes.push(options.node);
      throw new Error("projection boundary");
    });
    await expect(service.refreshBackgroundSnapshot()).rejects.toThrow("projection boundary");
    expect(wrap).toHaveBeenCalledWith(node, tip);
    expect(receivedNodes[0]).not.toBe(node);
    expect(clear).toHaveBeenCalledOnce(); // Higher-level failures cannot poison the next refresh.
    await expect(service.refreshSnapshot()).rejects.toThrow("projection boundary");
    await expect(service.managerClaimWalletEvidence()).rejects.toThrow("projection boundary");
    expect(receivedNodes.slice(1)).toEqual([node, node]);
    expect(wrap).toHaveBeenCalledOnce();
    expect(readOperatorAnchorSnapshot).toHaveBeenCalledTimes(3);
    vi.mocked(readOperatorAnchorSnapshot).mockRejectedValueOnce(
      new Error("canonicality unavailable"),
    );
    await expect(service.refreshBackgroundSnapshot()).rejects.toThrow("canonicality unavailable");
    expect(wrap).toHaveBeenCalledOnce();
  });
});
