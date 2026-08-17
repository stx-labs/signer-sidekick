import { ClarityType } from "@stacks/transactions";
import { decodeClarityHex } from "@stx-labs/signer-sidekick-protocol/clarity-codecs";
import { z } from "zod";
import { RateLimitedError } from "./chain-clients.js";
import type { ObserverVerificationOutcome } from "./observer-inbox.js";
import type { StoredObserverDelivery } from "./storage/observer-inbox-repository.js";

export type ObserverReconciliationDomain = "current" | "manager-activity" | "rewards" | "roster";

export interface ObserverReconciliationService {
  refreshSnapshot(): Promise<unknown>;
  synchronizeManagerActivity(options?: {
    signal?: AbortSignal;
    minimumStacksHeight?: number | null;
  }): Promise<unknown>;
  synchronizeRewardRealizations(options?: {
    signal?: AbortSignal;
    minimumStacksHeight?: number | null;
  }): Promise<unknown>;
  synchronize(options?: {
    signal?: AbortSignal;
    minimumStacksHeight?: number | null;
  }): Promise<unknown>;
}

export interface ObserverReconciliationLogger {
  info(bindings: Record<string, unknown>, message: string): void;
  warn(bindings: Record<string, unknown>, message: string): void;
}

export interface ObserverReconciliationDomainStatus {
  pending: boolean;
  running: boolean;
  requests: number;
  coalescedRequests: number;
  successes: number;
  failuresTotal: number;
  consecutiveFailures: number;
  requestedStacksHeight: number | null;
  requestedBurnHeight: number | null;
  lastRequestedAt: string | null;
  lastStartedAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
  nextRetryAt: string | null;
  callbackLatency: {
    samples: number;
    sumSeconds: number;
    maxSeconds: number;
    lastSeconds: number | null;
    withinTwoSeconds: number;
    buckets: { le1: number; le2: number; le5: number; le10: number; le30: number };
  };
}

export interface ObserverReconciliationStatus {
  schemaVersion: 1;
  started: boolean;
  domains: Record<ObserverReconciliationDomain, ObserverReconciliationDomainStatus>;
}

interface MutableDomainState extends ObserverReconciliationDomainStatus {
  timer: ReturnType<typeof setTimeout> | null;
  active: Promise<void> | null;
  abortController: AbortController | null;
  pendingCallbackReceivedAtMs: number | null;
}

const DEFAULT_FAILURE_DELAY_MS = 15_000;
const DEFAULT_MAX_BACKOFF_MS = 5 * 60_000;
const DEFAULT_MANAGER_ACTIVITY_BACKFILL_INTERVAL_MS = 5 * 60_000;

const blockTriggerSchema = z
  .object({
    events: z.array(z.unknown()),
  })
  .passthrough();
const managerPrintEventSchema = z
  .object({
    type: z.literal("contract_event"),
    committed: z.literal(true),
    contract_event: z
      .object({
        contract_identifier: z.string(),
        topic: z.literal("print"),
        raw_value: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

function domainState(): MutableDomainState {
  return {
    pending: false,
    running: false,
    requests: 0,
    coalescedRequests: 0,
    successes: 0,
    failuresTotal: 0,
    consecutiveFailures: 0,
    requestedStacksHeight: null,
    requestedBurnHeight: null,
    lastRequestedAt: null,
    lastStartedAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastError: null,
    nextRetryAt: null,
    callbackLatency: {
      samples: 0,
      sumSeconds: 0,
      maxSeconds: 0,
      lastSeconds: null,
      withinTwoSeconds: 0,
      buckets: { le1: 0, le2: 0, le5: 0, le10: 0, le30: 0 },
    },
    timer: null,
    active: null,
    abortController: null,
    pendingCallbackReceivedAtMs: null,
  };
}

function maxHeight(current: number | null, next: number | null | undefined): number | null {
  if (next === null || next === undefined) return current;
  if (!Number.isSafeInteger(next) || next < 0)
    throw new Error("Observed height must be non-negative");
  return current === null ? next : Math.max(current, next);
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function containsContractPrint(
  delivery: StoredObserverDelivery,
  contractPrincipal: string,
): boolean {
  try {
    const parsed = blockTriggerSchema.safeParse(JSON.parse(delivery.rawPayloadJson));
    return (
      parsed.success &&
      parsed.data.events.some((candidate) => {
        const event = managerPrintEventSchema.safeParse(candidate);
        return event.success && event.data.contract_event.contract_identifier === contractPrincipal;
      })
    );
  } catch {
    return false;
  }
}

function containsRelevantPox5Print(
  delivery: StoredObserverDelivery,
  contractPrincipal: string,
  managerPrincipal: string,
): boolean {
  try {
    const parsed = blockTriggerSchema.safeParse(JSON.parse(delivery.rawPayloadJson));
    if (!parsed.success) return false;
    return parsed.data.events.some((candidate) => {
      const event = managerPrintEventSchema.safeParse(candidate);
      if (
        !event.success ||
        event.data.contract_event.contract_identifier !== contractPrincipal ||
        !event.data.contract_event.raw_value
      ) {
        return false;
      }
      const value = decodeClarityHex(event.data.contract_event.raw_value);
      if (value.type !== ClarityType.Tuple) return false;
      return ["signer", "old-signer", "signer-manager"].some((field) => {
        const principal = value.value[field];
        return (
          (principal?.type === ClarityType.PrincipalStandard ||
            principal?.type === ClarityType.PrincipalContract) &&
          principal.value === managerPrincipal
        );
      });
    });
  } catch {
    return false;
  }
}

function containsPox5RewardCalculationPrint(
  delivery: StoredObserverDelivery,
  contractPrincipal: string,
): boolean {
  try {
    const parsed = blockTriggerSchema.safeParse(JSON.parse(delivery.rawPayloadJson));
    if (!parsed.success) return false;
    return parsed.data.events.some((candidate) => {
      const event = managerPrintEventSchema.safeParse(candidate);
      if (
        !event.success ||
        event.data.contract_event.contract_identifier !== contractPrincipal ||
        !event.data.contract_event.raw_value
      ) {
        return false;
      }
      const value = decodeClarityHex(event.data.contract_event.raw_value);
      if (value.type !== ClarityType.Tuple) return false;
      const topic = value.value.topic;
      return (
        (topic?.type === ClarityType.StringASCII || topic?.type === ClarityType.StringUTF8) &&
        topic.value === "calculate-rewards"
      );
    });
  } catch {
    return false;
  }
}

function copyState(state: MutableDomainState): ObserverReconciliationDomainStatus {
  return {
    pending: state.pending,
    running: state.running,
    requests: state.requests,
    coalescedRequests: state.coalescedRequests,
    successes: state.successes,
    failuresTotal: state.failuresTotal,
    consecutiveFailures: state.consecutiveFailures,
    requestedStacksHeight: state.requestedStacksHeight,
    requestedBurnHeight: state.requestedBurnHeight,
    lastRequestedAt: state.lastRequestedAt,
    lastStartedAt: state.lastStartedAt,
    lastSuccessAt: state.lastSuccessAt,
    lastFailureAt: state.lastFailureAt,
    lastError: state.lastError,
    nextRetryAt: state.nextRetryAt,
    callbackLatency: {
      ...state.callbackLatency,
      buckets: { ...state.callbackLatency.buckets },
    },
  };
}

function recordCallbackLatency(state: MutableDomainState, latencySeconds: number): void {
  const latency = Math.max(0, latencySeconds);
  state.callbackLatency.samples += 1;
  state.callbackLatency.sumSeconds += latency;
  state.callbackLatency.maxSeconds = Math.max(state.callbackLatency.maxSeconds, latency);
  state.callbackLatency.lastSeconds = latency;
  if (latency <= 2) state.callbackLatency.withinTwoSeconds += 1;
  if (latency <= 1) state.callbackLatency.buckets.le1 += 1;
  if (latency <= 2) state.callbackLatency.buckets.le2 += 1;
  if (latency <= 5) state.callbackLatency.buckets.le5 += 1;
  if (latency <= 10) state.callbackLatency.buckets.le10 += 1;
  if (latency <= 30) state.callbackLatency.buckets.le30 += 1;
}

/**
 * Coalesces verified observer prompts into independent current-state and manager-activity work.
 * Durable event cursors make each handler idempotent; running both domains once at startup closes
 * the only process-failure window between completing an inbox delivery and requesting its work.
 */
export class ObserverReconciliationScheduler {
  readonly #service: ObserverReconciliationService;
  readonly #logger: ObserverReconciliationLogger;
  readonly #managerPrincipal: string;
  readonly #getPox5ContractId: () => string | null;
  readonly #canRun: () => boolean;
  readonly #now: () => Date;
  readonly #failureDelayMs: number;
  readonly #maxBackoffMs: number;
  readonly #managerActivityBackfillIntervalMs: number;
  readonly #setTimeout: typeof globalThis.setTimeout;
  readonly #clearTimeout: typeof globalThis.clearTimeout;
  readonly #states: Record<ObserverReconciliationDomain, MutableDomainState> = {
    current: domainState(),
    "manager-activity": domainState(),
    rewards: domainState(),
    roster: domainState(),
  };
  #started = false;
  #managerActivityBackfillTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: {
    service: ObserverReconciliationService;
    logger: ObserverReconciliationLogger;
    managerPrincipal: string;
    getPox5ContractId: () => string | null;
    canRun?: () => boolean;
    now?: () => Date;
    failureDelayMs?: number;
    maxBackoffMs?: number;
    managerActivityBackfillIntervalMs?: number;
    setTimeout?: typeof globalThis.setTimeout;
    clearTimeout?: typeof globalThis.clearTimeout;
  }) {
    this.#service = options.service;
    this.#logger = options.logger;
    this.#managerPrincipal = options.managerPrincipal;
    if (!this.#managerPrincipal.trim()) throw new Error("managerPrincipal must not be empty");
    this.#getPox5ContractId = options.getPox5ContractId;
    this.#canRun = options.canRun ?? (() => true);
    this.#now = options.now ?? (() => new Date());
    this.#failureDelayMs = options.failureDelayMs ?? DEFAULT_FAILURE_DELAY_MS;
    this.#maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.#managerActivityBackfillIntervalMs =
      options.managerActivityBackfillIntervalMs ?? DEFAULT_MANAGER_ACTIVITY_BACKFILL_INTERVAL_MS;
    this.#setTimeout = options.setTimeout ?? globalThis.setTimeout;
    this.#clearTimeout = options.clearTimeout ?? globalThis.clearTimeout;
    for (const [name, value] of [
      ["failureDelayMs", this.#failureDelayMs],
      ["maxBackoffMs", this.#maxBackoffMs],
      ["managerActivityBackfillIntervalMs", this.#managerActivityBackfillIntervalMs],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${name} must be a positive integer`);
      }
    }
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    // Startup anti-entropy guarantees convergence if the previous process exited after marking a
    // delivery complete but before its in-memory follow-up could be scheduled.
    this.request("current");
    this.request("manager-activity");
    this.request("rewards");
    this.#scheduleManagerActivityBackfill();
  }

  request(
    domain: ObserverReconciliationDomain,
    anchor: {
      stacksHeight?: number | null;
      burnHeight?: number | null;
      callbackReceivedAt?: string | null;
    } = {},
  ): void {
    const state = this.#states[domain];
    if (state.pending || state.running) state.coalescedRequests += 1;
    state.requests += 1;
    state.pending = true;
    state.requestedStacksHeight = maxHeight(state.requestedStacksHeight, anchor.stacksHeight);
    state.requestedBurnHeight = maxHeight(state.requestedBurnHeight, anchor.burnHeight);
    if (anchor.callbackReceivedAt) {
      const receivedAtMs = Date.parse(anchor.callbackReceivedAt);
      if (!Number.isFinite(receivedAtMs)) throw new Error("Callback receipt time must be ISO-8601");
      state.pendingCallbackReceivedAtMs =
        state.pendingCallbackReceivedAtMs === null
          ? receivedAtMs
          : Math.min(state.pendingCallbackReceivedAtMs, receivedAtMs);
    }
    state.lastRequestedAt = this.#now().toISOString();
    if (this.#started && !state.running && !state.timer) this.#schedule(domain, 0);
  }

  notifyProcessed(
    delivery: StoredObserverDelivery,
    outcome: Extract<ObserverVerificationOutcome, { action: "finish" }>,
  ): void {
    if (delivery.endpointKind === "new-block" && outcome.state === "node-verified") {
      const anchor = {
        stacksHeight: delivery.claimedBlockHeight,
        callbackReceivedAt: delivery.firstReceivedAt,
      };
      this.request("current", anchor);
      // Stacks Core posts /new_block for every anchored block once an observer is registered,
      // even when this observer's filtered event list is empty. Treat the untrusted body only as
      // a cheap trigger hint; API content plus the local transaction index remain the witnesses.
      if (containsContractPrint(delivery, this.#managerPrincipal)) {
        this.request("manager-activity", anchor);
      }
      const pox5ContractId = this.#getPox5ContractId();
      if (
        pox5ContractId &&
        containsRelevantPox5Print(delivery, pox5ContractId, this.#managerPrincipal)
      ) {
        this.request("roster", anchor);
      }
      if (pox5ContractId && containsPox5RewardCalculationPrint(delivery, pox5ContractId)) {
        this.request("rewards", anchor);
      }
      return;
    }
    if (
      delivery.endpointKind === "new-burn-block" &&
      outcome.state === "expired" &&
      outcome.reason.startsWith("trigger-consumed;")
    ) {
      this.request("current", {
        burnHeight: delivery.claimedBurnBlockHeight,
        callbackReceivedAt: delivery.firstReceivedAt,
      });
    }
  }

  status(): ObserverReconciliationStatus {
    return {
      schemaVersion: 1,
      started: this.#started,
      domains: {
        current: copyState(this.#states.current),
        "manager-activity": copyState(this.#states["manager-activity"]),
        rewards: copyState(this.#states.rewards),
        roster: copyState(this.#states.roster),
      },
    };
  }

  async stop(): Promise<void> {
    this.#started = false;
    if (this.#managerActivityBackfillTimer) {
      this.#clearTimeout(this.#managerActivityBackfillTimer);
      this.#managerActivityBackfillTimer = null;
    }
    const active: Promise<void>[] = [];
    for (const state of Object.values(this.#states)) {
      if (state.timer) this.#clearTimeout(state.timer);
      state.timer = null;
      state.pending = false;
      state.pendingCallbackReceivedAtMs = null;
      state.nextRetryAt = null;
      state.abortController?.abort(new Error("Observer reconciliation stopped"));
      if (state.active) active.push(state.active);
    }
    await Promise.allSettled(active);
  }

  #scheduleManagerActivityBackfill(): void {
    if (!this.#started || this.#managerActivityBackfillTimer) return;
    this.#managerActivityBackfillTimer = this.#setTimeout(() => {
      this.#managerActivityBackfillTimer = null;
      if (!this.#started) return;
      this.request("manager-activity");
      this.request("rewards");
      this.#scheduleManagerActivityBackfill();
    }, this.#managerActivityBackfillIntervalMs);
    this.#managerActivityBackfillTimer.unref?.();
  }

  #schedule(domain: ObserverReconciliationDomain, delayMs: number): void {
    const state = this.#states[domain];
    if (!this.#started || state.timer || state.running) return;
    state.nextRetryAt =
      delayMs > 0 ? new Date(this.#now().getTime() + delayMs).toISOString() : null;
    state.timer = this.#setTimeout(() => {
      state.timer = null;
      state.nextRetryAt = null;
      void this.#run(domain);
    }, delayMs);
    state.timer.unref?.();
  }

  async #run(domain: ObserverReconciliationDomain): Promise<void> {
    const state = this.#states[domain];
    if (!this.#started || state.running || !state.pending) return;
    if (!this.#canRun()) {
      this.#schedule(domain, this.#failureDelayMs);
      return;
    }
    state.pending = false;
    state.running = true;
    state.lastStartedAt = this.#now().toISOString();
    const requestedStacksHeight = state.requestedStacksHeight;
    const callbackReceivedAtMs = state.pendingCallbackReceivedAtMs;
    state.pendingCallbackReceivedAtMs = null;
    const controller = new AbortController();
    state.abortController = controller;
    let retryDelayMs = 0;
    const active = (async () => {
      try {
        if (domain === "current") {
          await this.#service.refreshSnapshot();
        } else if (domain === "manager-activity") {
          await this.#service.synchronizeManagerActivity({
            signal: controller.signal,
            minimumStacksHeight: requestedStacksHeight,
          });
        } else if (domain === "rewards") {
          await this.#service.synchronizeRewardRealizations({
            signal: controller.signal,
            minimumStacksHeight: requestedStacksHeight,
          });
        } else {
          await this.#service.synchronize({
            signal: controller.signal,
            minimumStacksHeight: requestedStacksHeight,
          });
        }
        state.successes += 1;
        state.consecutiveFailures = 0;
        state.lastSuccessAt = this.#now().toISOString();
        state.lastError = null;
        if (callbackReceivedAtMs !== null) {
          recordCallbackLatency(state, (this.#now().getTime() - callbackReceivedAtMs) / 1_000);
        }
      } catch (error) {
        if (!this.#started && controller.signal.aborted) return;
        state.failuresTotal += 1;
        state.consecutiveFailures += 1;
        state.pending = true;
        state.lastFailureAt = this.#now().toISOString();
        state.lastError = safeError(error);
        if (callbackReceivedAtMs !== null) {
          state.pendingCallbackReceivedAtMs =
            state.pendingCallbackReceivedAtMs === null
              ? callbackReceivedAtMs
              : Math.min(state.pendingCallbackReceivedAtMs, callbackReceivedAtMs);
        }
        retryDelayMs =
          error instanceof RateLimitedError && error.retryAfterMs !== null
            ? Math.min(this.#maxBackoffMs, Math.max(1_000, error.retryAfterMs))
            : Math.min(
                this.#maxBackoffMs,
                this.#failureDelayMs * 2 ** Math.max(0, state.consecutiveFailures - 1),
              );
        this.#logger.warn(
          {
            domain,
            failures: state.consecutiveFailures,
            retryInMs: retryDelayMs,
            error: state.lastError,
          },
          "Observer-triggered reconciliation failed; retained work will retry",
        );
      } finally {
        state.running = false;
        state.abortController = null;
        state.active = null;
        if (this.#started && state.pending && !state.timer) {
          this.#schedule(domain, retryDelayMs);
        }
      }
    })();
    state.active = active;
    await active;
  }
}
