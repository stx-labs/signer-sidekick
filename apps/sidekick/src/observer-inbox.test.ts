import { describe, expect, it, vi } from "vitest";
import type { NodeInfo, NodeTenureInfo, StacksNodeClient } from "./chain-clients.js";
import { ObserverInboxProcessor, verifyObserverDelivery } from "./observer-inbox.js";
import type { StoredObserverDelivery } from "./storage/observer-inbox-repository.js";
import { openSidekickStore } from "./storage/store.js";

const firstObservedAt = "2026-08-13T12:00:00.000Z";
const processedAt = "2026-08-13T12:00:01.000Z";
const ancestorBlockHash = `0x${"22".repeat(32)}`;
const ancestorIndexBlockHash = `0x${"33".repeat(32)}`;
const tipIndexBlockHash = `0x${"44".repeat(32)}`;
const canonicalBlock = Uint8Array.of(1, 2, 3, 4);
const stableNodeInfo: NodeInfo = {
  network_id: 1,
  burn_block_height: 962_300,
  stacks_tip_height: 101,
  stacks_tip: tipIndexBlockHash,
};
const stableTenureInfo: NodeTenureInfo = {
  tip_block_id: tipIndexBlockHash,
  tip_height: 101,
  reward_cycle: 141,
};

function delivery(overrides: Partial<StoredObserverDelivery> = {}): StoredObserverDelivery {
  return {
    deliveryId: "10000000-0000-4000-8000-000000000001",
    endpointKind: "new-block",
    rawPayloadJson: "{}",
    claimedBlockHeight: 100,
    claimedBlockHash: ancestorBlockHash,
    claimedIndexBlockHash: ancestorIndexBlockHash,
    claimedBurnBlockHeight: null,
    claimedBurnBlockHash: null,
    processingAttempts: 1,
    firstReceivedAt: firstObservedAt,
    lastReceivedAt: firstObservedAt,
    lastProcessingAt: processedAt,
    ...overrides,
  };
}

function node(
  overrides: {
    getInfo?: StacksNodeClient["getInfo"];
    getTenureInfo?: StacksNodeClient["getTenureInfo"];
    getNakamotoBlockById?: StacksNodeClient["getNakamotoBlockById"];
    getNakamotoBlockAtHeight?: StacksNodeClient["getNakamotoBlockAtHeight"];
  } = {},
): Pick<
  StacksNodeClient,
  "getInfo" | "getTenureInfo" | "getNakamotoBlockById" | "getNakamotoBlockAtHeight"
> {
  return {
    getInfo: overrides.getInfo ?? vi.fn(async () => stableNodeInfo),
    getTenureInfo: overrides.getTenureInfo ?? vi.fn(async () => stableTenureInfo),
    getNakamotoBlockById: overrides.getNakamotoBlockById ?? vi.fn(async () => canonicalBlock),
    getNakamotoBlockAtHeight:
      overrides.getNakamotoBlockAtHeight ?? vi.fn(async () => canonicalBlock),
  };
}

describe("observer inbox verification", () => {
  it("promotes a callback only after its node block equals the canonical block at that height", async () => {
    const getInfo = vi.fn(async () => stableNodeInfo);
    const getTenureInfo = vi.fn(async () => stableTenureInfo);
    const getNakamotoBlockById = vi.fn(async () => canonicalBlock);
    const getNakamotoBlockAtHeight = vi.fn(async () => canonicalBlock);

    await expect(
      verifyObserverDelivery(
        delivery(),
        node({ getInfo, getTenureInfo, getNakamotoBlockById, getNakamotoBlockAtHeight }),
      ),
    ).resolves.toEqual({
      action: "finish",
      state: "node-verified",
      reason:
        "canonical-stacks-index-block-verified;callback-block-hash-and-events-remain-untrusted",
    });
    expect(getInfo).toHaveBeenCalledTimes(2);
    expect(getTenureInfo).toHaveBeenCalledTimes(2);
    expect(getNakamotoBlockById).toHaveBeenCalledWith(ancestorIndexBlockHash, {});
    expect(getNakamotoBlockAtHeight).toHaveBeenCalledWith(100, {
      tip: tipIndexBlockHash,
    });
  });

  it("quarantines an index claim whose node block is not canonical at the claimed height", async () => {
    await expect(
      verifyObserverDelivery(
        delivery({ claimedIndexBlockHash: `0x${"bb".repeat(32)}` }),
        node({ getNakamotoBlockById: vi.fn(async () => Uint8Array.of(9, 9, 9)) }),
      ),
    ).resolves.toMatchObject({
      action: "finish",
      state: "quarantined",
      reason: "callback-index-block-does-not-match-canonical-node-block-at-height",
    });
  });

  it("retries when the canonical tip changes while the proof is being read", async () => {
    const changedInfo = {
      ...stableNodeInfo,
      stacks_tip_height: 102,
      stacks_tip: `0x${"44".repeat(32)}` as `0x${string}`,
    };
    const changedTenure = {
      ...stableTenureInfo,
      tip_height: 102,
      tip_block_id: `0x${"55".repeat(32)}` as `0x${string}`,
    };
    const getInfo = vi
      .fn<StacksNodeClient["getInfo"]>()
      .mockResolvedValueOnce(stableNodeInfo)
      .mockResolvedValueOnce(changedInfo);
    const getTenureInfo = vi
      .fn<StacksNodeClient["getTenureInfo"]>()
      .mockResolvedValueOnce(stableTenureInfo)
      .mockResolvedValueOnce(changedTenure);

    await expect(
      verifyObserverDelivery(delivery(), node({ getInfo, getTenureInfo })),
    ).resolves.toMatchObject({
      action: "retry",
      reason: "canonical-node-tip-changed-during-proof",
    });
  });

  it("bounds future claims and expires claims outside the node proof window", async () => {
    await expect(
      verifyObserverDelivery(delivery({ claimedBlockHeight: 102 }), node()),
    ).resolves.toMatchObject({
      action: "retry",
      reason: "node-has-not-reached-claimed-stacks-height",
    });
    await expect(
      verifyObserverDelivery(delivery({ claimedBlockHeight: 1_000_000 }), node()),
    ).resolves.toMatchObject({
      action: "finish",
      state: "quarantined",
      reason: "claimed-stacks-height-unreasonably-ahead-of-node",
    });
    await expect(
      verifyObserverDelivery(delivery({ claimedBlockHeight: 0 }), {
        getInfo: vi.fn(async () => ({ ...stableNodeInfo, stacks_tip_height: 2_100 })),
        getTenureInfo: vi.fn(async () => ({ ...stableTenureInfo, tip_height: 2_100 })),
        getNakamotoBlockById: vi.fn(),
        getNakamotoBlockAtHeight: vi.fn(),
      }),
    ).resolves.toMatchObject({
      action: "finish",
      state: "expired",
      reason: "outside-local-header-proof-window",
    });
  });

  it("uses burn callbacks as triggers without claiming local hash verification", async () => {
    const burnDelivery = delivery({
      endpointKind: "new-burn-block",
      claimedBlockHeight: null,
      claimedBlockHash: null,
      claimedIndexBlockHash: null,
      claimedBurnBlockHeight: 962_300,
      claimedBurnBlockHash: `0x${"55".repeat(32)}`,
    });
    await expect(verifyObserverDelivery(burnDelivery, node())).resolves.toEqual({
      action: "finish",
      state: "expired",
      reason: "trigger-consumed;burn-block-hash-not-locally-verifiable",
    });
    await expect(
      verifyObserverDelivery({ ...burnDelivery, claimedBurnBlockHeight: 962_301 }, node()),
    ).resolves.toMatchObject({
      action: "retry",
      reason: "node-has-not-reached-claimed-burn-height",
    });
  });
});

describe("observer inbox processor", () => {
  it("leaves durable callbacks unclaimed while the deployment connection is blocked", async () => {
    const { store } = await openSidekickStore(":memory:", firstObservedAt);
    let connected = false;
    try {
      store.observerInbox.acceptDelivery({
        endpointKind: "new-block",
        contentSha256: "99".repeat(32),
        rawPayloadJson: "{}",
        payloadBytes: 2,
        state: "observer-claimed",
        stateReason: null,
        claimedBlockHeight: 100,
        claimedBlockHash: ancestorBlockHash,
        claimedIndexBlockHash: ancestorIndexBlockHash,
        claimedBurnBlockHeight: null,
        claimedBurnBlockHash: null,
        receivedAt: firstObservedAt,
      });
      const processor = new ObserverInboxProcessor({
        store: store.observerInbox,
        getNode: () => node(),
        canProcess: () => connected,
        now: () => new Date(processedAt),
        retryIntervalMs: 60_000,
      });
      processor.start();
      await processor.processAvailable();
      expect(store.observerInbox.status()).toMatchObject({
        queueDepth: 1,
        processing: 0,
        processingAttempts: 0,
      });

      connected = true;
      processor.notify();
      await processor.processAvailable();
      expect(store.observerInbox.status()).toMatchObject({
        queueDepth: 0,
        processing: 0,
        nodeVerified: 1,
        processingAttempts: 1,
      });
      await processor.stop();
    } finally {
      store.close();
    }
  });

  it("recovers an interrupted claim and processes it exactly once after restart", async () => {
    const { store } = await openSidekickStore(":memory:", firstObservedAt);
    const onProcessed = vi.fn();
    try {
      store.observerInbox.acceptDelivery({
        endpointKind: "new-block",
        contentSha256: "aa".repeat(32),
        rawPayloadJson: "{}",
        payloadBytes: 2,
        state: "observer-claimed",
        stateReason: null,
        claimedBlockHeight: 100,
        claimedBlockHash: ancestorBlockHash,
        claimedIndexBlockHash: ancestorIndexBlockHash,
        claimedBurnBlockHeight: null,
        claimedBurnBlockHash: null,
        receivedAt: firstObservedAt,
      });
      expect(store.observerInbox.claimNextDelivery(processedAt)).not.toBeNull();
      expect(store.observerInbox.status()).toMatchObject({ processing: 1, queueDepth: 0 });

      const processor = new ObserverInboxProcessor({
        store: store.observerInbox,
        getNode: () => node(),
        now: () => new Date(processedAt),
        retryIntervalMs: 60_000,
        maxBatchSize: 1,
        onProcessed,
      });
      expect(processor.start()).toBe(1);
      await processor.processAvailable();
      expect(store.observerInbox.status()).toMatchObject({
        queueDepth: 0,
        processing: 0,
        nodeVerified: 1,
        processingAttempts: 2,
        lastProcessedAt: processedAt,
        lastVerifiedStacksBlock: {
          height: 100,
          indexBlockHash: ancestorIndexBlockHash,
          receivedAt: firstObservedAt,
          verifiedAt: processedAt,
        },
      });
      expect(onProcessed).toHaveBeenCalledOnce();
      expect(onProcessed).toHaveBeenCalledWith(
        expect.objectContaining({ claimedBlockHeight: 100 }),
        expect.objectContaining({ action: "finish", state: "node-verified" }),
      );
      await processor.stop();
    } finally {
      store.close();
    }
  });

  it("returns a failed node verification to the durable queue for a later retry", async () => {
    const { store } = await openSidekickStore(":memory:", firstObservedAt);
    const onError = vi.fn();
    try {
      store.observerInbox.acceptDelivery({
        endpointKind: "new-block",
        contentSha256: "bb".repeat(32),
        rawPayloadJson: "{}",
        payloadBytes: 2,
        state: "observer-claimed",
        stateReason: null,
        claimedBlockHeight: 100,
        claimedBlockHash: ancestorBlockHash,
        claimedIndexBlockHash: ancestorIndexBlockHash,
        claimedBurnBlockHeight: null,
        claimedBurnBlockHash: null,
        receivedAt: firstObservedAt,
      });
      const processor = new ObserverInboxProcessor({
        store: store.observerInbox,
        getNode: () =>
          node({
            getInfo: vi.fn(async () => {
              throw new Error("node unavailable");
            }),
          }),
        now: () => new Date(processedAt),
        onError,
        retryIntervalMs: 60_000,
      });
      processor.start();
      await Promise.all([processor.processAvailable(), processor.processAvailable()]);
      expect(store.observerInbox.status()).toMatchObject({
        queueDepth: 1,
        processing: 0,
        nodeVerified: 0,
        processingAttempts: 1,
      });
      expect(onError).toHaveBeenCalledOnce();
      await processor.stop();
    } finally {
      store.close();
    }
  });

  it("recovers a processing claim immediately when its targeted retry update throws", async () => {
    const { store } = await openSidekickStore(":memory:", firstObservedAt);
    const onError = vi.fn();
    let nodeAvailable = false;
    try {
      store.observerInbox.acceptDelivery({
        endpointKind: "new-block",
        contentSha256: "be".repeat(32),
        rawPayloadJson: "{}",
        payloadBytes: 2,
        state: "observer-claimed",
        stateReason: null,
        claimedBlockHeight: 100,
        claimedBlockHash: ancestorBlockHash,
        claimedIndexBlockHash: ancestorIndexBlockHash,
        claimedBurnBlockHeight: null,
        claimedBurnBlockHash: null,
        receivedAt: firstObservedAt,
      });
      const retryDelivery = vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error("transient retry update failure");
        })
        .mockImplementation((input) => store.observerInbox.retryDelivery(input));
      const processor = new ObserverInboxProcessor({
        store: {
          claimNextDelivery: (claimedAt) => store.observerInbox.claimNextDelivery(claimedAt),
          finishDelivery: (input) => store.observerInbox.finishDelivery(input),
          recoverDeliveries: (recoveredAt) => store.observerInbox.recoverDeliveries(recoveredAt),
          retryDelivery,
        },
        getNode: () =>
          nodeAvailable
            ? node()
            : node({
                getInfo: vi.fn(async () => {
                  throw new Error("node unavailable");
                }),
              }),
        now: () => new Date(processedAt),
        onError,
        retryIntervalMs: 60_000,
      });
      processor.start();
      await processor.processAvailable();
      expect(store.observerInbox.status()).toMatchObject({ queueDepth: 1, processing: 0 });
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Observer verification failed and its targeted retry update was recovered",
        }),
      );

      nodeAvailable = true;
      processor.notify();
      await processor.processAvailable();
      expect(store.observerInbox.status()).toMatchObject({
        queueDepth: 0,
        processing: 0,
        nodeVerified: 1,
      });
      expect(retryDelivery).toHaveBeenCalledOnce();
      await processor.stop();
    } finally {
      store.close();
    }
  });

  it("defers a future claim without head-of-line blocking a verifiable callback", async () => {
    const { store } = await openSidekickStore(":memory:", firstObservedAt);
    try {
      store.observerInbox.acceptDelivery({
        endpointKind: "new-block",
        contentSha256: "cc".repeat(32),
        rawPayloadJson: '{"future":true}',
        payloadBytes: 15,
        state: "observer-claimed",
        stateReason: null,
        claimedBlockHeight: 102,
        claimedBlockHash: `0x${"66".repeat(32)}`,
        claimedIndexBlockHash: `0x${"77".repeat(32)}`,
        claimedBurnBlockHeight: null,
        claimedBurnBlockHash: null,
        receivedAt: firstObservedAt,
      });
      store.observerInbox.acceptDelivery({
        endpointKind: "new-block",
        contentSha256: "dd".repeat(32),
        rawPayloadJson: "{}",
        payloadBytes: 2,
        state: "observer-claimed",
        stateReason: null,
        claimedBlockHeight: 100,
        claimedBlockHash: ancestorBlockHash,
        claimedIndexBlockHash: ancestorIndexBlockHash,
        claimedBurnBlockHeight: null,
        claimedBurnBlockHash: null,
        receivedAt: "2026-08-13T12:00:00.500Z",
      });
      const processor = new ObserverInboxProcessor({
        store: store.observerInbox,
        getNode: () => node(),
        now: () => new Date(processedAt),
        retryIntervalMs: 60_000,
        maxBatchSize: 1,
      });
      processor.start();
      await processor.processAvailable();
      expect(store.observerInbox.status()).toMatchObject({
        queueDepth: 1,
        processing: 0,
        nodeVerified: 1,
        processingAttempts: 2,
      });
      await processor.stop();
    } finally {
      store.close();
    }
  });
});
