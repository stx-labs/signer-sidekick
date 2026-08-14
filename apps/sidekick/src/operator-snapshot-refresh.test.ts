import { describe, expect, it, vi } from "vitest";
import { RateLimitedError } from "./chain-clients.js";
import {
  DEFAULT_SNAPSHOT_REFRESH_INTERVAL_MS,
  SnapshotRefreshMetricsTracker,
  startSnapshotRefreshLoop,
} from "./operator-snapshot-refresh.js";

describe("startSnapshotRefreshLoop", () => {
  it("uses the 30-second current-state anti-entropy cadence", () => {
    expect(DEFAULT_SNAPSHOT_REFRESH_INTERVAL_MS).toBe(30_000);
  });

  it("records refresh health, snapshot age, and source positions without another chain read", () => {
    let now = Date.parse("2026-08-12T14:00:10.000Z");
    const metrics = new SnapshotRefreshMetricsTracker(() => now, 60_000);
    metrics.recordAttempt();
    metrics.recordSuccess({
      generatedAt: "2026-08-12T14:00:00.000Z",
      preflight: {
        node: { stacksTipHeight: 8_700_005, burnBlockHeight: 962_150 },
        api: { stacksTipHeight: 8_700_000, burnBlockHeight: 962_150 },
        pox: { burnBlockHeight: 962_149, rewardCycleId: 141 },
      },
    });

    expect(metrics.snapshot()).toMatchObject({
      attemptsTotal: 1,
      successesTotal: 1,
      failuresTotal: 0,
      consecutiveFailures: 0,
      retryBackoffSeconds: 0,
      snapshotAgeSeconds: 10,
      snapshotFresh: 1,
      sourcePositions: {
        nodeStacksHeight: 8_700_005,
        apiStacksHeight: 8_700_000,
        nodeBurnHeight: 962_150,
        apiBurnHeight: 962_150,
        poxBurnHeight: 962_149,
        poxRewardCycle: 141,
      },
    });

    now += 30_000;
    metrics.recordAttempt();
    metrics.recordFailure(15_000);
    expect(metrics.snapshot()).toMatchObject({
      attemptsTotal: 2,
      successesTotal: 1,
      failuresTotal: 1,
      consecutiveFailures: 1,
      retryBackoffSeconds: 15,
      snapshotAgeSeconds: 40,
      snapshotFresh: 0,
    });
  });

  it("warms the snapshot at startup and then on the configured cadence", async () => {
    vi.useFakeTimers();
    try {
      const refreshSnapshot = vi.fn().mockResolvedValue(undefined);
      const info = vi.fn();
      const loop = startSnapshotRefreshLoop(
        { refreshSnapshot },
        { info, warn: vi.fn() },
        {
          intervalMs: 100,
        },
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(refreshSnapshot).toHaveBeenCalledTimes(1);
      expect(info).toHaveBeenCalledWith(
        { intervalMs: 100, initialDelayMs: 0 },
        "Background operator snapshot refresh is enabled",
      );

      await vi.advanceTimersByTimeAsync(100);
      expect(refreshSnapshot).toHaveBeenCalledTimes(2);
      loop.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("backs off exponentially after ordinary failures and resets after success", async () => {
    vi.useFakeTimers();
    try {
      const refreshSnapshot = vi
        .fn()
        .mockRejectedValueOnce(new Error("node unavailable"))
        .mockRejectedValueOnce(new Error("node unavailable"))
        .mockResolvedValue(undefined);
      const warn = vi.fn();
      const loop = startSnapshotRefreshLoop(
        { refreshSnapshot },
        { info: vi.fn(), warn },
        {
          intervalMs: 100,
          failureDelayMs: 10,
          maxBackoffMs: 80,
        },
      );

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(20);
      expect(refreshSnapshot).toHaveBeenCalledTimes(3);
      expect(warn).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ failures: 1, retryInMs: 10 }),
        expect.any(String),
      );
      expect(warn).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ failures: 2, retryInMs: 20 }),
        expect.any(String),
      );

      await vi.advanceTimersByTimeAsync(100);
      expect(refreshSnapshot).toHaveBeenCalledTimes(4);
      loop.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("honors an upstream retry-after before retrying", async () => {
    vi.useFakeTimers();
    try {
      const refreshSnapshot = vi
        .fn()
        .mockRejectedValueOnce(new RateLimitedError("rate limited", 2_000, "https://api.example"))
        .mockResolvedValue(undefined);
      const loop = startSnapshotRefreshLoop(
        { refreshSnapshot },
        { info: vi.fn(), warn: vi.fn() },
        {
          intervalMs: 100,
          failureDelayMs: 10,
          maxBackoffMs: 3_000,
        },
      );

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(refreshSnapshot).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(refreshSnapshot).toHaveBeenCalledTimes(2);
      loop.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops future scheduled refreshes", async () => {
    vi.useFakeTimers();
    try {
      const refreshSnapshot = vi.fn().mockResolvedValue(undefined);
      const loop = startSnapshotRefreshLoop(
        { refreshSnapshot },
        { info: vi.fn(), warn: vi.fn() },
        {
          intervalMs: 100,
        },
      );

      await vi.advanceTimersByTimeAsync(0);
      loop.stop();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(refreshSnapshot).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reschedule after stopping an in-flight refresh", async () => {
    vi.useFakeTimers();
    try {
      let resolveRefresh: (() => void) | undefined;
      const refreshSnapshot = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveRefresh = resolve;
          }),
      );
      const loop = startSnapshotRefreshLoop(
        { refreshSnapshot },
        { info: vi.fn(), warn: vi.fn() },
        { intervalMs: 100 },
      );

      vi.advanceTimersByTime(0);
      expect(refreshSnapshot).toHaveBeenCalledTimes(1);
      loop.stop();
      resolveRefresh?.();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(refreshSnapshot).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
