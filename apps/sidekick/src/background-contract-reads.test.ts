import { falseCV, uintCV } from "@stacks/transactions";
import { describe, expect, it, vi } from "vitest";
import { BackgroundContractReads } from "./background-contract-reads.js";
import { readPoolForecast } from "./pool-forecast.js";

const tip = `0x${"ab".repeat(32)}` as const;
const otherTip = `0x${"cd".repeat(32)}` as const;
const principal = "SP000000000000000000002Q6VF78.manager";
const node = () => ({
  callReadOnly: vi.fn(async () => uintCV(1)),
  getDataVar: vi.fn(async () => uintCV(1)),
  getMapEntry: vi.fn(async () => uintCV(1)),
});

describe("background anchored contract reads", () => {
  it("deduplicates exact pending and completed reads, including method and all call arguments", async () => {
    const source = node();
    const cache = new BackgroundContractReads();
    const view = cache.at(source, tip);
    await Promise.all(Array.from({ length: 20 }, () => view.getDataVar(principal, "fee", { tip })));
    await cache.at(source, tip).getDataVar(principal, "fee", { tip });
    expect(source.getDataVar).toHaveBeenCalledOnce();
    await view.getDataVar(`${principal}-other`, "fee", { tip });
    await view.getDataVar(principal, "other", { tip });
    expect(source.getDataVar).toHaveBeenCalledTimes(3);
    await view.getMapEntry(principal, "fee", "0x01", { tip });
    await view.getMapEntry(principal, "fee", "0x02", { tip });
    await view.callReadOnly(principal, "fee", principal, ["0x01"], { tip });
    await view.callReadOnly(principal, "fee", `${principal}-sender`, ["0x01"], { tip });
    await view.callReadOnly(principal, "fee", principal, ["0x02"], { tip });
    expect(source.getMapEntry).toHaveBeenCalledTimes(2);
    expect(source.callReadOnly).toHaveBeenCalledTimes(3);
  });

  it("isolates node identity and exact tip, expires at five minutes, and handles clock rewind", async () => {
    let now = 1_000_000;
    const source = node();
    const cache = new BackgroundContractReads(() => now);
    await cache.at(source, tip).getDataVar(principal, "fee", { tip });
    now += 299_999;
    await cache.at(source, tip).getDataVar(principal, "fee", { tip });
    expect(source.getDataVar).toHaveBeenCalledOnce();
    now += 1;
    await cache.at(source, tip).getDataVar(principal, "fee", { tip });
    now -= 1;
    await cache.at(source, tip).getDataVar(principal, "fee", { tip });
    await cache.at(source, otherTip).getDataVar(principal, "fee", { tip: otherTip });
    expect(source.getDataVar).toHaveBeenCalledTimes(4);
    const changedSource = node();
    await cache.at(changedSource, otherTip).getDataVar(principal, "fee", { tip: otherTip });
    expect(changedSource.getDataVar).toHaveBeenCalledOnce();
  });

  it("does not cache latest, mismatched-tip, or failed reads; raw callers always remain fresh", async () => {
    const source = node();
    const view = new BackgroundContractReads().at(source, tip);
    for (let pass = 0; pass < 2; pass += 1) {
      await view.getDataVar(principal, "fee");
      await view.getDataVar(principal, "fee", { tip: otherTip });
    }
    expect(source.getDataVar).toHaveBeenCalledTimes(4);
    source.getDataVar.mockRejectedValueOnce(new Error("unavailable"));
    await expect(view.getDataVar(principal, "fee", { tip })).rejects.toThrow("unavailable");
    await view.getDataVar(principal, "fee", { tip });
    await view.getDataVar(principal, "fee", { tip });
    await source.getDataVar();
    expect(source.getDataVar).toHaveBeenCalledTimes(7);
  });

  it("bounds retained reads to 512 without dropping work for a large pool", async () => {
    const source = node();
    const cache = new BackgroundContractReads();
    for (let pass = 0; pass < 2; pass += 1) {
      const view = cache.at(source, tip);
      await Promise.all(
        Array.from({ length: 600 }, (_, key) =>
          view.getMapEntry(principal, "rewards", String(key), { tip }),
        ),
      );
    }
    expect(source.getMapEntry).toHaveBeenCalledTimes(600 + 88);
  });

  it("cancels queued work without leaking a slot or launching it against the node", async () => {
    const source = node();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    source.getDataVar.mockImplementation(async () => {
      await held;
      return uintCV(1);
    });
    const view = new BackgroundContractReads().at(source, tip);
    const running = Array.from({ length: 8 }, (_, key) =>
      view.getDataVar(principal, String(key), { tip }),
    );
    const controller = new AbortController();
    const queued = view.getDataVar(principal, "cancelled", { tip, signal: controller.signal });
    const rejected = expect(queued).rejects.toThrow("cancelled");
    controller.abort(new Error("cancelled"));
    release();
    await Promise.all(running);
    await rejected;
    await view.getDataVar(principal, "after", { tip });
    expect(source.getDataVar).toHaveBeenCalledTimes(9);
  });

  it("budgets a real six-cycle forecast at 288 rather than 2880 contract reads/hour for a stable roster anchor", async () => {
    let now = 1_000_000;
    const source = node();
    let active = 0;
    let peak = 0;
    const callReadOnly = vi.fn(async (_principal: string, name: string) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise(setImmediate);
      active -= 1;
      return name === "signer-set-contains-for-cycle" ? falseCV() : uintCV(1);
    });
    const realSource = { ...source, callReadOnly };
    const cache = new BackgroundContractReads(() => now);
    const store = {
      getLatestCompletedSignerStakerRun: vi.fn().mockReturnValue(null),
      listSignerStakers: vi.fn().mockReturnValue([]),
      listCycleMemberships: vi.fn().mockReturnValue([]),
    };
    for (let second = 0; second < 3600; second += 30) {
      now = 1_000_000 + second * 1000;
      const result = await readPoolForecast({
        node: cache.at(realSource, tip),
        store,
        sourceId: "api:mainnet:test",
        managerPrincipal: principal,
        pox5ContractId: principal,
        currentRewardCycle: 141,
        observedAt: new Date(now).toISOString(),
        burnBlockHeight: 960240,
        stacksTipHeight: 8600000,
        chainAnchor: {
          stacksBlockHeight: 8600000,
          indexBlockHash: tip,
          burnBlockHeight: 960240,
          rewardCycle: 141,
          rewardCycleLength: 2100,
          prepareCycleLength: 100,
          cyclePosition: 240,
          phase: "reward",
          checkpoint: "first-half",
        },
      });
      expect(result.cycles).toHaveLength(6);
    }
    expect(callReadOnly).toHaveBeenCalledTimes(288);
    expect(peak).toBe(8);
    // Local membership/coverage projections still rebuild every time.
    expect(store.getLatestCompletedSignerStakerRun).toHaveBeenCalledTimes(120);
  });
});
