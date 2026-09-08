import { afterEach, describe, expect, it, vi } from "vitest";
import { readBackgroundApiHealth, readBackgroundApiStatus } from "./background-api-health.js";
import { type ApiStatus, type NodeInfo, RateLimitedError } from "./chain-clients.js";

afterEach(() => vi.useRealTimers());

describe("background API health", () => {
  it("shares one status between regular advisory and comparison reads without collecting extra info", async () => {
    const api = client();
    const status = await readBackgroundApiStatus(api);
    const controller = new AbortController();
    const health = readBackgroundApiHealth(api, controller.signal);
    controller.abort();
    expect((await health)[1]).toBe(status.value);
    expect(api.getStatus).toHaveBeenCalledTimes(1);
    expect(api.getStatus).toHaveBeenCalledWith({ retry: false });
    expect(api.getNodeInfo).toHaveBeenCalledTimes(1);
    expect((await readBackgroundApiStatus(api)).checkedAt).toBe(status.checkedAt);
  });

  it("bounds rate-limit reuse to five minutes and leaves fresh methods uncached", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const api = client();
    api.getStatus.mockRejectedValueOnce(new RateLimitedError("limited", 86_400_000));
    await expect(readBackgroundApiStatus(api)).rejects.toThrow("limited");
    vi.setSystemTime(300_999);
    await expect(readBackgroundApiStatus(api)).rejects.toThrow("limited");
    expect(api.getStatus).toHaveBeenCalledTimes(1);
    vi.setSystemTime(301_000);
    await readBackgroundApiStatus(api);
    expect(api.getStatus).toHaveBeenCalledTimes(2);
    await api.getStatus();
    expect(api.getStatus).toHaveBeenCalledTimes(3);
  });
  const client = () => ({
    getNodeInfo: vi.fn().mockResolvedValue({ network_id: 1 } as NodeInfo),
    getStatus: vi.fn().mockResolvedValue({ status: "ready" } as ApiStatus),
  });

  it("paces a node-info rate limit without extending it on repeated reads", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const api = client();
    api.getNodeInfo.mockRejectedValueOnce(new RateLimitedError("limited", 90_000));
    const signal = new AbortController().signal;
    await expect(readBackgroundApiHealth(api, signal)).rejects.toThrow("limited");
    for (const at of [30_000, 60_000, 89_999]) {
      vi.setSystemTime(at);
      await expect(readBackgroundApiHealth(api, signal)).rejects.toThrow("limited");
    }
    expect(api.getNodeInfo).toHaveBeenCalledTimes(1);
    vi.setSystemTime(90_000);
    await readBackgroundApiHealth(api, signal);
    expect(api.getNodeInfo).toHaveBeenCalledTimes(2);
  });

  it("does not restart a status cooldown when a later comparison consumes its rejection", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const api = client();
    api.getStatus.mockRejectedValueOnce(new RateLimitedError("limited", 90_000));
    await expect(readBackgroundApiStatus(api)).rejects.toThrow("limited");
    vi.setSystemTime(30_000);
    const signal = new AbortController().signal;
    await expect(readBackgroundApiHealth(api, signal)).rejects.toThrow("limited");
    expect(api.getNodeInfo).toHaveBeenCalledTimes(1);
    vi.setSystemTime(89_999);
    await expect(readBackgroundApiHealth(api, signal)).rejects.toThrow("limited");
    expect(api.getStatus).toHaveBeenCalledTimes(1);
    vi.setSystemTime(90_000);
    await readBackgroundApiHealth(api, signal);
    expect(api.getStatus).toHaveBeenCalledTimes(2);
    expect(api.getNodeInfo).toHaveBeenCalledTimes(2);
  });

  it("honors a genuinely new node-info failure independently of a retained status failure", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const api = client();
    api.getStatus.mockRejectedValueOnce(new RateLimitedError("status limited", 90_000));
    await expect(readBackgroundApiStatus(api)).rejects.toThrow("status limited");
    vi.setSystemTime(30_000);
    api.getNodeInfo.mockRejectedValueOnce(new RateLimitedError("info limited", 120_000));
    await expect(readBackgroundApiHealth(api, new AbortController().signal)).rejects.toThrow();
    vi.setSystemTime(149_999);
    await expect(readBackgroundApiStatus(api)).rejects.toThrow("status limited");
    expect(api.getStatus).toHaveBeenCalledTimes(1);
    vi.setSystemTime(150_000);
    await readBackgroundApiStatus(api);
    expect(api.getStatus).toHaveBeenCalledTimes(2);
  });

  it("does not shorten an outstanding source cooldown when the other source fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const api = client();
    api.getStatus.mockRejectedValueOnce(new RateLimitedError("status limited", 120_000));
    await expect(readBackgroundApiStatus(api)).rejects.toThrow();
    vi.setSystemTime(30_000);
    api.getNodeInfo.mockRejectedValueOnce(new RateLimitedError("info limited", 30_000));
    await expect(readBackgroundApiHealth(api, new AbortController().signal)).rejects.toThrow();
    vi.setSystemTime(119_999);
    await expect(readBackgroundApiStatus(api)).rejects.toThrow();
    expect(api.getStatus).toHaveBeenCalledTimes(1);
    vi.setSystemTime(120_000);
    await readBackgroundApiStatus(api);
    expect(api.getStatus).toHaveBeenCalledTimes(2);
  });

  it.each([
    "status",
    "node-info",
  ] as const)("preserves the %s 429 when the other source fails normally", async (source) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const api = client();
    const rateLimit = new RateLimitedError("limited", 90_000);
    if (source === "status") {
      api.getStatus.mockRejectedValueOnce(rateLimit);
      await expect(readBackgroundApiStatus(api)).rejects.toThrow("limited");
      vi.setSystemTime(30_000);
      api.getNodeInfo.mockRejectedValueOnce(new Error("info offline"));
    } else {
      api.getStatus.mockRejectedValueOnce(new Error("status offline"));
      api.getNodeInfo.mockRejectedValueOnce(rateLimit);
    }
    await expect(readBackgroundApiHealth(api, new AbortController().signal)).rejects.toThrow();
    vi.setSystemTime(89_999);
    await expect(readBackgroundApiStatus(api)).rejects.toThrow();
    expect(api.getStatus).toHaveBeenCalledTimes(1);
    vi.setSystemTime(90_000);
    await readBackgroundApiStatus(api);
    expect(api.getStatus).toHaveBeenCalledTimes(2);
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
