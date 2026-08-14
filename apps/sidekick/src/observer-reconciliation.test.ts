import { describe, expect, it, vi } from "vitest";
import { ObserverReconciliationScheduler } from "./observer-reconciliation.js";
import type { StoredObserverDelivery } from "./storage/store.js";

const managerPrincipal = "SP000000000000000000002Q6VF78.signer-manager";

function stacksDelivery(height: number, managerEvent = true): StoredObserverDelivery {
  return {
    deliveryId: "11111111-1111-4111-8111-111111111111",
    endpointKind: "new-block",
    rawPayloadJson: JSON.stringify({
      events: managerEvent
        ? [
            {
              txid: `0x${"33".repeat(32)}`,
              event_index: 0,
              committed: true,
              type: "contract_event",
              contract_event: {
                contract_identifier: managerPrincipal,
                topic: "print",
                raw_value: "0x01",
              },
            },
          ]
        : [],
    }),
    claimedBlockHeight: height,
    claimedBlockHash: `0x${"11".repeat(32)}`,
    claimedIndexBlockHash: `0x${"22".repeat(32)}`,
    claimedBurnBlockHeight: null,
    claimedBurnBlockHash: null,
    processingAttempts: 1,
    firstReceivedAt: "2026-08-13T12:00:00.000Z",
    lastReceivedAt: "2026-08-13T12:00:00.000Z",
    lastProcessingAt: "2026-08-13T12:00:00.000Z",
  };
}

describe("ObserverReconciliationScheduler", () => {
  it("runs restart catch-up for current state and manager activity", async () => {
    vi.useFakeTimers();
    try {
      const service = {
        refreshSnapshot: vi.fn().mockResolvedValue(undefined),
        synchronizeManagerActivity: vi.fn().mockResolvedValue(undefined),
      };
      const scheduler = new ObserverReconciliationScheduler({
        service,
        logger: { info: vi.fn(), warn: vi.fn() },
        managerPrincipal,
      });

      scheduler.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(service.refreshSnapshot).toHaveBeenCalledOnce();
      expect(service.synchronizeManagerActivity).toHaveBeenCalledOnce();
      expect(scheduler.status()).toMatchObject({
        started: true,
        domains: {
          current: { pending: false, running: false, successes: 1 },
          "manager-activity": { pending: false, running: false, successes: 1 },
        },
      });
      await scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps current refresh independent and coalesces activity while it is running", async () => {
    vi.useFakeTimers();
    try {
      let releaseActivity: (() => void) | undefined;
      const firstActivity = new Promise<void>((resolve) => {
        releaseActivity = resolve;
      });
      const service = {
        refreshSnapshot: vi.fn().mockResolvedValue(undefined),
        synchronizeManagerActivity: vi
          .fn()
          .mockReturnValueOnce(firstActivity)
          .mockResolvedValue(undefined),
      };
      const scheduler = new ObserverReconciliationScheduler({
        service,
        logger: { info: vi.fn(), warn: vi.fn() },
        managerPrincipal,
      });
      scheduler.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(service.synchronizeManagerActivity).toHaveBeenCalledOnce();

      for (const height of [8_700_001, 8_700_002, 8_700_003]) {
        scheduler.notifyProcessed(stacksDelivery(height), {
          action: "finish",
          state: "node-verified",
          reason: "canonical-stacks-header-verified;embedded-events-remain-untrusted",
        });
      }
      await vi.advanceTimersByTimeAsync(0);

      expect(service.refreshSnapshot).toHaveBeenCalledTimes(2);
      expect(service.synchronizeManagerActivity).toHaveBeenCalledOnce();
      expect(scheduler.status().domains["manager-activity"]).toMatchObject({
        pending: true,
        running: true,
        requests: 4,
        coalescedRequests: 3,
        requestedStacksHeight: 8_700_003,
      });

      releaseActivity?.();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(service.synchronizeManagerActivity).toHaveBeenCalledTimes(2);
      expect(service.synchronizeManagerActivity).toHaveBeenLastCalledWith(
        expect.objectContaining({ minimumStacksHeight: 8_700_003 }),
      );
      await scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not scan manager history for routine blocks with no matching print", async () => {
    vi.useFakeTimers();
    try {
      const service = {
        refreshSnapshot: vi.fn().mockResolvedValue(undefined),
        synchronizeManagerActivity: vi.fn().mockResolvedValue(undefined),
      };
      const scheduler = new ObserverReconciliationScheduler({
        service,
        logger: { info: vi.fn(), warn: vi.fn() },
        managerPrincipal,
      });
      scheduler.start();
      await vi.advanceTimersByTimeAsync(0);

      scheduler.notifyProcessed(stacksDelivery(8_700_001, false), {
        action: "finish",
        state: "node-verified",
        reason: "canonical-stacks-header-verified;embedded-events-remain-untrusted",
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(service.refreshSnapshot).toHaveBeenCalledTimes(2);
      expect(service.synchronizeManagerActivity).toHaveBeenCalledOnce();
      await scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains failed work with bounded backoff", async () => {
    vi.useFakeTimers();
    try {
      const warn = vi.fn();
      const service = {
        refreshSnapshot: vi
          .fn()
          .mockRejectedValueOnce(new Error("node unavailable"))
          .mockResolvedValue(undefined),
        synchronizeManagerActivity: vi.fn().mockResolvedValue(undefined),
      };
      const scheduler = new ObserverReconciliationScheduler({
        service,
        logger: { info: vi.fn(), warn },
        managerPrincipal,
        failureDelayMs: 100,
        maxBackoffMs: 1_000,
      });

      scheduler.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(scheduler.status().domains.current).toMatchObject({
        pending: true,
        failuresTotal: 1,
        consecutiveFailures: 1,
      });
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ domain: "current", retryInMs: 100 }),
        expect.any(String),
      );

      await vi.advanceTimersByTimeAsync(100);
      expect(service.refreshSnapshot).toHaveBeenCalledTimes(2);
      expect(scheduler.status().domains.current).toMatchObject({
        pending: false,
        failuresTotal: 1,
        consecutiveFailures: 0,
        successes: 1,
      });
      await scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
