import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createChainSourceId, openSidekickStore, type SidekickStore } from "./store.js";

const observedAt = "2026-07-14T12:00:00.000Z";
const later = "2026-07-14T12:01:00.000Z";
const txId = `0x${"11".repeat(32)}`;
const blockHash = `0x${"22".repeat(32)}`;
const indexBlockHash = `0x${"33".repeat(32)}`;
const sourceId = createChainSourceId("mainnet", "https://api.mainnet.hiro.so");
const openStores: SidekickStore[] = [];
const temporaryDirectories: string[] = [];

async function memoryStore(): Promise<SidekickStore> {
  const { store } = await openSidekickStore(":memory:", observedAt);
  openStores.push(store);
  return store;
}

function registerSource(store: SidekickStore, id = sourceId): void {
  store.upsertChainSource({
    sourceId: id,
    kind: "api",
    network: "mainnet",
    baseUrl: "https://api.mainnet.hiro.so",
    observedAt,
  });
}

afterEach(async () => {
  for (const store of openStores.splice(0)) store.close();
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("Sidekick SQLite store", () => {
  it("applies explicit migrations with defensive runtime pragmas", async () => {
    const store = await memoryStore();

    expect(store.databaseStatus()).toEqual({
      schemaVersion: 1,
      journalMode: "memory",
      foreignKeys: true,
    });
  });

  it("keeps durable cursors isolated by API source identity", async () => {
    const store = await memoryStore();
    const otherSource = createChainSourceId("mainnet", "https://stacks-api.example.com/");
    registerSource(store);
    store.upsertChainSource({
      sourceId: otherSource,
      kind: "api",
      network: "mainnet",
      baseUrl: "https://stacks-api.example.com",
      observedAt,
    });
    store.putCursor({
      sourceId,
      stream: `signer-stakers:${txId}`,
      cursor: "SP000000000000000000002Q6VF78",
      lastBlockHeight: 8_600_000,
      lastIndexBlockHash: indexBlockHash,
      updatedAt: observedAt,
    });

    expect(store.getCursor(sourceId, `signer-stakers:${txId}`)).toMatchObject({
      cursor: "SP000000000000000000002Q6VF78",
      lastBlockHeight: 8_600_000,
    });
    expect(store.getCursor(otherSource, `signer-stakers:${txId}`)).toBeNull();
    expect(createChainSourceId("mainnet", "https://api.mainnet.hiro.so/")).toBe(sourceId);
  });

  it("does not allow a source ID to be rebound to a different provider", async () => {
    const store = await memoryStore();
    registerSource(store);

    expect(() =>
      store.upsertChainSource({
        sourceId,
        kind: "api",
        network: "mainnet",
        baseUrl: "https://different.example.com",
        observedAt: later,
      }),
    ).toThrow("already bound to different metadata");
  });

  it("upserts replayed chain evidence without losing first-seen history", async () => {
    const store = await memoryStore();
    registerSource(store);
    store.putChainEvent({
      chainId: 1,
      txId,
      eventIndex: 3,
      blockHeight: 8_600_000,
      blockHash,
      indexBlockHash,
      microblockHash: null,
      microblockSequence: null,
      canonical: true,
      microblockCanonical: true,
      contractId: "SP000000000000000000002Q6VF78.pox-5",
      topic: "stake",
      rawPayload: { amount_ustx: "50000000000" },
      decodedSchemaVersion: 1,
      decodedPayload: { amountUstx: "50000000000" },
      sourceId,
      observedAt,
    });
    store.putChainEvent({
      chainId: 1,
      txId,
      eventIndex: 3,
      blockHeight: 8_600_001,
      blockHash: `0x${"44".repeat(32)}`,
      indexBlockHash: `0x${"55".repeat(32)}`,
      microblockHash: null,
      microblockSequence: null,
      canonical: false,
      microblockCanonical: true,
      contractId: "SP000000000000000000002Q6VF78.pox-5",
      topic: "stake",
      rawPayload: { amount_ustx: "51000000000" },
      decodedSchemaVersion: 1,
      decodedPayload: { amountUstx: "51000000000" },
      sourceId,
      observedAt: later,
    });

    expect(store.getChainEvent(1, txId, 3)).toMatchObject({
      blockHeight: 8_600_001,
      canonical: false,
      rawPayload: { amount_ustx: "51000000000" },
      decodedPayload: { amountUstx: "51000000000" },
      firstSeenAt: observedAt,
      updatedAt: later,
    });
  });

  it("marks all evidence from a displaced index block non-canonical", async () => {
    const store = await memoryStore();
    registerSource(store);
    for (const eventIndex of [0, 1]) {
      store.putChainEvent({
        chainId: 1,
        txId,
        eventIndex,
        blockHeight: 8_600_000,
        blockHash,
        indexBlockHash,
        microblockHash: null,
        microblockSequence: null,
        canonical: true,
        microblockCanonical: true,
        contractId: null,
        topic: null,
        rawPayload: { eventIndex },
        decodedSchemaVersion: null,
        decodedPayload: null,
        sourceId,
        observedAt,
      });
    }

    expect(store.markIndexBlockNonCanonical(1, indexBlockHash, later)).toBe(2);
    expect(store.getChainEvent(1, txId, 0)).toMatchObject({ canonical: false, updatedAt: later });
  });

  it("backs up an existing database before the first forward migration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "signer-sidekick-store-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "sidekick.sqlite");
    const existing = new DatabaseSync(path);
    existing.exec("CREATE TABLE legacy (value TEXT)");
    existing.close();

    const result = await openSidekickStore(path, observedAt);
    openStores.push(result.store);

    expect(result.backupPath).not.toBeNull();
    expect((await stat(result.backupPath as string)).isFile()).toBe(true);
    expect(result.store.databaseStatus()).toMatchObject({
      schemaVersion: 1,
      journalMode: "wal",
    });
  });

  it("refuses a database whose schema version has no migration ledger", async () => {
    const directory = await mkdtemp(join(tmpdir(), "signer-sidekick-corrupt-store-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "sidekick.sqlite");
    const existing = new DatabaseSync(path);
    existing.exec("PRAGMA user_version = 1");
    existing.close();

    await expect(openSidekickStore(path, observedAt)).rejects.toThrow(
      "migration ledger does not exist",
    );
  });

  it("rejects non-JSON evidence before it reaches SQLite", async () => {
    const store = await memoryStore();
    registerSource(store);

    expect(() =>
      store.putChainEvent({
        chainId: 1,
        txId,
        eventIndex: 0,
        blockHeight: 1,
        blockHash,
        indexBlockHash,
        microblockHash: null,
        microblockSequence: null,
        canonical: true,
        microblockCanonical: true,
        contractId: null,
        topic: null,
        rawPayload: { invalid: 1n },
        decodedSchemaVersion: null,
        decodedPayload: null,
        sourceId,
        observedAt,
      }),
    ).toThrow("rawPayload must be JSON-serializable");
  });

  it("requires decoded evidence and its schema version to move together", async () => {
    const store = await memoryStore();
    registerSource(store);

    expect(() =>
      store.putChainEvent({
        chainId: 1,
        txId,
        eventIndex: 0,
        blockHeight: 1,
        blockHash,
        indexBlockHash,
        microblockHash: null,
        microblockSequence: null,
        canonical: true,
        microblockCanonical: true,
        contractId: null,
        topic: null,
        rawPayload: {},
        decodedSchemaVersion: null,
        decodedPayload: { topic: "stake" },
        sourceId,
        observedAt,
      }),
    ).toThrow("decodedSchemaVersion and decodedPayload must either both be present");
  });
});
