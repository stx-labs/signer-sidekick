import { z } from "zod";
import { RateLimitedError } from "./chain-clients.js";
import type { ObserverVerificationOutcome } from "./observer-inbox.js";
import type { StoredObserverDelivery } from "./storage/store.js";

export type ObserverReconciliationDomain = "current" | "manager-activity";

export interface ObserverReconciliationService {
  refreshSnapshot(): Promise<unknown>;
  synchronizeManagerActivity(options?: {
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
}

const DEFAULT_FAILURE_DELAY_MS = 15_000;
const DEFAULT_MAX_BACKOFF_MS = 5 * 60_000;

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
    timer: null,
    active: null,
    abortController: null,
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

function containsManagerPrint(delivery: StoredObserverDelivery, managerPrincipal: string): boolean {
  try {
    const parsed = blockTriggerSchema.safeParse(JSON.parse(delivery.rawPayloadJson));
    return (
      parsed.success &&
      parsed.data.events.some((candidate) => {
        const event = managerPrintEventSchema.safeParse(candidate);
        return event.success && event.data.contract_event.contract_identifier === managerPrincipal;
      })
    );
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
  };
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
  readonly #now: () => Date;
  readonly #failureDelayMs: number;
  readonly #maxBackoffMs: number;
  readonly #setTimeout: typeof globalThis.setTimeout;
  readonly #clearTimeout: typeof globalThis.clearTimeout;
  readonly #states: Record<ObserverReconciliationDomain, MutableDomainState> = {
    current: domainState(),
    "manager-activity": domainState(),
  };
  #started = false;

  constructor(options: {
    service: ObserverReconciliationService;
    logger: ObserverReconciliationLogger;
    managerPrincipal: string;
    now?: () => Date;
    failureDelayMs?: number;
    maxBackoffMs?: number;
    setTimeout?: typeof globalThis.setTimeout;
    clearTimeout?: typeof globalThis.clearTimeout;
  }) {
    this.#service = options.service;
    this.#logger = options.logger;
    this.#managerPrincipal = options.managerPrincipal;
    if (!this.#managerPrincipal.trim()) throw new Error("managerPrincipal must not be empty");
    this.#now = options.now ?? (() => new Date());
    this.#failureDelayMs = options.failureDelayMs ?? DEFAULT_FAILURE_DELAY_MS;
    this.#maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.#setTimeout = options.setTimeout ?? globalThis.setTimeout;
    this.#clearTimeout = options.clearTimeout ?? globalThis.clearTimeout;
    for (const [name, value] of [
      ["failureDelayMs", this.#failureDelayMs],
      ["maxBackoffMs", this.#maxBackoffMs],
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
  }

  request(
    domain: ObserverReconciliationDomain,
    anchor: { stacksHeight?: number | null; burnHeight?: number | null } = {},
  ): void {
    const state = this.#states[domain];
    if (state.pending || state.running) state.coalescedRequests += 1;
    state.requests += 1;
    state.pending = true;
    state.requestedStacksHeight = maxHeight(state.requestedStacksHeight, anchor.stacksHeight);
    state.requestedBurnHeight = maxHeight(state.requestedBurnHeight, anchor.burnHeight);
    state.lastRequestedAt = this.#now().toISOString();
    if (this.#started && !state.running && !state.timer) this.#schedule(domain, 0);
  }

  notifyProcessed(
    delivery: StoredObserverDelivery,
    outcome: Extract<ObserverVerificationOutcome, { action: "finish" }>,
  ): void {
    if (delivery.endpointKind === "new-block" && outcome.state === "node-verified") {
      const anchor = { stacksHeight: delivery.claimedBlockHeight };
      this.request("current", anchor);
      // Stacks Core posts /new_block for every anchored block once an observer is registered,
      // even when this observer's filtered event list is empty. Treat the untrusted body only as
      // a cheap trigger hint; API content plus the local transaction index remain the witnesses.
      if (containsManagerPrint(delivery, this.#managerPrincipal)) {
        this.request("manager-activity", anchor);
      }
      return;
    }
    if (
      delivery.endpointKind === "new-burn-block" &&
      outcome.state === "expired" &&
      outcome.reason.startsWith("trigger-consumed;")
    ) {
      this.request("current", { burnHeight: delivery.claimedBurnBlockHeight });
    }
  }

  status(): ObserverReconciliationStatus {
    return {
      schemaVersion: 1,
      started: this.#started,
      domains: {
        current: copyState(this.#states.current),
        "manager-activity": copyState(this.#states["manager-activity"]),
      },
    };
  }

  async stop(): Promise<void> {
    this.#started = false;
    const active: Promise<void>[] = [];
    for (const state of Object.values(this.#states)) {
      if (state.timer) this.#clearTimeout(state.timer);
      state.timer = null;
      state.pending = false;
      state.nextRetryAt = null;
      state.abortController?.abort(new Error("Observer reconciliation stopped"));
      if (state.active) active.push(state.active);
    }
    await Promise.allSettled(active);
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
    state.pending = false;
    state.running = true;
    state.lastStartedAt = this.#now().toISOString();
    const requestedStacksHeight = state.requestedStacksHeight;
    const controller = new AbortController();
    state.abortController = controller;
    let retryDelayMs = 0;
    const active = (async () => {
      try {
        if (domain === "current") {
          await this.#service.refreshSnapshot();
        } else {
          await this.#service.synchronizeManagerActivity({
            signal: controller.signal,
            minimumStacksHeight: requestedStacksHeight,
          });
        }
        state.successes += 1;
        state.consecutiveFailures = 0;
        state.lastSuccessAt = this.#now().toISOString();
        state.lastError = null;
      } catch (error) {
        if (!this.#started && controller.signal.aborted) return;
        state.failuresTotal += 1;
        state.consecutiveFailures += 1;
        state.pending = true;
        state.lastFailureAt = this.#now().toISOString();
        state.lastError = safeError(error);
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
