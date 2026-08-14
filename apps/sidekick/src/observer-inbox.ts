import { createHash } from "node:crypto";
import type { NodeHeader, NodeInfo, StacksNodeClient } from "./chain-clients.js";
import type { SidekickStore, StoredObserverDelivery } from "./storage/store.js";

const MAX_HEADER_PROOF_DEPTH = 2_100;
const DEFAULT_RETRY_INTERVAL_MS = 15_000;
const DEFAULT_MAX_BATCH_SIZE = 100;

type ObserverInboxStore = Pick<
  SidekickStore,
  | "claimNextObserverDelivery"
  | "finishObserverDelivery"
  | "recoverObserverDeliveries"
  | "retryObserverDelivery"
>;

type ObserverVerificationNode = Pick<StacksNodeClient, "getInfo" | "getHeaders">;

export type ObserverVerificationOutcome =
  | {
      action: "finish";
      state: "node-verified" | "quarantined" | "expired";
      reason: string;
    }
  | { action: "retry"; reason: string };

function sha512_256(bytes: Uint8Array): Buffer {
  return createHash("sha512-256").update(bytes).digest();
}

export function stacksBlockHeaderHash(serializedHeaderHex: string): `0x${string}` {
  const headerBytes = Buffer.from(serializedHeaderHex.replace(/^0x/i, ""), "hex");
  return `0x${sha512_256(headerBytes).toString("hex")}`;
}

export function stacksIndexBlockHash(input: {
  blockHash: string;
  consensusHash: string;
}): `0x${string}` {
  const blockHash = Buffer.from(input.blockHash.replace(/^0x/i, ""), "hex");
  const consensusHash = Buffer.from(input.consensusHash.replace(/^0x/i, ""), "hex");
  return `0x${sha512_256(Buffer.concat([blockHash, consensusHash])).toString("hex")}`;
}

function sameCanonicalTip(left: NodeInfo, right: NodeInfo): boolean {
  return (
    left.stacks_tip !== undefined &&
    left.stacks_tip === right.stacks_tip &&
    left.stacks_tip_height === right.stacks_tip_height
  );
}

function canonicalHeaderIds(
  headers: readonly NodeHeader[],
  tip: `0x${string}`,
): readonly `0x${string}`[] | null {
  const ids: `0x${string}`[] = [];
  for (const [index, header] of headers.entries()) {
    const blockHash = stacksBlockHeaderHash(header.header);
    const id = stacksIndexBlockHash({
      blockHash,
      consensusHash: header.consensus_hash,
    });
    const expected = index === 0 ? tip : headers[index - 1]?.parent_block_id;
    if (id !== expected) return null;
    ids.push(id);
  }
  return ids;
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

  const before = await node.getInfo({ ...(signal ? { signal } : {}) });
  if (!before.stacks_tip) return { action: "retry", reason: "node-tip-id-unavailable" };
  if (delivery.claimedBlockHeight > before.stacks_tip_height) {
    return { action: "retry", reason: "node-has-not-reached-claimed-stacks-height" };
  }

  const distance = before.stacks_tip_height - delivery.claimedBlockHeight;
  if (distance >= MAX_HEADER_PROOF_DEPTH) {
    return {
      action: "finish",
      state: "expired",
      reason: "outside-local-header-proof-window",
    };
  }

  const headers = await node.getHeaders(distance + 1, {
    tip: before.stacks_tip,
    ...(signal ? { signal } : {}),
  });
  const after = await node.getInfo({ ...(signal ? { signal } : {}) });
  if (!sameCanonicalTip(before, after)) {
    return { action: "retry", reason: "canonical-node-tip-changed-during-proof" };
  }
  if (headers.length !== distance + 1) {
    return { action: "retry", reason: "node-header-proof-incomplete" };
  }

  const canonicalIds = canonicalHeaderIds(headers, before.stacks_tip);
  if (!canonicalIds) {
    return { action: "retry", reason: "node-header-ancestry-inconsistent" };
  }
  const claimedHeader = headers[distance];
  const claimedCanonicalId = canonicalIds[distance];
  if (!claimedHeader || !claimedCanonicalId) {
    return { action: "retry", reason: "node-header-proof-incomplete" };
  }
  const canonicalBlockHash = stacksBlockHeaderHash(claimedHeader.header);
  if (
    canonicalBlockHash !== delivery.claimedBlockHash ||
    claimedCanonicalId !== delivery.claimedIndexBlockHash
  ) {
    return {
      action: "finish",
      state: "quarantined",
      reason: "callback-stacks-block-claim-does-not-match-canonical-node-header",
    };
  }
  return {
    action: "finish",
    state: "node-verified",
    reason: "canonical-stacks-header-verified;embedded-events-remain-untrusted",
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
  readonly #now: () => Date;
  readonly #onError: (error: unknown) => void;
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
    now?: () => Date;
    onError?: (error: unknown) => void;
    retryIntervalMs?: number;
    maxBatchSize?: number;
  }) {
    this.#store = options.store;
    this.#getNode = options.getNode;
    this.#now = options.now ?? (() => new Date());
    this.#onError = options.onError ?? (() => undefined);
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
            this.#store.retryObserverDelivery({
              deliveryId: delivery.deliveryId,
              reason: outcome.reason,
              retriedAt: completedAt,
              nextAttemptAt,
            });
            continue;
          }
          this.#store.finishObserverDelivery({
            deliveryId: delivery.deliveryId,
            state: outcome.state,
            reason: outcome.reason,
            completedAt,
          });
          processed += 1;
        } catch (error) {
          const retriedAt = this.#now().toISOString();
          this.#store.retryObserverDelivery({
            deliveryId: delivery.deliveryId,
            reason: safeErrorReason(error),
            retriedAt,
            nextAttemptAt: new Date(Date.parse(retriedAt) + this.#retryIntervalMs).toISOString(),
          });
          this.#drainRequested = false;
          if (!signal.aborted) this.#onError(error);
          return processed;
        }
      }
      if (batchAttempts === this.#maxBatchSize) {
        this.#drainRequested = true;
      }
    }
    return processed;
  }
}
