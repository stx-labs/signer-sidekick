import { contractPrincipalCV, cvToHex, stringAsciiCV, tupleCV } from "@stacks/transactions";
import { describe, expect, it, vi } from "vitest";
import { ObserverReconciliationScheduler } from "./observer-reconciliation.js";
import type { StoredObserverDelivery } from "./storage/store.js";

const managerPrincipal = "SP000000000000000000002Q6VF78.signer-manager";
const pox5ContractId = "SP000000000000000000002Q6VF78.pox-5";
const otherManagerPrincipal = "SP2369QN53586176SYRF4XFGF4E84V0J0EWKRG0ZH.signer-manager";

function poxPrintValue(manager = managerPrincipal): string {
  const [address, name] = manager.split(".") as [string, string];
  return cvToHex(
    tupleCV({
      topic: stringAsciiCV("stake"),
      signer: contractPrincipalCV(address, name),
    }),
  );
}

function stacksDelivery(
  height: number,
  eventKind: "manager" | "pox" | "pox-other" | "none" = "manager",
): StoredObserverDelivery {
  return {
    deliveryId: "11111111-1111-4111-8111-111111111111",
    endpointKind: "new-block",
    rawPayloadJson: JSON.stringify({
      events:
        eventKind !== "none"
          ? [
              {
                txid: `0x${"33".repeat(32)}`,
                event_index: 0,
                committed: true,
                type: "contract_event",
                contract_event: {
                  contract_identifier: eventKind === "manager" ? managerPrincipal : pox5ContractId,
                  topic: "print",
                  raw_value:
                    eventKind === "pox"
                      ? poxPrintValue()
                      : eventKind === "pox-other"
                        ? poxPrintValue(otherManagerPrincipal)
                        : "0x01",
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

function burnDelivery(height: number): StoredObserverDelivery {
  return {
    ...stacksDelivery(height, "none"),
    endpointKind: "new-burn-block",
    claimedBlockHeight: null,
    claimedBlockHash: null,
    claimedIndexBlockHash: null,
    claimedBurnBlockHeight: height,
    claimedBurnBlockHash: `0x${"44".repeat(32)}`,
  };
}

describe("ObserverReconciliationScheduler", () => {
  it("runs restart catch-up for current state and manager activity", async () => {
    vi.useFakeTimers();
    try {
      const service = {
        refreshSnapshot: vi.fn().mockResolvedValue(undefined),
        synchronizeManagerActivity: vi.fn().mockResolvedValue(undefined),
        synchronize: vi.fn().mockResolvedValue(undefined),
      };
      const scheduler = new ObserverReconciliationScheduler({
        service,
        logger: { info: vi.fn(), warn: vi.fn() },
        managerPrincipal,
        getPox5ContractId: () => pox5ContractId,
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

  it("backfills manager activity every five minutes when callback hints are absent", async () => {
    vi.useFakeTimers();
    try {
      const service = {
        refreshSnapshot: vi.fn().mockResolvedValue(undefined),
        synchronizeManagerActivity: vi.fn().mockResolvedValue(undefined),
        synchronize: vi.fn().mockResolvedValue(undefined),
      };
      const scheduler = new ObserverReconciliationScheduler({
        service,
        logger: { info: vi.fn(), warn: vi.fn() },
        managerPrincipal,
        getPox5ContractId: () => pox5ContractId,
        managerActivityBackfillIntervalMs: 300_000,
      });
      scheduler.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(service.synchronizeManagerActivity).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(300_000);
      await vi.advanceTimersByTimeAsync(1);
      expect(scheduler.status().domains["manager-activity"].requests).toBe(2);
      expect(service.synchronizeManagerActivity).toHaveBeenCalledTimes(2);
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
        synchronize: vi.fn().mockResolvedValue(undefined),
      };
      const scheduler = new ObserverReconciliationScheduler({
        service,
        logger: { info: vi.fn(), warn: vi.fn() },
        managerPrincipal,
        getPox5ContractId: () => pox5ContractId,
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
        synchronize: vi.fn().mockResolvedValue(undefined),
      };
      const scheduler = new ObserverReconciliationScheduler({
        service,
        logger: { info: vi.fn(), warn: vi.fn() },
        managerPrincipal,
        getPox5ContractId: () => pox5ContractId,
      });
      scheduler.start();
      await vi.advanceTimersByTimeAsync(0);

      scheduler.notifyProcessed(stacksDelivery(8_700_001, "none"), {
        action: "finish",
        state: "node-verified",
        reason: "canonical-stacks-header-verified;embedded-events-remain-untrusted",
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(service.refreshSnapshot).toHaveBeenCalledTimes(2);
      expect(service.synchronizeManagerActivity).toHaveBeenCalledOnce();
      expect(service.synchronize).not.toHaveBeenCalled();
      await scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("requests an anchored full roster reconciliation for a PoX-5 print", async () => {
    vi.useFakeTimers();
    try {
      const service = {
        refreshSnapshot: vi.fn().mockResolvedValue(undefined),
        synchronizeManagerActivity: vi.fn().mockResolvedValue(undefined),
        synchronize: vi.fn().mockResolvedValue(undefined),
      };
      const scheduler = new ObserverReconciliationScheduler({
        service,
        logger: { info: vi.fn(), warn: vi.fn() },
        managerPrincipal,
        getPox5ContractId: () => pox5ContractId,
      });
      scheduler.start();
      await vi.advanceTimersByTimeAsync(0);

      scheduler.notifyProcessed(stacksDelivery(8_700_010, "pox"), {
        action: "finish",
        state: "node-verified",
        reason: "canonical-stacks-header-verified;embedded-events-remain-untrusted",
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(service.synchronize).toHaveBeenCalledOnce();
      expect(service.synchronize).toHaveBeenCalledWith(
        expect.objectContaining({ minimumStacksHeight: 8_700_010 }),
      );
      expect(service.synchronizeManagerActivity).toHaveBeenCalledOnce();
      expect(scheduler.status().domains.roster).toMatchObject({
        requests: 1,
        successes: 1,
        requestedStacksHeight: 8_700_010,
      });
      await scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not full-sync the roster for another manager's PoX-5 print", async () => {
    vi.useFakeTimers();
    try {
      const service = {
        refreshSnapshot: vi.fn().mockResolvedValue(undefined),
        synchronizeManagerActivity: vi.fn().mockResolvedValue(undefined),
        synchronize: vi.fn().mockResolvedValue(undefined),
      };
      const scheduler = new ObserverReconciliationScheduler({
        service,
        logger: { info: vi.fn(), warn: vi.fn() },
        managerPrincipal,
        getPox5ContractId: () => pox5ContractId,
      });
      scheduler.start();
      await vi.advanceTimersByTimeAsync(0);

      scheduler.notifyProcessed(stacksDelivery(8_700_011, "pox-other"), {
        action: "finish",
        state: "node-verified",
        reason: "canonical-stacks-index-block-verified",
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(service.refreshSnapshot).toHaveBeenCalledTimes(2);
      expect(service.synchronize).not.toHaveBeenCalled();
      expect(scheduler.status().domains.roster.requests).toBe(0);
      await scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores non-verified block outcomes and consumes the burn trigger branch", async () => {
    vi.useFakeTimers();
    try {
      const service = {
        refreshSnapshot: vi.fn().mockResolvedValue(undefined),
        synchronizeManagerActivity: vi.fn().mockResolvedValue(undefined),
        synchronize: vi.fn().mockResolvedValue(undefined),
      };
      const scheduler = new ObserverReconciliationScheduler({
        service,
        logger: { info: vi.fn(), warn: vi.fn() },
        managerPrincipal,
        getPox5ContractId: () => pox5ContractId,
      });
      scheduler.start();
      await vi.advanceTimersByTimeAsync(0);
      const initialRequests = scheduler.status().domains.current.requests;

      scheduler.notifyProcessed(stacksDelivery(8_700_012), {
        action: "finish",
        state: "quarantined",
        reason: "forged",
      });
      expect(scheduler.status().domains.current.requests).toBe(initialRequests);

      scheduler.notifyProcessed(burnDelivery(962_300), {
        action: "finish",
        state: "expired",
        reason: "trigger-consumed;burn-block-hash-not-locally-verifiable",
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(scheduler.status().domains.current).toMatchObject({
        requests: initialRequests + 1,
        requestedBurnHeight: 962_300,
      });
      await scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains work without reading chain sources while the connection is blocked", async () => {
    vi.useFakeTimers();
    try {
      let connected = false;
      const service = {
        refreshSnapshot: vi.fn().mockResolvedValue(undefined),
        synchronizeManagerActivity: vi.fn().mockResolvedValue(undefined),
        synchronize: vi.fn().mockResolvedValue(undefined),
      };
      const scheduler = new ObserverReconciliationScheduler({
        service,
        logger: { info: vi.fn(), warn: vi.fn() },
        managerPrincipal,
        getPox5ContractId: () => pox5ContractId,
        canRun: () => connected,
        failureDelayMs: 100,
      });
      scheduler.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(service.refreshSnapshot).not.toHaveBeenCalled();
      expect(service.synchronizeManagerActivity).not.toHaveBeenCalled();
      expect(scheduler.status().domains.current).toMatchObject({
        pending: true,
        failuresTotal: 0,
      });

      connected = true;
      await vi.advanceTimersByTimeAsync(100);
      expect(service.refreshSnapshot).toHaveBeenCalledOnce();
      expect(service.synchronizeManagerActivity).toHaveBeenCalledOnce();
      await scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts and waits for active domain work during shutdown", async () => {
    vi.useFakeTimers();
    try {
      const aborted = vi.fn();
      const service = {
        refreshSnapshot: vi.fn().mockResolvedValue(undefined),
        synchronizeManagerActivity: vi.fn(
          async ({ signal }: { signal?: AbortSignal } = {}) =>
            await new Promise<void>((resolve) => {
              signal?.addEventListener(
                "abort",
                () => {
                  aborted();
                  resolve();
                },
                { once: true },
              );
            }),
        ),
        synchronize: vi.fn().mockResolvedValue(undefined),
      };
      const scheduler = new ObserverReconciliationScheduler({
        service,
        logger: { info: vi.fn(), warn: vi.fn() },
        managerPrincipal,
        getPox5ContractId: () => pox5ContractId,
      });
      scheduler.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(scheduler.status().domains["manager-activity"].running).toBe(true);

      await scheduler.stop();
      expect(aborted).toHaveBeenCalledOnce();
      expect(scheduler.status().domains["manager-activity"]).toMatchObject({
        pending: false,
        running: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("measures callback-to-projection latency in cumulative histogram buckets", async () => {
    vi.useFakeTimers();
    try {
      let now = Date.parse("2026-08-13T12:00:01.000Z");
      const service = {
        refreshSnapshot: vi.fn().mockResolvedValue(undefined),
        synchronizeManagerActivity: vi.fn().mockResolvedValue(undefined),
        synchronize: vi.fn().mockResolvedValue(undefined),
      };
      const scheduler = new ObserverReconciliationScheduler({
        service,
        logger: { info: vi.fn(), warn: vi.fn() },
        managerPrincipal,
        getPox5ContractId: () => pox5ContractId,
        now: () => new Date(now),
      });
      scheduler.start();
      await vi.advanceTimersByTimeAsync(0);

      scheduler.notifyProcessed(stacksDelivery(8_700_020), {
        action: "finish",
        state: "node-verified",
        reason: "canonical-stacks-header-verified;embedded-events-remain-untrusted",
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(scheduler.status().domains.current.callbackLatency).toEqual({
        samples: 1,
        sumSeconds: 1,
        maxSeconds: 1,
        lastSeconds: 1,
        withinTwoSeconds: 1,
        buckets: { le1: 1, le2: 1, le5: 1, le10: 1, le30: 1 },
      });
      expect(scheduler.status().domains["manager-activity"].callbackLatency).toMatchObject({
        samples: 1,
        withinTwoSeconds: 1,
      });

      now += 1_000;
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
        synchronize: vi.fn().mockResolvedValue(undefined),
      };
      const scheduler = new ObserverReconciliationScheduler({
        service,
        logger: { info: vi.fn(), warn },
        managerPrincipal,
        getPox5ContractId: () => pox5ContractId,
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
