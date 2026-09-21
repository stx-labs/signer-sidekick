import { randomUUID } from "node:crypto";
import {
  type RewardRunPrepareRequest,
  type RewardScheduleSettings,
  type RewardScheduleStatus,
  rewardScheduleSettingsSchema,
  rewardScheduleStatusSchema,
} from "@stx-labs/signer-sidekick-api-contracts";
import type { RewardScheduleRepository } from "./storage/reward-schedule-repository.js";
import type { RewardRunService } from "./transaction-engine/reward-run-service.js";

export interface RewardScheduleOptions {
  repository: RewardScheduleRepository;
  runs: Pick<
    RewardRunService,
    "enqueuePreparation" | "getPreparation" | "get" | "approve" | "cancel"
  >;
  identity(): string | null;
  unavailable(): string | null;
  walletBusy(): boolean;
  select(beforeCycle: number | null): Promise<{
    request: RewardRunPrepareRequest | null;
    beforeCycle: number | null;
  }>;
  now?(): Date;
  onError?(error: unknown): void;
}

export class RewardScheduleError extends Error {}

/** Schedules the existing button flow. Never signs, broadcasts, resumes or replaces a transaction. */
export class RewardScheduleService {
  #timer: ReturnType<typeof setInterval> | null = null;
  #inFlight: Promise<void> | null = null;
  #closed = false;

  constructor(private readonly options: RewardScheduleOptions) {}

  status(): RewardScheduleStatus {
    const {
      identity: _,
      request: _request,
      beforeCycle: _cursor,
      stopped: _stopped,
      ...status
    } = this.options.repository.get();
    return rewardScheduleStatusSchema.parse(status);
  }

  configure(input: RewardScheduleSettings): RewardScheduleStatus {
    const settings = rewardScheduleSettingsSchema.parse(input);
    const current = this.options.repository.get();
    if (settings.revision !== current.revision)
      throw new RewardScheduleError("Schedule changed; refresh before saving.");
    const identity = this.options.identity();
    if (settings.enabled && (!identity || this.options.unavailable())) {
      throw new RewardScheduleError(
        this.options.unavailable() ?? "Enable the gas wallet in operator-run mode first.",
      );
    }
    let clear = false;
    if (settings.enabled && current.request && (current.stopped || current.identity !== identity)) {
      let runId = current.runId;
      if (!runId && current.preparationId) {
        try {
          const preparation = this.options.runs.getPreparation(current.preparationId);
          if (["queued", "preparing"].includes(preparation.status))
            throw new RewardScheduleError(
              "Wait for the previous preparation, then review it before enabling the schedule.",
            );
          runId = preparation.runId;
          if (runId) this.options.repository.update({ runId });
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !("code" in error) ||
            error.code !== "reward_run_not_found"
          )
            throw error;
        }
      }
      const run = runId ? this.options.runs.get(runId) : null;
      if (
        run &&
        (["halted", "paused"].includes(run.status) ||
          run.progress.inFlight > 0 ||
          run.children.some(
            (child) => child.status === "materialized" || child.status === "broadcast",
          ))
      ) {
        throw new RewardScheduleError(
          "Review and resolve the stopped run before enabling the schedule.",
        );
      }
      clear = run === null || ["completed", "cancelled", "expired"].includes(run.status);
      if (!clear && current.identity !== identity)
        throw new RewardScheduleError(
          "Cancel or finish the previous deployment's run before enabling this schedule.",
        );
    }
    this.options.repository.update({
      ...settings,
      revision: current.revision + 1,
      identity: settings.enabled || !current.request ? identity : current.identity,
      stopped: settings.enabled ? false : current.stopped,
      state: settings.enabled ? "scheduled" : "off",
      detail: settings.enabled
        ? "Automatic reward checks enabled."
        : "Automatic starts are off. An approval already in progress or an approved run may continue.",
      nextCheckAt: settings.enabled ? this.now().toISOString() : null,
      ...(clear ? { request: null, runId: null, preparationId: null } : {}),
    });
    return this.status();
  }

  start(): void {
    if (this.#timer || this.#closed) return;
    this.#timer = setInterval(() => void this.tick(), 5_000);
    this.#timer.unref?.();
    void this.tick();
  }

  async stop(): Promise<void> {
    this.#closed = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    await this.#inFlight;
  }

  tick(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    this.#inFlight ??= this.check()
      .catch((error: unknown) => {
        this.options.onError?.(error);
        const state = this.options.repository.get();
        if (state.request)
          this.halt(error instanceof Error ? error.message : "Scheduled run needs review.");
        else this.wait("Could not check rewards; retrying on schedule.");
      })
      .finally(() => {
        this.#inFlight = null;
      });
    return this.#inFlight;
  }

  private async check(): Promise<void> {
    const state = this.options.repository.get();
    if (state.stopped) return;
    if (state.enabled && state.identity !== this.options.identity()) {
      this.halt("Manager, network or gas wallet changed. Review and enable the schedule again.");
      return;
    }
    if (state.request) {
      await this.follow();
      return;
    }
    if (
      !state.enabled ||
      (state.nextCheckAt && Date.parse(state.nextCheckAt) > this.now().getTime())
    )
      return;
    this.options.repository.update({ lastCheckAt: this.now().toISOString() });
    const unavailable = this.options.unavailable();
    if (unavailable || this.options.walletBusy()) {
      this.wait(unavailable ?? "Waiting for the current run or gas-wallet sweep.");
      return;
    }
    const selected = await this.options.select(state.beforeCycle);
    // A settings change or shutdown during discovery must not create work under old consent.
    const latest = this.options.repository.get();
    if (this.#closed || !latest.enabled || latest.revision !== state.revision) return;
    if (latest.identity !== this.options.identity()) {
      this.halt("Deployment identity changed during the reward check.");
      return;
    }
    this.options.repository.update({ beforeCycle: selected.beforeCycle });
    if (!selected.request) {
      this.wait("No eligible reward action on this check.");
      return;
    }
    const request = { ...selected.request, requestId: randomUUID() };
    this.options.repository.track(request.requestId, this.now().toISOString());
    this.options.repository.update({
      request,
      preparationId: request.requestId,
      runId: null,
      state: "preparing",
      detail: "Preparing the next scheduled reward run.",
      nextCheckAt: null,
    });
    await this.follow();
  }

  private async follow(): Promise<void> {
    const state = this.options.repository.get();
    const request = state.request;
    if (!request?.requestId) throw new Error("Scheduled preparation has no request ID.");
    // Re-enqueue is idempotent, including a crash between saving the ID and starting preparation.
    let preparation: ReturnType<RewardScheduleOptions["runs"]["getPreparation"]>;
    try {
      preparation = this.options.runs.getPreparation(request.requestId);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "reward_run_not_found")
        throw error;
      if (!state.enabled) {
        this.clear();
        return;
      }
      preparation = this.options.runs.enqueuePreparation(request);
    }
    if (preparation.preparationId !== request.requestId) {
      // Preparation deduplication may return a manual request with identical inputs. Never adopt it.
      this.clear();
      this.wait("Waiting for an existing reward preparation; it remains manually approved.");
      return;
    }
    if (preparation.status === "failed") {
      this.halt(
        preparation.failureReason ?? "Reward preparation failed; review before continuing.",
      );
      return;
    }
    if (!preparation.runId) return;
    if (preparation.runId !== request.requestId)
      throw new Error("Scheduled recipe identity does not match its preparation.");
    const run = this.options.runs.get(preparation.runId);
    this.options.repository.update({ runId: run.runId });
    if (["halted", "paused", "expired", "cancelled"].includes(run.status)) {
      this.halt(run.failureReason ?? `Scheduled run ${run.status}. Review it before continuing.`);
    } else if (run.status === "completed") {
      this.clear();
      const enabled = this.options.repository.get().enabled;
      this.options.repository.update({
        beforeCycle: null,
        detail: enabled
          ? "Scheduled run completed; checking the next action."
          : "Scheduled run completed. Automatic starts remain off.",
        nextCheckAt: enabled ? this.now().toISOString() : null,
      });
    } else if (run.status === "awaiting-approval") {
      const latest = this.options.repository.get();
      if (!latest.enabled || this.#closed) {
        if (!this.#closed) {
          this.options.runs.cancel(run.runId);
          this.clear();
        }
        return;
      }
      if (latest.identity !== this.options.identity()) {
        this.halt("Deployment identity changed before approval.");
        return;
      }
      const unavailable = this.options.unavailable();
      if (unavailable) {
        this.options.repository.update({ state: "waiting", detail: unavailable });
        return;
      }
      // Calling approve is the hand-off boundary; its own asynchronous checks/execution are unchanged.
      await this.options.runs.approve(run.runId, run.recipeSha256);
      if (this.options.repository.get().enabled)
        this.options.repository.update({
          state: "running",
          detail: "Scheduled reward run approved; the engine is handling execution.",
          nextCheckAt: null,
        });
    } else if (state.enabled) {
      this.options.repository.update({
        state: "running",
        detail: `Scheduled run: ${run.progress.completed} of ${run.progress.total} calls complete.`,
        nextCheckAt: null,
      });
    }
  }

  private clear(): void {
    this.options.repository.update({ request: null, preparationId: null, runId: null });
  }
  private wait(detail: string): void {
    const state = this.options.repository.get();
    if (!state.enabled) return;
    this.options.repository.update({
      state: "waiting",
      detail,
      nextCheckAt: new Date(this.now().getTime() + state.intervalMinutes * 60_000).toISOString(),
    });
  }
  private halt(detail: string): void {
    this.options.repository.update({
      enabled: false,
      revision: this.options.repository.get().revision + 1,
      stopped: true,
      state: "needs-attention",
      detail,
      nextCheckAt: null,
    });
  }
  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}
