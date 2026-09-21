import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  RewardRun,
  RewardRunPreparation,
  RewardRunPrepareRequest,
} from "@stx-labs/signer-sidekick-api-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RewardScheduleService } from "./reward-schedule.js";
import { createServer } from "./server.js";
import { openSidekickStore, type SidekickStore } from "./storage/store.js";
import { RewardRunError } from "./transaction-engine/reward-run-service.js";

const stores: SidekickStore[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
  vi.useRealTimers();
});

async function fixture(path = ":memory:") {
  const { store } = await openSidekickStore(path);
  stores.push(store);
  let now = new Date("2026-09-21T12:00:00Z");
  let identity = "mainnet:1:manager:gas-wallet";
  let preparation: RewardRunPreparation | null = null;
  let run: RewardRun | null = null;
  const request: RewardRunPrepareRequest = {
    cycle: 143,
    distribution: 1,
    operations: ["claim-rewards"],
  };
  const runs = {
    enqueuePreparation: vi.fn((input: RewardRunPrepareRequest) => {
      preparation = {
        schemaVersion: 1,
        preparationId: input.requestId as string,
        status: "preparing",
        requestSha256: "11".repeat(32),
        request: input,
        runId: null,
        failureReason: null,
        createdAt: now.toISOString(),
        startedAt: now.toISOString(),
        completedAt: null,
        updatedAt: now.toISOString(),
      };
      return preparation;
    }),
    getPreparation: vi.fn((id: string) => {
      if (!preparation || preparation.preparationId !== id)
        throw new RewardRunError("reward_run_not_found", "Missing preparation");
      return preparation;
    }),
    get: vi.fn(() => {
      if (!run) throw new Error("Missing run");
      return run;
    }),
    approve: vi.fn(async (_id: string, _hash: string) => {
      if (!run) throw new Error("Missing run");
      run.status = "approved";
      return run;
    }),
    cancel: vi.fn(() => {
      if (!run) throw new Error("Missing run");
      run.status = "cancelled";
      return run;
    }),
  };
  const select = vi.fn(
    async (
      _cursor: number | null,
    ): Promise<{ request: RewardRunPrepareRequest | null; beforeCycle: number | null }> => ({
      request,
      beforeCycle: null,
    }),
  );
  const unavailable = vi.fn((): string | null => null);
  const walletBusy = vi.fn(() => false);
  const options = {
    repository: store.rewardSchedule,
    runs,
    select,
    unavailable,
    walletBusy,
    now: () => now,
    identity: () => identity,
  };
  const schedule = new RewardScheduleService(options);
  const configure = (enabled = true) =>
    schedule.configure({ enabled, intervalMinutes: 15, revision: schedule.status().revision });
  const ready = () => {
    if (!preparation) throw new Error("No preparation");
    preparation.status = "ready";
    preparation.runId = preparation.preparationId;
    run = {
      runId: preparation.runId,
      recipeSha256: "22".repeat(32),
      status: "awaiting-approval",
      children: [],
      progress: { total: 1, completed: 0, inFlight: 0 },
      failureReason: null,
    } as unknown as RewardRun;
    return run;
  };
  return {
    store,
    schedule,
    options,
    runs,
    select,
    unavailable,
    walletBusy,
    configure,
    ready,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
    changeIdentity: () => {
      identity = "different-wallet";
    },
  };
}

describe("scheduled reward runs (engine unchanged)", () => {
  it("starts off and checks at the configured interval, never on every maintenance tick", async () => {
    const f = await fixture();
    f.select.mockResolvedValue({ request: null, beforeCycle: 100 });
    await f.schedule.tick();
    expect(f.select).not.toHaveBeenCalled();
    f.configure();
    await f.schedule.tick();
    await f.schedule.tick();
    expect(f.select).toHaveBeenCalledTimes(1);
    f.advance(15 * 60_000);
    await f.schedule.tick();
    expect(f.select).toHaveBeenLastCalledWith(100);
    expect(f.select).toHaveBeenCalledTimes(2);
  });

  it("prepares and approves its exact hash, continues after completion and records provenance", async () => {
    const f = await fixture();
    f.configure();
    await f.schedule.tick();
    const run = f.ready();
    await f.schedule.tick();
    expect(f.runs.approve).toHaveBeenCalledWith(run.runId, run.recipeSha256);
    expect(f.store.rewardSchedule.isScheduled(run.runId)).toBe(true);
    run.status = "completed";
    await f.schedule.tick();
    await f.schedule.tick();
    expect(f.runs.enqueuePreparation).toHaveBeenCalledTimes(2);
  });

  it("coalesces overlapping passes and cancels discovery when disabled while reading", async () => {
    const f = await fixture();
    f.configure();
    let release!: () => void;
    f.select.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { request: { cycle: 143, distribution: 1 }, beforeCycle: null };
    });
    const first = f.schedule.tick();
    const second = f.schedule.tick();
    expect(first).toBe(second);
    f.configure(false);
    release();
    await first;
    expect(f.runs.enqueuePreparation).not.toHaveBeenCalled();
  });

  it("cancels its own unapproved recipe when disabled during preparation", async () => {
    const f = await fixture();
    f.configure();
    await f.schedule.tick();
    f.configure(false);
    const run = f.ready();
    await f.schedule.tick();
    expect(f.runs.approve).not.toHaveBeenCalled();
    expect(f.runs.cancel).toHaveBeenCalledWith(run.runId);
    expect(f.schedule.status().enabled).toBe(false);
  });

  it("does not cancel an already-approved run when the schedule is disabled", async () => {
    const f = await fixture();
    f.configure();
    await f.schedule.tick();
    const run = f.ready();
    await f.schedule.tick();
    f.configure(false);
    await f.schedule.tick();
    expect(run.status).toBe("approved");
    expect(f.runs.cancel).not.toHaveBeenCalled();
    run.status = "completed";
    await f.schedule.tick();
    await f.schedule.tick();
    expect(f.schedule.status()).toMatchObject({ enabled: false, nextCheckAt: null });
    expect(f.runs.enqueuePreparation).toHaveBeenCalledOnce();
  });

  it("keeps Disable effective when an already-started approval finishes later", async () => {
    const f = await fixture();
    f.configure();
    await f.schedule.tick();
    const run = f.ready();
    const approving = Promise.withResolvers<RewardRun>();
    f.runs.approve.mockReturnValue(approving.promise);
    const tick = f.schedule.tick();
    f.configure(false);
    run.status = "approved";
    approving.resolve(run);
    await tick;
    await f.schedule.tick();
    expect(f.schedule.status()).toMatchObject({ enabled: false, state: "off" });
    expect(f.runs.approve).toHaveBeenCalledOnce();
    expect(f.runs.cancel).not.toHaveBeenCalled();
  });

  it("drains shutdown without approving work discovered after shutdown began", async () => {
    const f = await fixture();
    f.configure();
    const discovery = Promise.withResolvers<Awaited<ReturnType<typeof f.select>>>();
    f.select.mockReturnValue(discovery.promise);
    const tick = f.schedule.tick();
    const stop = f.schedule.stop();
    discovery.resolve({ request: { cycle: 143, distribution: 1 }, beforeCycle: null });
    await Promise.all([tick, stop]);
    expect(f.runs.enqueuePreparation).not.toHaveBeenCalled();
    expect(f.runs.approve).not.toHaveBeenCalled();
  });

  it("never adopts a manual preparation returned by input deduplication", async () => {
    const f = await fixture();
    f.configure();
    f.runs.enqueuePreparation.mockImplementation((request) => ({
      schemaVersion: 1,
      preparationId: "00000000-0000-4000-8000-000000000099",
      status: "queued",
      request,
      requestSha256: "11".repeat(32),
      runId: null,
      failureReason: null,
      createdAt: "2026-09-21T12:00:00Z",
      updatedAt: "2026-09-21T12:00:00Z",
      startedAt: null,
      completedAt: null,
    }));
    await f.schedule.tick();
    await f.schedule.tick();
    expect(f.runs.approve).not.toHaveBeenCalled();
    expect(f.schedule.status().detail).toContain("manually approved");
  });

  it("cannot rebind a pending recipe to new deployment consent before the next tick", async () => {
    const f = await fixture();
    f.configure();
    await f.schedule.tick();
    f.changeIdentity();
    f.configure(false);
    expect(() => f.configure()).toThrow("previous preparation");
    const run = f.ready();
    expect(() => f.configure()).toThrow("previous deployment's run");
    expect(f.runs.approve).not.toHaveBeenCalled();
    await f.schedule.tick();
    expect(run.status).toBe("cancelled");
    f.configure();
    expect(f.schedule.status().enabled).toBe(true);
  });

  it.each([
    "halted",
    "expired",
    "cancelled",
    "paused",
  ] as const)("latches %s without a successor, including after restart", async (status) => {
    const f = await fixture();
    f.configure();
    await f.schedule.tick();
    const run = f.ready();
    run.status = status;
    await f.schedule.tick();
    expect(f.schedule.status().state).toBe("needs-attention");
    const restarted = new RewardScheduleService(f.options);
    f.advance(24 * 60 * 60_000);
    await restarted.tick();
    expect(f.runs.enqueuePreparation).toHaveBeenCalledTimes(1);
    expect(f.runs.approve).not.toHaveBeenCalled();
  });

  it("does not clear an expired materialized/signed attempt through re-enablement", async () => {
    const f = await fixture();
    f.configure();
    await f.schedule.tick();
    const run = f.ready();
    run.status = "expired";
    run.children = [{ status: "materialized" }] as RewardRun["children"];
    await f.schedule.tick();
    expect(() => f.configure()).toThrow("resolve the stopped run");
  });

  it("recovers a saved request before enqueue and never reapproves an approved run", async () => {
    const f = await fixture();
    f.configure();
    const id = "00000000-0000-4000-8000-000000000010";
    f.store.rewardSchedule.update({
      request: { requestId: id, cycle: 143, distribution: 1 },
      preparationId: id,
    });
    const restarted = new RewardScheduleService(f.options);
    await restarted.tick();
    expect(f.runs.enqueuePreparation).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: id }),
    );
    const run = f.ready();
    run.status = "approved";
    await restarted.tick();
    expect(f.runs.approve).not.toHaveBeenCalled();
  });

  it("retains settings and request IDs across a real SQLite reopen", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sidekick-schedule-"));
    directories.push(dir);
    const f = await fixture(join(dir, "sidekick.sqlite"));
    f.configure();
    await f.schedule.tick();
    const saved = f.store.rewardSchedule.get();
    f.store.close();
    stores.splice(stores.indexOf(f.store), 1);
    const reopened = await openSidekickStore(join(dir, "sidekick.sqlite"));
    stores.push(reopened.store);
    expect(reopened.store.rewardSchedule.get()).toEqual(saved);
    expect(reopened.store.rewardSchedule.isScheduled(saved.preparationId as string)).toBe(true);
  });

  it("waits for manual work and emergency controls without creating a request", async () => {
    const f = await fixture();
    f.configure();
    f.walletBusy.mockReturnValue(true);
    await f.schedule.tick();
    f.advance(15 * 60_000);
    f.walletBusy.mockReturnValue(false);
    f.unavailable.mockReturnValue("Force Observe is active");
    await f.schedule.tick();
    expect(f.select).not.toHaveBeenCalled();
    expect(f.schedule.status().detail).toContain("Force Observe");
  });

  it("disables on changed identity and rejects stale settings saves", async () => {
    const f = await fixture();
    f.configure();
    f.changeIdentity();
    await f.schedule.tick();
    expect(f.schedule.status().enabled).toBe(false);
    expect(f.runs.enqueuePreparation).not.toHaveBeenCalled();
    expect(() => f.schedule.configure({ enabled: true, intervalMinutes: 15, revision: 0 })).toThrow(
      "refresh",
    );
  });

  it("does not treat unavailable discovery as a failed transaction", async () => {
    const f = await fixture();
    f.configure();
    f.select.mockRejectedValue(new Error("429"));
    await f.schedule.tick();
    expect(f.schedule.status().enabled).toBe(true);
    expect(f.schedule.status().state).toBe("waiting");
    expect(f.runs.approve).not.toHaveBeenCalled();
  });

  it("drives periodic checks from the server timer without a browser", async () => {
    const f = await fixture();
    vi.useFakeTimers();
    f.select.mockResolvedValue({ request: null, beforeCycle: null });
    f.configure();
    f.schedule.start();
    await f.schedule.tick();
    f.advance(15 * 60_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.select).toHaveBeenCalledTimes(2);
    await f.schedule.stop();
  });

  it("requires auth/CSRF, validates limits, and returns an explicit save conflict", async () => {
    const f = await fixture();
    const token = "test-operator-token-with-32-chars";
    const server = createServer({
      authToken: token,
      logger: false,
      rewardSchedule: f.schedule,
      service: { snapshot: vi.fn(), synchronize: vi.fn() },
    });
    try {
      const body = { enabled: true, intervalMinutes: 15, revision: 0 };
      expect(
        (await server.inject({ method: "PUT", url: "/api/v1/rewards/schedule", payload: body }))
          .statusCode,
      ).toBe(401);
      const headers = { authorization: `Bearer ${token}` };
      expect(
        (
          await server.inject({
            method: "PUT",
            url: "/api/v1/rewards/schedule",
            headers: { ...headers, origin: "https://evil.example" },
            payload: body,
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await server.inject({
            method: "PUT",
            url: "/api/v1/rewards/schedule",
            headers,
            payload: { ...body, intervalMinutes: 0 },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await server.inject({
            method: "PUT",
            url: "/api/v1/rewards/schedule",
            headers,
            payload: body,
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await server.inject({
            method: "PUT",
            url: "/api/v1/rewards/schedule",
            headers,
            payload: body,
          })
        ).statusCode,
      ).toBe(409);
      const result = await server.inject({ url: "/api/v1/rewards/schedule", headers });
      expect(result.json()).toMatchObject({ enabled: true, intervalMinutes: 15 });
      expect(result.json()).not.toHaveProperty("identity");
    } finally {
      await server.close();
    }
  });

  it("allows retained status and disabling before operational startup, never enabling", async () => {
    const f = await fixture();
    f.configure();
    const token = "test-operator-token-with-32-chars";
    const server = createServer({
      authToken: token,
      logger: false,
      rewardSchedule: f.schedule,
      isOperational: () => false,
    });
    const headers = { authorization: `Bearer ${token}` };
    try {
      expect(
        (await server.inject({ url: "/api/v1/rewards/schedule", headers })).json().enabled,
      ).toBe(true);
      expect(
        (
          await server.inject({
            method: "PUT",
            url: "/api/v1/rewards/schedule",
            headers,
            payload: { enabled: false, intervalMinutes: 15, revision: 1 },
          })
        ).statusCode,
      ).toBe(200);
      expect(f.schedule.status().enabled).toBe(false);
      expect(
        (
          await server.inject({
            method: "PUT",
            url: "/api/v1/rewards/schedule",
            headers,
            payload: { enabled: true, intervalMinutes: 15, revision: 2 },
          })
        ).statusCode,
      ).toBe(503);
    } finally {
      await server.close();
    }
  });
});
