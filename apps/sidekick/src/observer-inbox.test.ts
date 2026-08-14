import { describe, expect, it, vi } from "vitest";
import type { NodeHeader, NodeInfo, StacksNodeClient } from "./chain-clients.js";
import {
  ObserverInboxProcessor,
  stacksBlockHeaderHash,
  stacksIndexBlockHash,
  verifyObserverDelivery,
} from "./observer-inbox.js";
import { openSidekickStore, type StoredObserverDelivery } from "./storage/store.js";

const firstObservedAt = "2026-08-13T12:00:00.000Z";
const processedAt = "2026-08-13T12:00:01.000Z";
const consensusOne = "11".repeat(20);
const consensusTwo = "22".repeat(20);

function header(serialized: string, consensusHash: string, parentBlockId: string): NodeHeader {
  return {
    header: serialized,
    consensus_hash: consensusHash,
    parent_block_id: parentBlockId as `0x${string}`,
  };
}

const ancestorHeader = header("020304", consensusTwo, `0x${"33".repeat(32)}`);
const ancestorBlockHash = stacksBlockHeaderHash(ancestorHeader.header);
const ancestorIndexBlockHash = stacksIndexBlockHash({
  blockHash: ancestorBlockHash,
  consensusHash: ancestorHeader.consensus_hash,
});
const tipHeader = header("010203", consensusOne, ancestorIndexBlockHash);
const tipIndexBlockHash = stacksIndexBlockHash({
  blockHash: stacksBlockHeaderHash(tipHeader.header),
  consensusHash: tipHeader.consensus_hash,
});
const stableNodeInfo: NodeInfo = {
  network_id: 1,
  burn_block_height: 962_300,
  stacks_tip_height: 101,
  stacks_tip: tipIndexBlockHash,
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
    getHeaders?: StacksNodeClient["getHeaders"];
  } = {},
): Pick<StacksNodeClient, "getInfo" | "getHeaders"> {
  return {
    getInfo: overrides.getInfo ?? vi.fn(async () => stableNodeInfo),
    getHeaders: overrides.getHeaders ?? vi.fn(async () => [tipHeader, ancestorHeader]),
  };
}

describe("observer inbox verification", () => {
  it("promotes a callback only after proving its header on a stable canonical node ancestry", async () => {
    const getInfo = vi.fn(async () => stableNodeInfo);
    const getHeaders = vi.fn(async () => [tipHeader, ancestorHeader]);

    await expect(
      verifyObserverDelivery(delivery(), node({ getInfo, getHeaders })),
    ).resolves.toEqual({
      action: "finish",
      state: "node-verified",
      reason: "canonical-stacks-header-verified;embedded-events-remain-untrusted",
    });
    expect(getInfo).toHaveBeenCalledTimes(2);
    expect(getHeaders).toHaveBeenCalledWith(2, { tip: tipIndexBlockHash });
  });

  it("quarantines forged block and index claims without trusting callback events", async () => {
    await expect(
      verifyObserverDelivery(
        delivery({
          claimedBlockHash: `0x${"aa".repeat(32)}`,
          claimedIndexBlockHash: `0x${"bb".repeat(32)}`,
        }),
        node(),
      ),
    ).resolves.toMatchObject({ action: "finish", state: "quarantined" });
  });

  it("retries when the canonical tip changes while the proof is being read", async () => {
    const changedInfo = {
      ...stableNodeInfo,
      stacks_tip_height: 102,
      stacks_tip: `0x${"44".repeat(32)}` as `0x${string}`,
    };
    const getInfo = vi.fn<StacksNodeClient["getInfo"]>();
    getInfo.mockResolvedValueOnce(stableNodeInfo).mockResolvedValueOnce(changedInfo);

    await expect(verifyObserverDelivery(delivery(), node({ getInfo }))).resolves.toMatchObject({
      action: "retry",
      reason: "canonical-node-tip-changed-during-proof",
    });
  });

  it("retries future claims and expires claims outside the node header proof window", async () => {
    await expect(
      verifyObserverDelivery(delivery({ claimedBlockHeight: 102 }), node()),
    ).resolves.toMatchObject({
      action: "retry",
      reason: "node-has-not-reached-claimed-stacks-height",
    });
    await expect(
      verifyObserverDelivery(delivery({ claimedBlockHeight: 0 }), {
        getInfo: vi.fn(async () => ({ ...stableNodeInfo, stacks_tip_height: 2_100 })),
        getHeaders: vi.fn(),
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
  it("recovers an interrupted claim and processes it exactly once after restart", async () => {
    const { store } = await openSidekickStore(":memory:", firstObservedAt);
    try {
      store.acceptObserverDelivery({
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
      expect(store.claimNextObserverDelivery(processedAt)).not.toBeNull();
      expect(store.observerInboxStatus()).toMatchObject({ processing: 1, queueDepth: 0 });

      const processor = new ObserverInboxProcessor({
        store,
        getNode: () => node(),
        now: () => new Date(processedAt),
        retryIntervalMs: 60_000,
        maxBatchSize: 1,
      });
      expect(processor.start()).toBe(1);
      await processor.processAvailable();
      expect(store.observerInboxStatus()).toMatchObject({
        queueDepth: 0,
        processing: 0,
        nodeVerified: 1,
        processingAttempts: 2,
        lastProcessedAt: processedAt,
      });
      await processor.stop();
    } finally {
      store.close();
    }
  });

  it("returns a failed node verification to the durable queue for a later retry", async () => {
    const { store } = await openSidekickStore(":memory:", firstObservedAt);
    const onError = vi.fn();
    try {
      store.acceptObserverDelivery({
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
        store,
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
      expect(store.observerInboxStatus()).toMatchObject({
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

  it("defers a future claim without head-of-line blocking a verifiable callback", async () => {
    const { store } = await openSidekickStore(":memory:", firstObservedAt);
    try {
      store.acceptObserverDelivery({
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
      store.acceptObserverDelivery({
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
        store,
        getNode: () => node(),
        now: () => new Date(processedAt),
        retryIntervalMs: 60_000,
        maxBatchSize: 1,
      });
      processor.start();
      await processor.processAvailable();
      expect(store.observerInboxStatus()).toMatchObject({
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
