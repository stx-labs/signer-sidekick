import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createObserverServer,
  loadObserverServerConfig,
  observerRuntimeStatus,
  renderStacksEventObserverConfig,
} from "./observer-server.js";
import { openSidekickStore, type SidekickStore } from "./storage/store.js";

const blockHash = `0x${"11".repeat(32)}`;
const indexBlockHash = `0x${"22".repeat(32)}`;
const burnBlockHash = `0x${"33".repeat(32)}`;
const parentBurnBlockHash = `0x${"44".repeat(32)}`;
const opened: SidekickStore[] = [];

async function fixture() {
  const { store } = await openSidekickStore(":memory:", "2026-08-13T12:00:00.000Z");
  opened.push(store);
  const server = createObserverServer({
    store,
    maxBodyBytes: 4 * 1_024 * 1_024,
    now: () => new Date("2026-08-13T12:01:00.000Z"),
  });
  return { store, server };
}

afterEach(() => {
  for (const store of opened.splice(0)) store.close();
});

describe("observer server configuration", () => {
  it("defaults to a private bounded listener and supports an explicit disable", () => {
    expect(loadObserverServerConfig({})).toEqual({
      enabled: true,
      host: "127.0.0.1",
      port: 3700,
      maxBodyBytes: 4 * 1_024 * 1_024,
    });
    expect(
      loadObserverServerConfig({
        SIDEKICK_EVENT_HTTP_ENABLED: "false",
        SIDEKICK_EVENT_HTTP_HOST: "10.0.0.8",
        SIDEKICK_EVENT_HTTP_PORT: "3701",
        SIDEKICK_EVENT_MAX_BODY_BYTES: "8192",
      }),
    ).toEqual({ enabled: false, host: "10.0.0.8", port: 3701, maxBodyBytes: 8192 });
  });

  it("rejects ambiguous listener settings", () => {
    expect(() => loadObserverServerConfig({ SIDEKICK_EVENT_HTTP_ENABLED: "yes" })).toThrow(
      "SIDEKICK_EVENT_HTTP_ENABLED must be true or false",
    );
    expect(() => loadObserverServerConfig({ SIDEKICK_EVENT_HTTP_PORT: "0" })).toThrow(
      "SIDEKICK_EVENT_HTTP_PORT must be an integer from 1 through 65535",
    );
    expect(() => loadObserverServerConfig({ SIDEKICK_EVENT_MAX_BODY_BYTES: "512" })).toThrow(
      "SIDEKICK_EVENT_MAX_BODY_BYTES must be an integer from 1024 through 16777216",
    );
  });

  it("renders exact PoX-5 and attached-manager subscriptions for the operator's node", () => {
    expect(
      renderStacksEventObserverConfig({
        nodeReachableEndpoint: "sidekick-events:3700",
        pox5ContractId: "SP000000000000000000002Q6VF78.pox-5",
        managerPrincipal: "SP000000000000000000002Q6VF78.signer-manager",
      }),
    ).toEqual({
      observerToml: `[[events_observer]]
endpoint = "sidekick-events:3700"
events_keys = [
  "burn_blocks",
  "SP000000000000000000002Q6VF78.pox-5::print",
  "SP000000000000000000002Q6VF78.signer-manager::print",
]
timeout_ms = 5000
disable_retries = false`,
      nodeToml: `# Add these keys to the node's existing [node] table.
event_dispatcher_blocking = false
event_dispatcher_queue_size = 1000`,
    });
    expect(() =>
      renderStacksEventObserverConfig({
        nodeReachableEndpoint: "https://sidekick-events:3700/path",
        pox5ContractId: "SP000000000000000000002Q6VF78.pox-5",
        managerPrincipal: "SP000000000000000000002Q6VF78.signer-manager",
      }),
    ).toThrow("Observer endpoint must be a node-reachable host:port");
  });
});

describe("observer delivery ingress", () => {
  it("commits a new block claim before acknowledging and deduplicates retries", async () => {
    const { server, store } = await fixture();
    const payload = {
      block_hash: blockHash.toUpperCase().replace("0X", "0x"),
      block_height: 8_750_000,
      index_block_hash: indexBlockHash.toUpperCase().replace("0X", "0x"),
      events: [],
      transactions: [],
    };
    const first = await server.inject({ method: "POST", url: "/new_block", payload });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      accepted: true,
      duplicate: false,
      state: "observer-claimed",
    });
    expect(store.observerInboxStatus()).toMatchObject({
      uniqueDeliveries: 1,
      deliveryAttempts: 1,
      duplicates: 0,
      queueDepth: 1,
      lastClaimedStacksBlock: {
        height: 8_750_000,
        blockHash,
        indexBlockHash,
      },
    });

    const duplicate = await server.inject({ method: "POST", url: "/new_block", payload });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toMatchObject({
      deliveryId: first.json().deliveryId,
      duplicate: true,
      state: "observer-claimed",
    });
    expect(store.observerInboxStatus()).toMatchObject({
      uniqueDeliveries: 1,
      deliveryAttempts: 2,
      duplicates: 1,
      queueDepth: 1,
    });
    const sameChainBlock = await server.inject({
      method: "POST",
      url: "/new_block",
      payload: { ...payload, delivery_metadata: "changed-by-node-version" },
    });
    expect(sameChainBlock.json()).toMatchObject({
      deliveryId: first.json().deliveryId,
      duplicate: true,
      state: "quarantined",
    });
    expect(store.observerInboxStatus()).toMatchObject({
      uniqueDeliveries: 1,
      deliveryAttempts: 3,
      duplicates: 2,
      queueDepth: 0,
      quarantined: 1,
      lastQuarantine: { reason: "conflicting-callback-bodies-for-chain-position" },
    });
    const conflictingClaim = await server.inject({
      method: "POST",
      url: "/new_block",
      payload: { ...payload, block_hash: `0x${"99".repeat(32)}` },
    });
    expect(conflictingClaim.json()).toMatchObject({ duplicate: false, state: "quarantined" });
    expect(store.observerInboxStatus()).toMatchObject({
      uniqueDeliveries: 2,
      deliveryAttempts: 4,
      duplicates: 2,
      queueDepth: 0,
      quarantined: 2,
    });
    await server.close();
  });

  it("stores valid burn-block claims and quarantines wrong callback shapes", async () => {
    const { server, store } = await fixture();
    const valid = await server.inject({
      method: "POST",
      url: "/new_burn_block",
      payload: {
        burn_block_hash: burnBlockHash,
        burn_block_height: 962_300,
        consensus_hash: `0x${"55".repeat(20)}`,
        parent_burn_block_hash: parentBurnBlockHash,
      },
    });
    expect(valid.statusCode).toBe(200);
    expect(valid.json()).toMatchObject({ state: "observer-claimed" });

    const invalid = await server.inject({
      method: "POST",
      url: "/new_block",
      payload: { block_height: "not-an-integer" },
    });
    expect(invalid.statusCode).toBe(200);
    expect(invalid.json()).toMatchObject({ state: "quarantined" });
    expect(store.observerInboxStatus()).toMatchObject({
      queueDepth: 1,
      quarantined: 1,
      lastClaimedBurnBlock: { height: 962_300, blockHash: burnBlockHash },
      lastQuarantine: {
        endpointKind: "new-block",
        reason: expect.stringContaining("invalid-payload-shape"),
      },
    });
    await server.close();
  });

  it("durably expires implicit attachments so Stacks Core will not retry them", async () => {
    const { server, store } = await fixture();
    const response = await server.inject({
      method: "POST",
      url: "/attachments/new",
      payload: [{ attachment_index: 1 }],
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ state: "expired" });
    expect(store.observerInboxStatus()).toMatchObject({ expired: 1, queueDepth: 0 });
    await server.close();
  });

  it("rejects undocumented paths, malformed JSON, wrong media types, and oversized bodies", async () => {
    const { server, store } = await fixture();
    expect(
      (await server.inject({ method: "POST", url: "/new_mempool_tx", payload: [] })).statusCode,
    ).toBe(404);
    expect(
      (
        await server.inject({
          method: "POST",
          url: "/new_block",
          headers: { "content-type": "application/json" },
          payload: "{",
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await server.inject({
          method: "POST",
          url: "/new_block",
          headers: { "content-type": "text/plain" },
          payload: "{}",
        })
      ).statusCode,
    ).toBe(415);
    expect(store.observerInboxStatus().uniqueDeliveries).toBe(0);
    await server.close();

    const bounded = createObserverServer({
      store,
      maxBodyBytes: 1_024,
    });
    expect(
      (
        await bounded.inject({
          method: "POST",
          url: "/new_block",
          headers: { "content-type": "application/json" },
          payload: JSON.stringify({ padding: "x".repeat(2_000) }),
        })
      ).statusCode,
    ).toBe(413);
    await bounded.close();
  });

  it("does not acknowledge when the durable inbox commit fails", async () => {
    const acceptObserverDelivery = vi.fn(() => {
      throw new Error("database unavailable");
    });
    const server = createObserverServer({
      store: { acceptObserverDelivery },
      maxBodyBytes: 4 * 1_024 * 1_024,
    });
    const response = await server.inject({
      method: "POST",
      url: "/new_block",
      payload: {
        block_hash: blockHash,
        block_height: 1,
        index_block_hash: indexBlockHash,
        events: [],
        transactions: [],
      },
    });
    expect(response.statusCode).toBe(500);
    expect(acceptObserverDelivery).toHaveBeenCalledOnce();
    await server.close();
  });

  it("bounds retained raw callback JSON while preserving terminal delivery evidence", async () => {
    const { store, server } = await fixture();
    const oldPayload = '{"old":true}';
    const currentPayload = '{"current":true}';
    store.acceptObserverDelivery({
      endpointKind: "attachments",
      contentSha256: "aa".repeat(32),
      rawPayloadJson: oldPayload,
      payloadBytes: Buffer.byteLength(oldPayload),
      state: "expired",
      stateReason: "implicit-attachment-callback-not-used",
      claimedBlockHeight: null,
      claimedBlockHash: null,
      claimedIndexBlockHash: null,
      claimedBurnBlockHeight: null,
      claimedBurnBlockHash: null,
      receivedAt: "2026-08-11T12:00:00.000Z",
    });
    store.acceptObserverDelivery({
      endpointKind: "attachments",
      contentSha256: "bb".repeat(32),
      rawPayloadJson: currentPayload,
      payloadBytes: Buffer.byteLength(currentPayload),
      state: "expired",
      stateReason: "implicit-attachment-callback-not-used",
      claimedBlockHeight: null,
      claimedBlockHash: null,
      claimedIndexBlockHash: null,
      claimedBurnBlockHeight: null,
      claimedBurnBlockHash: null,
      receivedAt: "2026-08-13T12:00:00.000Z",
    });

    expect(store.observerInboxStatus()).toMatchObject({
      uniqueDeliveries: 2,
      expired: 2,
      prunedPayloads: 1,
      retainedPayloadBytes: Buffer.byteLength(currentPayload),
    });
    await server.close();
  });

  it("reports disabled listener state separately from its durable inbox", async () => {
    const { store } = await fixture();
    expect(
      observerRuntimeStatus(
        { enabled: false, host: "127.0.0.1", port: 3700, maxBodyBytes: 4_194_304 },
        store.observerInboxStatus(),
      ),
    ).toMatchObject({ enabled: false, listener: null, inbox: { queueDepth: 0 } });
  });
});
