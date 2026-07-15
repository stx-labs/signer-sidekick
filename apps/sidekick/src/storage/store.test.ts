import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  createChainSourceId,
  createNodeSourceId,
  openSidekickStore,
  type SidekickStore,
} from "./store.js";

const observedAt = "2026-07-14T12:00:00.000Z";
const later = "2026-07-14T12:01:00.000Z";
const txId = `0x${"11".repeat(32)}`;
const blockHash = `0x${"22".repeat(32)}`;
const indexBlockHash = `0x${"33".repeat(32)}`;
const sourceId = createChainSourceId("mainnet", "https://api.mainnet.hiro.so");
const nodeSourceId = createNodeSourceId("mainnet", "http://127.0.0.1:20443");
const manager = "SP000000000000000000002Q6VF78.signer-manager";
const stakerOne = "SP000000000000000000002Q6VF78";
const stakerTwo = "SP2JXKMSH007NPYAQHKJPQMAQYAD90NQGTVJVQ02B";
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

function registerNodeSource(store: SidekickStore): void {
  store.upsertChainSource({
    sourceId: nodeSourceId,
    kind: "node",
    network: "mainnet",
    baseUrl: "http://127.0.0.1:20443",
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
      schemaVersion: 2,
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

  it("projects node-verified positions into exact reward-cycle memberships", async () => {
    const store = await memoryStore();
    registerSource(store);
    registerNodeSource(store);
    const run = store.startOrResumeSignerStakerRun(sourceId, manager, observedAt);

    const completed = store.commitSignerStakerPage({
      runId: run.runId,
      sourceId,
      nodeSourceId,
      managerPrincipal: manager,
      nextCursor: null,
      items: [
        {
          stakerPrincipal: stakerOne,
          hasStx: true,
          hasBtc: false,
          stxNodeVerified: true,
          position: {
            signerPrincipal: manager,
            amountUstx: 50_000_000_000n,
            firstRewardCycle: 141n,
            numCycles: 3n,
            cycleMemberships: [
              { rewardCycle: 141n, signerPrincipal: manager, amountUstx: 49_000_000_000n },
              { rewardCycle: 142n, signerPrincipal: manager, amountUstx: 50_000_000_000n },
              { rewardCycle: 143n, signerPrincipal: manager, amountUstx: 50_000_000_000n },
            ],
          },
        },
      ],
      observedAt,
      burnBlockHeight: 960_240,
      stacksTipHeight: 8_600_000,
    });

    expect(completed).toMatchObject({ status: "completed", pagesProcessed: 1 });
    expect(store.listSignerStakers(manager)).toMatchObject([
      {
        stakerPrincipal: stakerOne,
        stxNodeVerified: true,
        position: {
          amountUstx: 50_000_000_000n,
          firstRewardCycle: 141n,
          numCycles: 3n,
          unlockCycle: 144n,
          active: true,
        },
      },
    ]);
    expect(store.listCycleMemberships(manager)).toEqual([
      {
        stakerPrincipal: stakerOne,
        rewardCycle: 141n,
        signerPrincipal: manager,
        amountUstx: 49_000_000_000n,
        active: true,
      },
      {
        stakerPrincipal: stakerOne,
        rewardCycle: 142n,
        signerPrincipal: manager,
        amountUstx: 50_000_000_000n,
        active: true,
      },
      {
        stakerPrincipal: stakerOne,
        rewardCycle: 143n,
        signerPrincipal: manager,
        amountUstx: 50_000_000_000n,
        active: true,
      },
    ]);
  });

  it("resumes partial scans without deactivating unseen members until completion", async () => {
    const store = await memoryStore();
    registerSource(store);
    registerNodeSource(store);
    const seed = store.startOrResumeSignerStakerRun(sourceId, manager, observedAt);
    store.commitSignerStakerPage({
      runId: seed.runId,
      sourceId,
      nodeSourceId,
      managerPrincipal: manager,
      nextCursor: null,
      items: [
        {
          stakerPrincipal: stakerOne,
          hasStx: true,
          hasBtc: false,
          stxNodeVerified: false,
          position: null,
        },
        {
          stakerPrincipal: stakerTwo,
          hasStx: false,
          hasBtc: true,
          stxNodeVerified: null,
          position: null,
        },
      ],
      observedAt,
      burnBlockHeight: 960_240,
      stacksTipHeight: 8_600_000,
    });

    const partial = store.startOrResumeSignerStakerRun(sourceId, manager, later);
    const checkpoint = store.commitSignerStakerPage({
      runId: partial.runId,
      sourceId,
      nodeSourceId,
      managerPrincipal: manager,
      nextCursor: stakerTwo,
      items: [
        {
          stakerPrincipal: stakerOne,
          hasStx: true,
          hasBtc: false,
          stxNodeVerified: false,
          position: null,
        },
      ],
      observedAt: later,
      burnBlockHeight: 960_241,
      stacksTipHeight: 8_600_001,
    });

    expect(checkpoint).toMatchObject({ status: "running", cursor: stakerTwo });
    expect(store.listSignerStakers(manager)).toHaveLength(2);
    expect(store.startOrResumeSignerStakerRun(sourceId, manager, later)).toEqual(checkpoint);

    store.commitSignerStakerPage({
      runId: partial.runId,
      sourceId,
      nodeSourceId,
      managerPrincipal: manager,
      nextCursor: null,
      items: [],
      observedAt: later,
      burnBlockHeight: 960_241,
      stacksTipHeight: 8_600_001,
    });

    expect(store.listSignerStakers(manager)).toHaveLength(1);
    expect(store.listSignerStakers(manager, false)).toMatchObject([
      { stakerPrincipal: stakerOne, active: true },
      { stakerPrincipal: stakerTwo, active: false },
    ]);
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
      schemaVersion: 2,
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
