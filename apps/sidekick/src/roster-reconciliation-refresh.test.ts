import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ROSTER_RECONCILIATION_INITIAL_DELAY_MS,
  DEFAULT_ROSTER_RECONCILIATION_INTERVAL_MS,
  RosterReconciliationMetricsTracker,
  RosterReconciliationRetryError,
  startRosterReconciliationLoop,
} from "./roster-reconciliation-refresh.js";

const logger = () => ({ info: vi.fn(), warn: vi.fn() });

describe("automatic roster reconciliation", () => {
  it("defaults to a 30-minute interval and never overlaps runs", async () => {
    expect(DEFAULT_ROSTER_RECONCILIATION_INTERVAL_MS).toBe(30 * 60_000);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reconcileRoster = vi.fn(async () => {
      await gate;
      return "synchronized" as const;
    });
    const timers: Array<() => void> = [];
    const setTimeout = vi.fn((callback: () => void) => {
      timers.push(callback);
      return 1 as unknown as ReturnType<typeof globalThis.setTimeout>;
    });
    const loop = startRosterReconciliationLoop({ reconcileRoster }, logger(), {
      setTimeout: setTimeout as typeof globalThis.setTimeout,
      clearTimeout: vi.fn(),
    });

    expect(DEFAULT_ROSTER_RECONCILIATION_INITIAL_DELAY_MS).toBe(30_000);
    expect(setTimeout).toHaveBeenLastCalledWith(expect.any(Function), 30_000);
    timers.shift()?.();
    expect(reconcileRoster).toHaveBeenCalledOnce();
    expect(timers).toHaveLength(0);
    release?.();
    await vi.waitFor(() => expect(timers).toHaveLength(1));
    expect(setTimeout).toHaveBeenLastCalledWith(expect.any(Function), 30 * 60_000);
    loop.stop();
  });

  it("honors classified retry delays and records recovery metrics", async () => {
    let now = 1_000_000;
    const metrics = new RosterReconciliationMetricsTracker(() => now);
    const reconcileRoster = vi
      .fn<() => Promise<"synchronized">>()
      .mockRejectedValueOnce(new RosterReconciliationRetryError("rate limited", 90_000))
      .mockResolvedValue("synchronized");
    const timers: Array<() => void> = [];
    const delays: number[] = [];
    const setTimeout = vi.fn((callback: () => void, delay?: number) => {
      timers.push(callback);
      delays.push(delay ?? 0);
      return 1 as unknown as ReturnType<typeof globalThis.setTimeout>;
    });
    const loop = startRosterReconciliationLoop({ reconcileRoster }, logger(), {
      initialDelayMs: 1,
      setTimeout: setTimeout as typeof globalThis.setTimeout,
      clearTimeout: vi.fn(),
      metrics,
    });

    timers.shift()?.();
    await vi.waitFor(() => expect(delays.at(-1)).toBe(90_000));
    expect(metrics.snapshot()).toMatchObject({
      attemptsTotal: 1,
      failuresTotal: 1,
      consecutiveFailures: 1,
      retryBackoffSeconds: 90,
    });

    now += 90_000;
    timers.shift()?.();
    await vi.waitFor(() => expect(delays.at(-1)).toBe(30 * 60_000));
    expect(metrics.snapshot()).toMatchObject({
      attemptsTotal: 2,
      successesTotal: 1,
      failuresTotal: 1,
      consecutiveFailures: 0,
      lastSuccessTimestampSeconds: now / 1_000,
    });
    loop.stop();
  });

  it("records setup and overlap skips without treating them as failures", async () => {
    const metrics = new RosterReconciliationMetricsTracker();
    const timers: Array<() => void> = [];
    const loop = startRosterReconciliationLoop(
      { reconcileRoster: vi.fn().mockResolvedValue("skipped") },
      logger(),
      {
        initialDelayMs: 1,
        setTimeout: ((callback: () => void) => {
          timers.push(callback);
          return 1 as unknown as ReturnType<typeof globalThis.setTimeout>;
        }) as typeof globalThis.setTimeout,
        clearTimeout: vi.fn(),
        metrics,
      },
    );

    timers.shift()?.();
    await vi.waitFor(() => expect(metrics.snapshot().skipsTotal).toBe(1));
    expect(metrics.snapshot()).toMatchObject({ failuresTotal: 0, consecutiveFailures: 0 });
    loop.stop();
  });
});
