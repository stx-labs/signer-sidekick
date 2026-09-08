import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startConnectionRefreshLoop } from "./connection-refresh.js";
import { startSnapshotRefreshLoop } from "./operator-snapshot-refresh.js";

describe("background connection recovery", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const logger = () => ({ info: vi.fn(), warn: vi.fn() });

  it("recovers from a returned deadline assessment without a browser and keeps reassessing", async () => {
    const check = vi
      .fn()
      .mockResolvedValueOnce({ status: "unavailable", outcomeCode: "assessment-timeout" })
      .mockResolvedValue({ status: "connected" });
    const start = vi.fn().mockResolvedValue(undefined);
    const log = logger();
    const loop = startConnectionRefreshLoop({ check }, start, log);
    await vi.advanceTimersByTimeAsync(0);
    expect(start).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ retryInMs: 30_000 }),
      expect.any(String),
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(start).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(check).toHaveBeenCalledTimes(3);
    // Runtime's existing start-once guard owns worker startup; no second lifecycle here.
    expect(start).toHaveBeenCalledTimes(2);
    await loop.stop();
  });

  it("does not start workers for a hard refusal but observes a later repair", async () => {
    const check = vi
      .fn()
      .mockResolvedValueOnce({ status: "blocked" })
      .mockResolvedValue({ status: "connected" });
    const start = vi.fn().mockResolvedValue(undefined);
    const loop = startConnectionRefreshLoop({ check }, start, logger());
    await vi.advanceTimersByTimeAsync(0);
    expect(start).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(start).toHaveBeenCalledTimes(1);
    await loop.stop();
  });

  it("awaits asynchronous startup, retries rejection, and never overlaps", async () => {
    const check = vi.fn().mockResolvedValue({ status: "connected" });
    let reject!: (error: Error) => void;
    const start = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((_, fail) => {
            reject = fail;
          }),
      )
      .mockResolvedValue(undefined);
    const log = logger();
    const loop = startConnectionRefreshLoop({ check }, start, log);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(check).toHaveBeenCalledTimes(1);
    reject(new Error("startup unavailable"));
    await vi.advanceTimersByTimeAsync(0);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ retryInMs: 30_000 }),
      expect.any(String),
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(start).toHaveBeenCalledTimes(2);
    await loop.stop();
  });

  it("caps consecutive transport failures at five minutes and resets after recovery", async () => {
    const check = vi.fn().mockRejectedValue(new Error("offline"));
    const log = logger();
    const loop = startConnectionRefreshLoop({ check }, vi.fn(), log);
    await vi.advanceTimersByTimeAsync(0);
    for (const delay of [30_000, 60_000, 120_000, 240_000, 300_000])
      await vi.advanceTimersByTimeAsync(delay);
    expect(log.warn.mock.calls.map(([value]) => value.retryInMs)).toEqual([
      30_000, 60_000, 120_000, 240_000, 300_000, 300_000,
    ]);
    check.mockResolvedValue({ status: "connected" });
    await vi.advanceTimersByTimeAsync(300_000);
    const count = check.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(check).toHaveBeenCalledTimes(count + 1);
    await loop.stop();
  });

  it("drains an in-flight assessment on shutdown without starting workers afterward", async () => {
    let resolve!: (value: { status: string }) => void;
    const check = vi.fn().mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const start = vi.fn();
    const loop = startConnectionRefreshLoop({ check }, start, logger());
    await vi.advanceTimersByTimeAsync(0);
    const stopped = vi.fn();
    const stop = loop.stop().then(stopped);
    expect(stopped).not.toHaveBeenCalled();
    resolve({ status: "connected" });
    await stop;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(start).not.toHaveBeenCalled();
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("recovers existing snapshot work inside the combined ten-minute timer bound without browser requests", async () => {
    let upstreamAvailable = true;
    let connected = false;
    let started = false;
    let workerStarts = 0;
    const check = vi.fn().mockImplementation(async () => {
      connected = upstreamAvailable;
      return { status: connected ? "connected" : "unavailable" };
    });
    const connectionLoop = startConnectionRefreshLoop(
      { check },
      async () => {
        if (started) return;
        started = true;
        workerStarts += 1;
      },
      logger(),
    );
    const successfulSnapshot = vi.fn();
    const snapshotLoop = startSnapshotRefreshLoop(
      {
        refreshSnapshot: async () => {
          if (!connected) throw new Error("cached connection unavailable");
          successfulSnapshot();
        },
      },
      logger(),
      { initialDelayMs: 1 },
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(workerStarts).toBe(1);
    upstreamAvailable = false;
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    const lastCount = successfulSnapshot.mock.calls.length;
    upstreamAvailable = true;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(successfulSnapshot.mock.calls.length).toBeGreaterThan(lastCount);
    expect(workerStarts).toBe(1);
    snapshotLoop.stop();
    await connectionLoop.stop();
  });
});
