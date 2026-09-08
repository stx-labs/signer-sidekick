import { describe, expect, it, vi } from "vitest";
import { BurnBlockHistory } from "./burn-block-history.js";
import type { BurnBlockPage } from "./chain-clients.js";

function page(tip: number, limit: number): BurnBlockPage {
  return {
    limit,
    offset: 0,
    total: tip,
    results: Array.from({ length: limit }, (_, index) => ({
      burn_block_height: tip - index,
      burn_block_time: (tip - index) * 600,
    })),
  };
}
function fixture() {
  let now = 0;
  let tip = 1_000;
  const api = { getBurnBlocks: vi.fn(async (limit = 200) => page(tip, limit)) };
  const history = new BurnBlockHistory(api, () => now);
  return {
    api,
    history,
    setTip: (value: number) => {
      tip = value;
    },
    setTime: (value: number) => {
      now = value;
    },
  };
}

describe("display-only burn-block history", () => {
  it("keeps a 200-block window while fetching only 30 recent blocks between hourly reconciliations", async () => {
    const { history, api, setTime, setTip } = fixture();
    await history.refresh();
    expect(api.getBurnBlocks).toHaveBeenLastCalledWith(200);
    setTime(5 * 60_000);
    expect(await history.refresh()).toEqual(page(1_000, 200));
    expect(api.getBurnBlocks).toHaveBeenLastCalledWith(30);
    setTip(1_002);
    expect(await history.refresh()).toEqual(page(1_002, 200));
    setTime(60 * 60_000);
    await history.refresh();
    expect(api.getBurnBlocks).toHaveBeenLastCalledWith(200);
  });

  it.each([
    "rollback",
    "missing-overlap",
    "changed-overlap",
    "missing-entry",
  ])("fully reconciles %s", async (kind) => {
    const { history, api, setTip } = fixture();
    await history.refresh();
    if (kind === "rollback") setTip(999);
    if (kind === "missing-overlap") setTip(1_040);
    if (kind === "changed-overlap" || kind === "missing-entry") {
      const recent = page(1_000, 30);
      if (kind === "changed-overlap")
        recent.results[0] = { burn_block_height: 1_000, burn_block_time: 1 };
      else recent.results.splice(2, 1);
      api.getBurnBlocks.mockResolvedValueOnce(recent);
    }
    await history.refresh();
    expect(api.getBurnBlocks.mock.calls.map(([limit]) => limit)).toEqual([200, 30, 200]);
  });

  it("coalesces refreshes and reports failures instead of presenting cached data as freshly read", async () => {
    const { history, api } = fixture();
    const first = history.refresh();
    expect(history.refresh()).toBe(first);
    await first;
    api.getBurnBlocks.mockRejectedValueOnce(new Error("offline"));
    await expect(history.refresh()).rejects.toThrow("offline");
    expect(await history.refresh()).toEqual(page(1_000, 200));
    expect(api.getBurnBlocks).toHaveBeenCalledTimes(3);
  });
});
