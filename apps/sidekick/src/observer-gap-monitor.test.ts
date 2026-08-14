import { describe, expect, it, vi } from "vitest";
import { ObserverGapMonitor } from "./observer-gap-monitor.js";
import type { ObserverInboxStatus } from "./storage/store.js";

function inbox(): ObserverInboxStatus {
  return {
    schemaVersion: 1,
    uniqueDeliveries: 0,
    deliveryAttempts: 0,
    processingAttempts: 0,
    duplicates: 0,
    queueDepth: 0,
    processing: 0,
    nodeVerified: 0,
    quarantined: 0,
    expired: 0,
    retainedPayloadBytes: 0,
    prunedPayloads: 0,
    lastReceivedAt: null,
    lastProcessedAt: null,
    oldestPendingAt: null,
    lastClaimedStacksBlock: null,
    lastVerifiedStacksBlock: null,
    lastClaimedBurnBlock: null,
    lastQuarantine: null,
  };
}

describe("ObserverGapMonitor", () => {
  it("degrades only after the node advances without a callback and triggers polling fallback", async () => {
    vi.useFakeTimers();
    try {
      let now = Date.parse("2026-08-13T12:00:00.000Z");
      let height = 100;
      const status = inbox();
      const onGap = vi.fn();
      const monitor = new ObserverGapMonitor({
        getNode: () => ({
          getInfo: vi.fn(async () => ({
            network_id: 1,
            burn_block_height: 962_300,
            stacks_tip_height: height,
            stacks_tip: `0x${"11".repeat(32)}`,
          })),
        }),
        getInbox: () => status,
        onGap,
        logger: { warn: vi.fn() },
        now: () => new Date(now),
      });

      monitor.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(monitor.status()).toMatchObject({
        status: "healthy",
        reason: "awaiting-next-node-advance",
        baselineStacksHeight: 100,
      });

      now += 15_000;
      height = 101;
      status.lastReceivedAt = new Date(now).toISOString();
      status.lastClaimedStacksBlock = {
        height: 1_000_000,
        blockHash: `0x${"aa".repeat(32)}`,
        indexBlockHash: `0x${"bb".repeat(32)}`,
      };
      await vi.advanceTimersByTimeAsync(15_000);
      expect(monitor.status()).toMatchObject({
        status: "degraded",
        reason: "observer-behind-node",
        nodeStacksHeight: 101,
        observerStacksHeight: null,
      });
      expect(onGap).toHaveBeenCalledOnce();

      status.lastClaimedStacksBlock = {
        height: 101,
        blockHash: `0x${"22".repeat(32)}`,
        indexBlockHash: `0x${"33".repeat(32)}`,
      };
      status.lastVerifiedStacksBlock = {
        height: 101,
        indexBlockHash: `0x${"33".repeat(32)}`,
        receivedAt: new Date(now).toISOString(),
        verifiedAt: new Date(now).toISOString(),
      };
      now += 15_000;
      await vi.advanceTimersByTimeAsync(15_000);
      expect(monitor.status()).toMatchObject({
        status: "healthy",
        reason: "observer-current",
        stacksGap: 0,
      });
      await monitor.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows one check interval for the observer to catch up to a newer node tip", async () => {
    vi.useFakeTimers();
    try {
      let now = Date.parse("2026-08-13T12:00:00.000Z");
      let height = 100;
      const status = inbox();
      const monitor = new ObserverGapMonitor({
        getNode: () => ({
          getInfo: vi.fn(async () => ({
            network_id: 1,
            burn_block_height: 962_300,
            stacks_tip_height: height,
            stacks_tip: `0x${"11".repeat(32)}`,
          })),
        }),
        getInbox: () => status,
        logger: { warn: vi.fn() },
        now: () => new Date(now),
      });
      monitor.start();
      await vi.advanceTimersByTimeAsync(0);

      status.lastClaimedStacksBlock = {
        height: 100,
        blockHash: `0x${"22".repeat(32)}`,
        indexBlockHash: `0x${"33".repeat(32)}`,
      };
      status.lastVerifiedStacksBlock = {
        height: 100,
        indexBlockHash: `0x${"33".repeat(32)}`,
        receivedAt: new Date(now + 14_000).toISOString(),
        verifiedAt: new Date(now + 14_000).toISOString(),
      };
      now += 15_000;
      height = 101;
      await vi.advanceTimersByTimeAsync(15_000);
      expect(monitor.status()).toMatchObject({
        status: "healthy",
        reason: "observer-catch-up-window",
        stacksGap: 1,
        observerSilenceSeconds: 1,
      });
      await monitor.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports node-check failures as unknown rather than blaming the observer", async () => {
    vi.useFakeTimers();
    try {
      const warn = vi.fn();
      const monitor = new ObserverGapMonitor({
        getNode: () => ({ getInfo: vi.fn(async () => Promise.reject(new Error("node offline"))) }),
        getInbox: inbox,
        logger: { warn },
      });
      monitor.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(monitor.status()).toMatchObject({
        status: "unknown",
        reason: "node-check-failed",
        checksTotal: 1,
        failuresTotal: 1,
        consecutiveFailures: 1,
        lastError: "node offline",
      });
      expect(warn).toHaveBeenCalledOnce();
      await monitor.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
