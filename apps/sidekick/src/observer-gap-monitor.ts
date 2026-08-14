import type { StacksNodeClient } from "./chain-clients.js";
import type { ObserverInboxStatus } from "./storage/store.js";

export const DEFAULT_OBSERVER_GAP_CHECK_INTERVAL_MS = 15_000;

export interface ObserverGapStatus {
  schemaVersion: 1;
  started: boolean;
  status: "not-started" | "unknown" | "healthy" | "degraded";
  reason:
    | "not-started"
    | "awaiting-first-node-sample"
    | "node-check-failed"
    | "awaiting-next-node-advance"
    | "observer-catch-up-window"
    | "observer-current"
    | "observer-behind-node";
  intervalSeconds: number;
  checksTotal: number;
  failuresTotal: number;
  consecutiveFailures: number;
  startedAt: string | null;
  checkedAt: string | null;
  baselineStacksHeight: number | null;
  nodeStacksHeight: number | null;
  observerStacksHeight: number | null;
  stacksGap: number | null;
  observerSilenceSeconds: number | null;
  lastError: string | null;
}

export interface ObserverGapLogger {
  warn(bindings: Record<string, unknown>, message: string): void;
}

type GapNode = Pick<StacksNodeClient, "getInfo">;

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

export class ObserverGapMonitor {
  readonly #getNode: () => GapNode;
  readonly #getInbox: () => ObserverInboxStatus;
  readonly #onGap: (status: ObserverGapStatus) => void;
  readonly #logger: ObserverGapLogger;
  readonly #now: () => Date;
  readonly #intervalMs: number;
  readonly #setTimeout: typeof globalThis.setTimeout;
  readonly #clearTimeout: typeof globalThis.clearTimeout;
  #started = false;
  #startedAt: string | null = null;
  #baselineStacksHeight: number | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #active: Promise<void> | null = null;
  #abortController: AbortController | null = null;
  #lastNotifiedNodeHeight: number | null = null;
  #status: ObserverGapStatus;

  constructor(options: {
    getNode: () => GapNode;
    getInbox: () => ObserverInboxStatus;
    onGap?: (status: ObserverGapStatus) => void;
    logger: ObserverGapLogger;
    now?: () => Date;
    intervalMs?: number;
    setTimeout?: typeof globalThis.setTimeout;
    clearTimeout?: typeof globalThis.clearTimeout;
  }) {
    this.#getNode = options.getNode;
    this.#getInbox = options.getInbox;
    this.#onGap = options.onGap ?? (() => undefined);
    this.#logger = options.logger;
    this.#now = options.now ?? (() => new Date());
    this.#intervalMs = options.intervalMs ?? DEFAULT_OBSERVER_GAP_CHECK_INTERVAL_MS;
    if (!Number.isSafeInteger(this.#intervalMs) || this.#intervalMs < 1) {
      throw new Error("intervalMs must be a positive integer");
    }
    this.#setTimeout = options.setTimeout ?? globalThis.setTimeout;
    this.#clearTimeout = options.clearTimeout ?? globalThis.clearTimeout;
    this.#status = this.#emptyStatus();
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#startedAt = this.#now().toISOString();
    this.#status = {
      ...this.#emptyStatus(),
      started: true,
      status: "unknown",
      reason: "awaiting-first-node-sample",
      startedAt: this.#startedAt,
    };
    this.#schedule(0);
  }

  status(): ObserverGapStatus {
    return { ...this.#status };
  }

  async stop(): Promise<void> {
    this.#started = false;
    if (this.#timer) this.#clearTimeout(this.#timer);
    this.#timer = null;
    this.#abortController?.abort(new Error("Observer gap monitor stopped"));
    await this.#active;
  }

  #emptyStatus(): ObserverGapStatus {
    return {
      schemaVersion: 1,
      started: false,
      status: "not-started",
      reason: "not-started",
      intervalSeconds: this.#intervalMs / 1_000,
      checksTotal: 0,
      failuresTotal: 0,
      consecutiveFailures: 0,
      startedAt: null,
      checkedAt: null,
      baselineStacksHeight: null,
      nodeStacksHeight: null,
      observerStacksHeight: null,
      stacksGap: null,
      observerSilenceSeconds: null,
      lastError: null,
    };
  }

  #schedule(delayMs: number): void {
    if (!this.#started || this.#timer) return;
    this.#timer = this.#setTimeout(() => {
      this.#timer = null;
      void this.#check();
    }, delayMs);
    this.#timer.unref?.();
  }

  async #check(): Promise<void> {
    if (!this.#started || this.#active) return;
    const controller = new AbortController();
    this.#abortController = controller;
    const active = (async () => {
      const checkedAt = this.#now();
      try {
        const info = await this.#getNode().getInfo({ signal: controller.signal });
        if (!this.#started) return;
        const inbox = this.#getInbox();
        this.#baselineStacksHeight ??= info.stacks_tip_height;
        const observerHeight = inbox.lastVerifiedStacksBlock?.height ?? null;
        const stacksGap =
          observerHeight === null ? null : Math.max(0, info.stacks_tip_height - observerHeight);
        const silenceOrigin = inbox.lastVerifiedStacksBlock?.receivedAt ?? this.#startedAt;
        const observerSilenceSeconds = silenceOrigin
          ? Math.max(0, (checkedAt.getTime() - Date.parse(silenceOrigin)) / 1_000)
          : null;
        const callbackSinceStart =
          inbox.lastVerifiedStacksBlock !== null &&
          this.#startedAt !== null &&
          Date.parse(inbox.lastVerifiedStacksBlock.receivedAt) >= Date.parse(this.#startedAt);
        const nodeAdvancedSinceStart = info.stacks_tip_height > this.#baselineStacksHeight;
        const behind =
          callbackSinceStart &&
          stacksGap !== null &&
          stacksGap > 0 &&
          observerSilenceSeconds !== null &&
          observerSilenceSeconds >= this.#intervalMs / 1_000;
        const missedFirstCallback =
          !callbackSinceStart &&
          nodeAdvancedSinceStart &&
          checkedAt.getTime() - Date.parse(this.#startedAt ?? checkedAt.toISOString()) >=
            this.#intervalMs;
        const degraded = behind || missedFirstCallback;
        const reason: ObserverGapStatus["reason"] = degraded
          ? "observer-behind-node"
          : !nodeAdvancedSinceStart && !callbackSinceStart
            ? "awaiting-next-node-advance"
            : stacksGap !== null && stacksGap > 0
              ? "observer-catch-up-window"
              : "observer-current";
        this.#status = {
          ...this.#status,
          started: true,
          status: degraded ? "degraded" : "healthy",
          reason,
          checksTotal: this.#status.checksTotal + 1,
          consecutiveFailures: 0,
          checkedAt: checkedAt.toISOString(),
          baselineStacksHeight: this.#baselineStacksHeight,
          nodeStacksHeight: info.stacks_tip_height,
          observerStacksHeight: observerHeight,
          stacksGap,
          observerSilenceSeconds,
          lastError: null,
        };
        if (
          degraded &&
          (this.#lastNotifiedNodeHeight === null ||
            info.stacks_tip_height > this.#lastNotifiedNodeHeight)
        ) {
          this.#lastNotifiedNodeHeight = info.stacks_tip_height;
          this.#onGap(this.status());
        }
      } catch (error) {
        if (!this.#started && controller.signal.aborted) return;
        this.#status = {
          ...this.#status,
          started: true,
          status: "unknown",
          reason: "node-check-failed",
          checksTotal: this.#status.checksTotal + 1,
          failuresTotal: this.#status.failuresTotal + 1,
          consecutiveFailures: this.#status.consecutiveFailures + 1,
          checkedAt: checkedAt.toISOString(),
          lastError: safeError(error),
        };
        this.#logger.warn(
          { error: this.#status.lastError, failures: this.#status.consecutiveFailures },
          "Observer gap check failed; callback health is unknown",
        );
      } finally {
        this.#abortController = null;
        this.#active = null;
        if (this.#started) this.#schedule(this.#intervalMs);
      }
    })();
    this.#active = active;
    await active;
  }
}
