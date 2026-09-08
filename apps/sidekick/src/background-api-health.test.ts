import { afterEach, describe, expect, it, vi } from "vitest";
import { readBackgroundApiHealth } from "./background-api-health.js";
import type { ApiStatus, NodeInfo } from "./chain-clients.js";

afterEach(() => vi.useRealTimers());

describe("background API health", () => {
  const client = () => ({
    getNodeInfo: vi.fn().mockResolvedValue({ network_id: 1 } as NodeInfo),
    getStatus: vi.fn().mockResolvedValue({ status: "ready" } as ApiStatus),
  });

  it("coalesces concurrent observations, expires at 30 seconds, and isolates clients", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const api = client();
    const signal = new AbortController().signal;
    const first = readBackgroundApiHealth(api, signal);
    expect(readBackgroundApiHealth(api, signal)).toBe(first);
    await first;
    vi.setSystemTime(29_999);
    await readBackgroundApiHealth(api, signal);
    expect(api.getStatus).toHaveBeenCalledTimes(1);
    vi.setSystemTime(30_000);
    await readBackgroundApiHealth(api, signal);
    expect(api.getStatus).toHaveBeenCalledTimes(2);
    const other = client();
    await readBackgroundApiHealth(other, signal);
    expect(other.getStatus).toHaveBeenCalledTimes(1);
  });

  it("does not retain rejected observations or interfere with fresh client reads", async () => {
    const api = client();
    api.getStatus.mockRejectedValueOnce(new Error("API unavailable"));
    const signal = new AbortController().signal;
    await expect(readBackgroundApiHealth(api, signal)).rejects.toThrow("API unavailable");
    await readBackgroundApiHealth(api, signal);
    await api.getStatus();
    await api.getStatus();
    expect(api.getStatus).toHaveBeenCalledTimes(4);
    expect(api.getNodeInfo).toHaveBeenCalledTimes(2);
  });
});
