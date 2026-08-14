import {
  type NodeInfo,
  type NodeTenureInfo,
  type StacksNodeClient,
  UpstreamHttpError,
} from "./chain-clients.js";
import type { SidekickStore, StoredObserverDelivery } from "./storage/store.js";

const MAX_HEADER_PROOF_DEPTH = 2_100;
const MAX_FUTURE_BLOCK_DISTANCE = 12;
const DEFAULT_RETRY_INTERVAL_MS = 15_000;
const DEFAULT_MAX_BATCH_SIZE = 100;

type ObserverInboxStore = Pick<
  SidekickStore,
  | "claimNextObserverDelivery"
  | "finishObserverDelivery"
  | "recoverObserverDeliveries"
  | "retryObserverDelivery"
>;

type ObserverVerificationNode = Pick<
  StacksNodeClient,
  "getInfo" | "getTenureInfo" | "getNakamotoBlockById" | "getNakamotoBlockAtHeight"
>;

export type ObserverVerificationOutcome =
  | {
      action: "finish";
      state: "node-verified" | "quarantined" | "expired";
      reason: string;
    }
  | { action: "retry"; reason: string };

function sameCanonicalTip(
  leftInfo: NodeInfo,
  leftTenure: NodeTenureInfo,
  rightInfo: NodeInfo,
  rightTenure: NodeTenureInfo,
): boolean {
  return (
    leftInfo.stacks_tip !== undefined &&
    leftInfo.stacks_tip === rightInfo.stacks_tip &&
    leftInfo.stacks_tip_height === rightInfo.stacks_tip_height &&
    leftTenure.tip_height === rightTenure.tip_height &&
    leftTenure.tip_block_id === rightTenure.tip_block_id
  );
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && Buffer.compare(left, right) === 0;
}

async function verifyStacksBlockDelivery(
  delivery: StoredObserverDelivery,
  node: ObserverVerificationNode,
  signal?: AbortSignal,
): Promise<ObserverVerificationOutcome> {
  if (
    delivery.claimedBlockHeight === null ||
    delivery.claimedBlockHash === null ||
    delivery.claimedIndexBlockHash === null
  ) {
    return {
      action: "finish",
      state: "quarantined",
      reason: "missing-stacks-block-claim",
    };
  }

  const requestOptions = signal ? { signal } : {};
  const [beforeInfo, beforeTenure] = await Promise.all([
    node.getInfo(requestOptions),
    node.getTenureInfo(requestOptions),
  ]);
  if (!beforeInfo.stacks_tip) return { action: "retry", reason: "node-tip-id-unavailable" };
  if (beforeInfo.stacks_tip_height !== beforeTenure.tip_height) {
    return { action: "retry", reason: "node-tip-sources-disagree" };
  }
  if (delivery.claimedBlockHeight > beforeTenure.tip_height + MAX_FUTURE_BLOCK_DISTANCE) {
    return {
      action: "finish",
      state: "quarantined",
      reason: "claimed-stacks-height-unreasonably-ahead-of-node",
    };
  }
  if (delivery.claimedBlockHeight > beforeTenure.tip_height) {
    return { action: "retry", reason: "node-has-not-reached-claimed-stacks-height" };
  }

  const distance = beforeTenure.tip_height - delivery.claimedBlockHeight;
  if (distance >= MAX_HEADER_PROOF_DEPTH) {
    return {
      action: "finish",
      state: "expired",
      reason: "outside-local-header-proof-window",
    };
  }

  let claimedBlock: Uint8Array;
  try {
    claimedBlock = await node.getNakamotoBlockById(
      delivery.claimedIndexBlockHash as `0x${string}`,
      requestOptions,
    );
  } catch (error) {
    if (error instanceof UpstreamHttpError && error.status === 404) {
      return {
        action: "finish",
        state: "quarantined",
        reason: "callback-index-block-is-not-known-to-local-node",
      };
    }
    throw error;
  }
  const canonicalBlock = await node.getNakamotoBlockAtHeight(delivery.claimedBlockHeight, {
    tip: beforeTenure.tip_block_id,
    ...(signal ? { signal } : {}),
  });
  const [afterInfo, afterTenure] = await Promise.all([
    node.getInfo(requestOptions),
    node.getTenureInfo(requestOptions),
  ]);
  if (!sameCanonicalTip(beforeInfo, beforeTenure, afterInfo, afterTenure)) {
    return { action: "retry", reason: "canonical-node-tip-changed-during-proof" };
  }
  if (!sameBytes(claimedBlock, canonicalBlock)) {
    return {
      action: "finish",
      state: "quarantined",
      reason: "callback-index-block-does-not-match-canonical-node-block-at-height",
    };
  }
  return {
    action: "finish",
    state: "node-verified",
    reason: "canonical-stacks-index-block-verified;callback-block-hash-and-events-remain-untrusted",
  };
}

async function verifyBurnBlockDelivery(
  delivery: StoredObserverDelivery,
  node: ObserverVerificationNode,
  signal?: AbortSignal,
): Promise<ObserverVerificationOutcome> {
  if (delivery.claimedBurnBlockHeight === null || delivery.claimedBurnBlockHash === null) {
    return {
      action: "finish",
      state: "quarantined",
      reason: "missing-burn-block-claim",
    };
  }
  const info = await node.getInfo({ ...(signal ? { signal } : {}) });
  if (info.burn_block_height < delivery.claimedBurnBlockHeight) {
    return { action: "retry", reason: "node-has-not-reached-claimed-burn-height" };
  }
  return {
    action: "finish",
    state: "expired",
    reason: "trigger-consumed;burn-block-hash-not-locally-verifiable",
  };
}

export async function verifyObserverDelivery(
  delivery: StoredObserverDelivery,
  node: ObserverVerificationNode,
  signal?: AbortSignal,
): Promise<ObserverVerificationOutcome> {
  if (delivery.endpointKind === "new-block") {
    return await verifyStacksBlockDelivery(delivery, node, signal);
  }
  if (delivery.endpointKind === "new-burn-block") {
    return await verifyBurnBlockDelivery(delivery, node, signal);
  }
  return {
    action: "finish",
    state: "expired",
    reason: "implicit-attachment-callback-not-used",
  };
}

function safeErrorReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `node-verification-error:${message}`.slice(0, 500);
}

export class ObserverInboxProcessor {
  readonly #store: ObserverInboxStore;
  readonly #getNode: () => ObserverVerificationNode;
  readonly #canProcess: () => boolean;
  readonly #now: () => Date;
  readonly #onError: (error: unknown) => void;
  readonly #onProcessed: (
    delivery: StoredObserverDelivery,
    outcome: Extract<ObserverVerificationOutcome, { action: "finish" }>,
  ) => void;
  readonly #retryIntervalMs: number;
  readonly #maxBatchSize: number;
  #started = false;
  #drainRequested = false;
  #drainPromise: Promise<number> | null = null;
  #retryTimer: NodeJS.Timeout | null = null;
  #abortController: AbortController | null = null;

  constructor(options: {
    store: ObserverInboxStore;
    getNode: () => ObserverVerificationNode;
    canProcess?: () => boolean;
    now?: () => Date;
    onError?: (error: unknown) => void;
    onProcessed?: (
      delivery: StoredObserverDelivery,
      outcome: Extract<ObserverVerificationOutcome, { action: "finish" }>,
    ) => void;
    retryIntervalMs?: number;
    maxBatchSize?: number;
  }) {
    this.#store = options.store;
    this.#getNode = options.getNode;
    this.#canProcess = options.canProcess ?? (() => true);
    this.#now = options.now ?? (() => new Date());
    this.#onError = options.onError ?? (() => undefined);
    this.#onProcessed = options.onProcessed ?? (() => undefined);
    this.#retryIntervalMs = options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS;
    this.#maxBatchSize = options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
    if (!Number.isSafeInteger(this.#retryIntervalMs) || this.#retryIntervalMs < 1) {
      throw new Error("Observer inbox retry interval must be a positive integer");
    }
    if (!Number.isSafeInteger(this.#maxBatchSize) || this.#maxBatchSize < 1) {
      throw new Error("Observer inbox batch size must be a positive integer");
    }
  }

  start(): number {
    if (this.#started) return 0;
    this.#started = true;
    const recovered = this.#store.recoverObserverDeliveries(this.#now().toISOString());
    this.#retryTimer = setInterval(() => this.notify(), this.#retryIntervalMs);
    this.#retryTimer.unref?.();
    this.notify();
    return recovered;
  }

  notify(): void {
    if (!this.#started) return;
    this.#drainRequested = true;
    void this.processAvailable().catch((error: unknown) => this.#onError(error));
  }

  async processAvailable(): Promise<number> {
    if (!this.#started) return 0;
    if (this.#drainPromise) return await this.#drainPromise;
    const controller = new AbortController();
    this.#abortController = controller;
    const drain = this.#drain(controller.signal);
    this.#drainPromise = drain;
    try {
      return await drain;
    } finally {
      this.#drainPromise = null;
      if (this.#abortController === controller) this.#abortController = null;
      if (this.#started && this.#drainRequested) queueMicrotask(() => this.notify());
    }
  }

  async stop(): Promise<void> {
    this.#started = false;
    this.#drainRequested = false;
    if (this.#retryTimer) clearInterval(this.#retryTimer);
    this.#retryTimer = null;
    this.#abortController?.abort();
    await this.#drainPromise;
  }

  async #drain(signal: AbortSignal): Promise<number> {
    let processed = 0;
    while (this.#started && this.#drainRequested) {
      this.#drainRequested = false;
      if (!this.#canProcess()) return processed;
      let batchAttempts = 0;
      for (let batchIndex = 0; batchIndex < this.#maxBatchSize && this.#started; batchIndex += 1) {
        const now = this.#now().toISOString();
        const delivery = this.#store.claimNextObserverDelivery(now);
        if (!delivery) break;
        batchAttempts += 1;
        try {
          const outcome = await verifyObserverDelivery(delivery, this.#getNode(), signal);
          const completedAt = this.#now().toISOString();
          if (outcome.action === "retry") {
            const nextAttemptAt = new Date(
              Date.parse(completedAt) + this.#retryIntervalMs,
            ).toISOString();
            const retryFailure = this.#returnToQueue({
              deliveryId: delivery.deliveryId,
              reason: outcome.reason,
              retriedAt: completedAt,
              nextAttemptAt,
            });
            if (retryFailure) {
              this.#drainRequested = false;
              if (!signal.aborted) this.#onError(retryFailure);
              return processed;
            }
            continue;
          }
          this.#store.finishObserverDelivery({
            deliveryId: delivery.deliveryId,
            state: outcome.state,
            reason: outcome.reason,
            completedAt,
          });
          try {
            this.#onProcessed(delivery, outcome);
          } catch (error) {
            // The delivery is already durably complete. Startup anti-entropy and the periodic
            // reconciler close this follow-up scheduling gap without replaying the callback.
            this.#onError(error);
          }
          processed += 1;
        } catch (error) {
          const retriedAt = this.#now().toISOString();
          const retryFailure = this.#returnToQueue({
            deliveryId: delivery.deliveryId,
            reason: safeErrorReason(error),
            retriedAt,
            nextAttemptAt: new Date(Date.parse(retriedAt) + this.#retryIntervalMs).toISOString(),
          });
          this.#drainRequested = false;
          if (!signal.aborted) {
            this.#onError(
              retryFailure
                ? new AggregateError(
                    [error, retryFailure],
                    "Observer verification failed and its targeted retry update was recovered",
                  )
                : error,
            );
          }
          return processed;
        }
      }
      if (batchAttempts === this.#maxBatchSize) {
        this.#drainRequested = true;
      }
    }
    return processed;
  }

  #returnToQueue(input: Parameters<ObserverInboxStore["retryObserverDelivery"]>[0]): Error | null {
    try {
      this.#store.retryObserverDelivery(input);
      return null;
    } catch (retryError) {
      try {
        // A targeted retry update can fail after a transient store fault. Recover every processing
        // claim immediately so this process does not require a restart to make the row eligible.
        this.#store.recoverObserverDeliveries(input.retriedAt);
      } catch (recoveryError) {
        return new AggregateError(
          [retryError, recoveryError],
          "Observer delivery could not be returned to the durable queue",
        );
      }
      return retryError instanceof Error ? retryError : new Error(String(retryError));
    }
  }
}
