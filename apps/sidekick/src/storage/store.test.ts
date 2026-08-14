import { createHash } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migrations } from "./migrations.js";
import {
  backupSidekickDatabase,
  createChainSourceId,
  createNodeSourceId,
  openSidekickStore,
  SidekickStore,
} from "./store.js";
import { canonicalJsonSha256 } from "./wallet-intent-repository.js";

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
const authoritativeProvenance = {
  classification: "authoritative" as const,
  contractSource: "pox5-read-only" as const,
  localRosterSource: "api-indexed-node-verified" as const,
};
const chainAnchor = {
  stacksBlockHeight: 8_600_000,
  indexBlockHash,
  burnBlockHeight: 960_240,
  rewardCycle: 141,
  rewardCycleLength: 2_100,
  prepareCycleLength: 100,
  cyclePosition: 1_049,
  phase: "reward" as const,
  checkpoint: "first-half" as const,
};

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

function revertMigration14(database: DatabaseSync): void {
  database.exec(`
    DROP TABLE observer_deliveries;
    DROP TABLE deployment_identity;
    DROP TABLE signer_staker_api_scan_items;
    DROP TABLE signer_staker_api_scans;
    DROP TABLE browser_wallet_intent_observations;
    DROP TABLE browser_wallet_intents;
    DROP TABLE engine_force_observe_control;
    DROP TABLE engine_adapter_disable_controls;
    DROP TABLE transaction_reconciliation_observations;
    DROP TABLE transaction_approvals;
    DROP TABLE transaction_attempts;
    DROP TABLE gas_payer_nonce_reservations;
    DROP TABLE transaction_jobs;
    DROP TABLE accepted_compatibility_attestations;
    ALTER TABLE stakers DROP COLUMN bond_node_verified;
    ALTER TABLE stakers DROP COLUMN bond_index;
    ALTER TABLE stakers DROP COLUMN bond_amount_ustx;
    ALTER TABLE stakers DROP COLUMN bond_amount_sats;
    ALTER TABLE stakers DROP COLUMN bond_is_l1_lock;
    ALTER TABLE pool_cycle_snapshots DROP COLUMN chain_anchor_json;
    ALTER TABLE reward_cycle_snapshots DROP COLUMN chain_anchor_json;
    DELETE FROM schema_migrations WHERE version >= 14;
    PRAGMA user_version = 13;
  `);
}

function createDatabaseThroughMigration(path: string, version: number): SidekickStore {
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);
  const insert = database.prepare(
    "INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
  );
  for (const migration of migrations.filter((candidate) => candidate.version <= version)) {
    database.exec("BEGIN IMMEDIATE");
    database.exec(migration.sql);
    const checksum = createHash("sha256")
      .update(`${migration.version}\n${migration.name}\n${migration.sql}`)
      .digest("hex");
    insert.run(migration.version, migration.name, checksum, observedAt);
    database.exec(`PRAGMA user_version = ${migration.version}`);
    database.exec("COMMIT");
  }
  return new SidekickStore(database);
}

afterEach(async () => {
  for (const store of openStores.splice(0)) store.close();
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("Sidekick SQLite store", () => {
  it("binds one immutable deployment identity and advances only its proof anchor", async () => {
    const store = await memoryStore();
    expect(store.getDeploymentIdentity()).toBeNull();

    const bound = store.bindDeploymentIdentity({
      network: "mainnet",
      networkId: 1,
      parentNetworkId: 0,
      managerPrincipal: manager,
      bindingSource: "new",
      verifiedAt: observedAt,
      stacksTipHeight: 8_600_000,
      burnBlockHeight: 960_240,
      pox5ContractId: "SP000000000000000000002Q6VF78.pox-5",
    });
    expect(bound).toMatchObject({
      schemaVersion: 1,
      network: "mainnet",
      networkId: 1,
      parentNetworkId: 0,
      managerPrincipal: manager,
      bindingSource: "new",
      boundAt: observedAt,
      lastVerifiedAt: observedAt,
    });

    expect(
      store.recordDeploymentIdentityVerification({
        network: "mainnet",
        networkId: 1,
        parentNetworkId: 0,
        managerPrincipal: manager,
        verifiedAt: later,
        stacksTipHeight: 8_600_010,
        burnBlockHeight: 960_241,
        pox5ContractId: "SP000000000000000000002Q6VF78.pox-5",
      }),
    ).toMatchObject({
      boundAt: observedAt,
      lastVerifiedAt: later,
      lastStacksTipHeight: 8_600_010,
      lastBurnBlockHeight: 960_241,
    });
    expect(() =>
      store.recordDeploymentIdentityVerification({
        network: "mainnet",
        networkId: 1,
        parentNetworkId: 0,
        managerPrincipal: "SP2369QN53586176SYRF4XFGF4E84V0J0EWKRG0ZH.other-manager",
        verifiedAt: later,
        stacksTipHeight: 8_600_010,
        burnBlockHeight: 960_241,
        pox5ContractId: "SP000000000000000000002Q6VF78.pox-5",
      }),
    ).toThrow("does not match");
    expect(() =>
      store.bindDeploymentIdentity({
        network: "mainnet",
        networkId: 1,
        parentNetworkId: 0,
        managerPrincipal: manager,
        bindingSource: "new",
        verifiedAt: later,
        stacksTipHeight: 8_600_010,
        burnBlockHeight: 960_241,
        pox5ContractId: "SP000000000000000000002Q6VF78.pox-5",
      }),
    ).toThrow("already bound");
  });

  it("summarizes all legacy network and manager evidence before binding", async () => {
    const store = await memoryStore();
    registerSource(store);
    store.recordManagerTrustState({
      managerPrincipal: manager,
      recognitionTier: "unrecognized",
      profileId: null,
      profileOrigin: null,
      sourceSha256: null,
      canonicalSourceSha256: null,
      automationEligible: false,
      eligibilityReason: "Observe only",
      observedAt,
    });

    expect(store.inspectLegacyDeploymentEvidence()).toEqual({
      networks: ["mainnet"],
      networkIds: [],
      managerPrincipals: [manager],
    });
  });

  it("deduplicates durable manager automation-eligibility transitions", async () => {
    const store = await memoryStore();
    const base = {
      managerPrincipal: "ST3PF13W7Z0RRM42A8VZRVFQ75SV1K26RXEP8YGKJ.signer-manager",
      recognitionTier: "unrecognized" as const,
      profileId: null,
      profileOrigin: null,
      sourceSha256: "a".repeat(64),
      canonicalSourceSha256: "b".repeat(64),
      automationEligible: false,
      eligibilityReason: "Not recognized — read-only",
      observedAt: "2026-07-16T12:00:00.000Z",
    };
    expect(store.recordManagerTrustState(base)).toBeNull();
    expect(
      store.recordManagerTrustState({ ...base, observedAt: "2026-07-16T12:01:00.000Z" }),
    ).toBeNull();
    expect(
      store.recordManagerTrustState({
        ...base,
        recognitionTier: "reference-render",
        profileId: "private-1",
        profileOrigin: "operator-installed",
        sourceSha256: "c".repeat(64),
        canonicalSourceSha256: "d".repeat(64),
        automationEligible: true,
        eligibilityReason: "Reference render verified",
        observedAt: "2026-07-16T12:02:00.000Z",
      }),
    ).toMatchObject({ transition: "gained", previousTier: "unrecognized" });
    expect(
      store.recordManagerTrustState({
        ...base,
        recognitionTier: "reference-render",
        profileId: "private-1",
        profileOrigin: "operator-installed",
        sourceSha256: "c".repeat(64),
        canonicalSourceSha256: "d".repeat(64),
        automationEligible: true,
        eligibilityReason: "Reference render verified",
        observedAt: "2026-07-16T12:03:00.000Z",
      }),
    ).toBeNull();
    expect(
      store.recordManagerTrustState({
        ...base,
        eligibilityReason: "Installed profile is unavailable",
        observedAt: "2026-07-16T12:04:00.000Z",
      }),
    ).toMatchObject({ transition: "lost", currentTier: "unrecognized" });
    expect(store.listManagerTrustAudit(base.managerPrincipal)).toMatchObject([
      {
        transition: "lost",
        previousSourceSha256: "c".repeat(64),
        currentSourceSha256: "a".repeat(64),
        reason: "Installed profile is unavailable",
      },
      {
        transition: "gained",
        previousCanonicalSourceSha256: "b".repeat(64),
        currentCanonicalSourceSha256: "d".repeat(64),
        reason: "Reference render verified",
      },
    ]);
    expect(
      store.recordManagerTrustState({
        ...base,
        managerPrincipal: "ST000000000000000000002AMW42H.second-manager",
        recognitionTier: "reference-built-in",
        profileId: "approved-devnet",
        profileOrigin: "built-in",
        automationEligible: true,
        eligibilityReason: "Built-in profile is approved",
      }),
    ).toMatchObject({ transition: "gained", previousTier: "unobserved" });

    const unapprovedManager = "ST000000000000000000002AMW42H.unapproved-manager";
    expect(
      store.recordManagerTrustState({
        ...base,
        managerPrincipal: unapprovedManager,
        recognitionTier: "reference-render",
        profileId: "unapproved-private-render",
        profileOrigin: "operator-installed",
        automationEligible: false,
        eligibilityReason: "No production approval for this network",
      }),
    ).toBeNull();
    expect(
      store.recordManagerTrustState({
        ...base,
        managerPrincipal: unapprovedManager,
        eligibilityReason: "Installed profile was removed",
        observedAt: "2026-07-16T12:05:00.000Z",
      }),
    ).toMatchObject({ transition: "degraded", previousTier: "reference-render" });
    expect(store.listManagerTrustAudit(unapprovedManager)).toMatchObject([
      {
        transition: "degraded",
        previousTier: "reference-render",
        currentTier: "unrecognized",
      },
    ]);
  });

  it("applies explicit migrations with defensive runtime pragmas", async () => {
    const store = await memoryStore();

    expect(store.databaseStatus()).toEqual({
      schemaVersion: 24,
      journalMode: "memory",
      synchronous: 1,
      foreignKeys: true,
    });
  });

  it("persists redacted runtime settings history", async () => {
    const store = await memoryStore();
    store.putRuntimeSettings({
      settings: { schemaVersion: 1, displayName: "Test pool" },
      apiKeySecret: "must-not-appear-in-settings-json",
      changedFields: ["pool.displayName", "dataSources.apiKey"],
      observedAt,
    });
    const runtime = store.getRuntimeSettings();
    expect(runtime).toMatchObject({ revision: 1, settings: { displayName: "Test pool" } });
    expect(JSON.stringify(runtime?.settings)).not.toContain("must-not-appear");
    expect(runtime?.apiKeySecret).toBe("must-not-appear-in-settings-json");
    expect(store.listSettingsAudit()).toEqual([
      {
        revision: 1,
        changedFields: ["dataSources.apiKey", "pool.displayName"],
        changedAt: observedAt,
      },
    ]);
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
      const claim = eventIndex === 0;
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
        contractId: claim ? manager : null,
        topic: claim ? "claim-staker-rewards" : null,
        rawPayload: { eventIndex },
        decodedSchemaVersion: claim ? 1 : null,
        decodedPayload: claim
          ? {
              transactionStatus: "success",
              event: {
                kind: "claim-staker-rewards",
                stakerPrincipal: stakerOne,
                rewardCycle: "141",
                bondIndex: null,
                amountSats: "10000",
                l1Withdrawal: null,
              },
            }
          : null,
        sourceId,
        observedAt,
      });
    }

    expect(store.listManagerClaims(1, manager)).toMatchObject({ total: 1 });
    expect(store.markIndexBlockNonCanonical(1, indexBlockHash, later)).toBe(2);
    expect(store.getChainEvent(1, txId, 0)).toMatchObject({ canonical: false, updatedAt: later });
    expect(store.listManagerClaims(1, manager)).toMatchObject({ total: 0, items: [] });
  });

  it("materializes unbounded manager claim and withdrawal history for paginated reads", async () => {
    const store = await memoryStore();
    registerSource(store);
    const put = (
      id: string,
      eventIndex: number,
      blockHeight: number,
      event: Record<string, unknown>,
    ) =>
      store.putChainEvent({
        chainId: 1,
        txId: id,
        eventIndex,
        blockHeight,
        blockHash,
        indexBlockHash,
        microblockHash: null,
        microblockSequence: null,
        canonical: true,
        microblockCanonical: true,
        contractId: manager,
        topic: String(event.kind),
        rawPayload: {},
        decodedSchemaVersion: 1,
        decodedPayload: { transactionStatus: "success", event },
        sourceId,
        observedAt,
      });
    put(txId, 0, 8_600_000, {
      kind: "claim-staker-rewards",
      stakerPrincipal: stakerOne,
      rewardCycle: "141",
      bondIndex: null,
      amountSats: "10000",
      l1Withdrawal: { requestId: "72", amountSats: "9000", maxFeeSats: "1000" },
    });
    put(`0x${"66".repeat(32)}`, 0, 8_600_001, {
      kind: "settle-accepted-withdrawal",
      requestId: "72",
      stakerPrincipal: stakerOne,
      liabilityReleasedSats: "9000",
    });

    expect(store.listManagerClaims(1, manager, { limit: 1 })).toMatchObject({
      total: 1,
      items: [{ rewardCycle: "141", destination: "bitcoin-l1" }],
    });
    expect(store.listManagerWithdrawals(1, manager, { limit: 1 })).toMatchObject({
      total: 1,
      items: [{ requestId: "72", state: "settled" }],
    });
    expect(store.getManagerActivityMetadata(1, manager)).toEqual({
      eventCount: 2,
      latestBlockHeight: 8_600_001,
    });
  });

  it("orders canonical administrator changes by transaction and event index", async () => {
    const store = await memoryStore();
    registerSource(store);
    const putAdminUpdate = (
      id: string,
      eventIndex: number,
      transactionIndex: number,
      adminPrincipal: string,
      enabled: boolean,
    ) =>
      store.putChainEvent({
        chainId: 1,
        txId: id,
        eventIndex,
        blockHeight: 8_600_000,
        blockHash,
        indexBlockHash,
        microblockHash: null,
        microblockSequence: null,
        canonical: true,
        microblockCanonical: true,
        contractId: manager,
        topic: "update-admin",
        rawPayload: { transactionIndex },
        decodedSchemaVersion: 1,
        decodedPayload: {
          transactionStatus: "success",
          event: { kind: "update-admin", adminPrincipal, enabled },
        },
        sourceId,
        observedAt,
      });
    putAdminUpdate(txId, 1, 3, stakerOne, false);
    putAdminUpdate(`0x${"66".repeat(32)}`, 0, 2, stakerOne, true);

    expect(store.listManagerAdminUpdates(1, manager)).toEqual([
      {
        adminPrincipal: stakerOne,
        enabled: true,
        transactionIndex: 2,
        blockHeight: 8_600_000,
        eventIndex: 0,
      },
      {
        adminPrincipal: stakerOne,
        enabled: false,
        transactionIndex: 3,
        blockHeight: 8_600_000,
        eventIndex: 1,
      },
    ]);
  });

  it("paginates manager activity beyond the former 2,000-event read ceiling", async () => {
    const store = await memoryStore();
    registerSource(store);
    const eventCount = 2_105;
    for (let index = 0; index < eventCount; index += 1) {
      store.putChainEvent({
        chainId: 1,
        txId: `0x${index.toString(16).padStart(64, "0")}`,
        eventIndex: 0,
        blockHeight: 8_600_000 + index,
        blockHash,
        indexBlockHash,
        microblockHash: null,
        microblockSequence: null,
        canonical: true,
        microblockCanonical: true,
        contractId: manager,
        topic: "claim-staker-rewards",
        rawPayload: {},
        decodedSchemaVersion: 1,
        decodedPayload: {
          transactionStatus: "success",
          event: {
            kind: "claim-staker-rewards",
            stakerPrincipal: stakerOne,
            rewardCycle: String(100 + (index % 96)),
            bondIndex: null,
            amountSats: "10000",
            l1Withdrawal: null,
          },
        },
        sourceId,
        observedAt,
      });
    }

    expect(store.listManagerClaims(1, manager, { limit: 50, offset: 2_050 })).toMatchObject({
      total: eventCount,
      offset: 2_050,
      limit: 50,
      items: expect.arrayContaining([expect.objectContaining({ blockHeight: 8_600_054 })]),
    });
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
          active: true,
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
    expect(store.getLatestCompletedSignerStakerRun(sourceId, manager)).toEqual(completed);
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
    expect(store.listStakerPositionObservations(manager, stakerOne)).toMatchObject([
      {
        observedBurnBlockHeight: 960_240,
        observedStacksTipHeight: 8_600_000,
        stxNodeVerified: true,
        position: {
          amountUstx: "50000000000",
          firstRewardCycle: "141",
          unlockCycle: "144",
        },
      },
    ]);
    expect(store.listCycleMemberships(manager, true, "api:mainnet:unknown")).toEqual([]);

    const nextRun = store.startOrResumeSignerStakerRun(sourceId, manager, later);
    store.commitSignerStakerPage({
      runId: nextRun.runId,
      sourceId,
      nodeSourceId,
      managerPrincipal: manager,
      nextCursor: null,
      items: [
        {
          stakerPrincipal: stakerOne,
          hasStx: true,
          hasBtc: false,
          active: true,
          stxNodeVerified: true,
          position: {
            signerPrincipal: manager,
            amountUstx: 50_000_000_000n,
            firstRewardCycle: 142n,
            numCycles: 2n,
            cycleMemberships: [
              { rewardCycle: 142n, signerPrincipal: manager, amountUstx: 50_000_000_000n },
              { rewardCycle: 143n, signerPrincipal: manager, amountUstx: 50_000_000_000n },
            ],
          },
        },
      ],
      observedAt: later,
      burnBlockHeight: 960_241,
      stacksTipHeight: 8_600_001,
    });
    expect(store.listCycleMembershipsForCycle(manager, 141, sourceId)).toEqual([
      expect.objectContaining({ stakerPrincipal: stakerOne, rewardCycle: 141n, active: false }),
    ]);
  });

  it("retains the latest pool observation for every historical reward cycle", async () => {
    const store = await memoryStore();
    store.putPoolCycleSnapshots({
      managerPrincipal: manager,
      observedAt,
      burnBlockHeight: 960_240,
      stacksTipHeight: 8_600_000,
      chainAnchor,
      cycles: [141, 142].map((cycleId) => ({
        cycleId,
        status: "ready" as const,
        rosterAvailable: true,
        stakerCount: 500,
        enumeratedStxUstx: "60000000000",
        enumerationDeltaUstx: "0",
        pendingStxUstx: "60000000000",
        eligibleStxSharesUstx: "60000000000",
        totalDelegatedUstx: "60000000000",
        nonStxDelegatedUstx: "0",
        inSignerSet: true,
        thresholdUstx: "50000000000",
        thresholdMarginUstx: "10000000000",
        provenance:
          cycleId === 141
            ? authoritativeProvenance
            : {
                ...authoritativeProvenance,
                classification: "projected" as const,
              },
      })),
    });
    store.putPoolCycleSnapshots({
      managerPrincipal: manager,
      observedAt: later,
      burnBlockHeight: 960_241,
      stacksTipHeight: 8_600_001,
      cycles: [
        {
          cycleId: 141,
          status: "attention",
          rosterAvailable: true,
          stakerCount: 499,
          enumeratedStxUstx: "59000000000",
          enumerationDeltaUstx: "-1000000000",
          pendingStxUstx: "60000000000",
          eligibleStxSharesUstx: "60000000000",
          totalDelegatedUstx: "60000000000",
          nonStxDelegatedUstx: "0",
          inSignerSet: true,
          thresholdUstx: "50000000000",
          thresholdMarginUstx: "10000000000",
          provenance: authoritativeProvenance,
        },
      ],
    });

    expect(store.listLatestPoolCycleSnapshots(manager, { limit: 1 })).toMatchObject({
      total: 2,
      items: [
        {
          cycleId: 142,
          status: "ready",
          stakerCount: 500,
          chainAnchor,
          provenance: { classification: "projected" },
        },
      ],
    });
    expect(store.listLatestPoolCycleSnapshots(manager, { limit: 1, offset: 1 })).toMatchObject({
      total: 2,
      items: [{ cycleId: 141, status: "attention", stakerCount: 499 }],
    });
  });

  it("keeps one bounded reward ledger entry per manager, cycle, and staker", async () => {
    const store = await memoryStore();
    const snapshot = (rewardCycle: number, earnedSats: string) => ({
      managerPrincipal: manager,
      rewardCycle,
      status: "ready" as const,
      observedAt,
      burnBlockHeight: 960_240,
      stacksTipHeight: 8_600_000,
      chainAnchor,
      global: {
        lastRewardComputeBurnHeight: "960200",
        lastComputedRewardCycle: "140",
        rewardsPerToken: "42",
        signerEarnedBeforeManagerClaimSats: "0",
        signerEarnedAcrossBucketsSats: "0",
      },
      manager: {
        configuredFeeBips: "750",
        feeSnapshotBips: "500",
        earnedFeesSats: "100",
        withdrawalLiabilitySats: "0",
        unclaimedStakerRewardsSats: earnedSats,
      },
      totals: {
        stakers: 1,
        grossSats: earnedSats,
        earnedSats,
        feeSats: "0",
        actionableClaims: 1,
        l1ClaimsWaitingForFeeThreshold: 0,
      },
      stakers: [
        {
          stakerPrincipal: stakerOne,
          payout: { kind: "direct-sbtc" as const, poxAddress: null, maxFeeSats: null },
          rewards: { earnedSats, feeSats: "0", grossSats: earnedSats },
          claimableByPolicy: true,
        },
      ],
    });
    store.putRewardCycleSnapshot(snapshot(141, "10000"));
    store.putRewardCycleSnapshot(snapshot(142, "11000"));
    store.putRewardCycleSnapshot(snapshot(141, "12000"));

    expect(store.listRewardCycleSummaries(manager, { limit: 1 })).toMatchObject({
      total: 2,
      items: [
        {
          rewardCycle: 142,
          earnedSats: "11000",
          configuredFeeBips: "750",
          feeSnapshotBips: "500",
          chainAnchor,
        },
      ],
    });
    expect(store.listRewardCycleSummaries(manager, { limit: 1, offset: 1 })).toMatchObject({
      total: 2,
      items: [{ rewardCycle: 141, earnedSats: "12000" }],
    });
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
          active: true,
          stxNodeVerified: false,
          position: null,
        },
        {
          stakerPrincipal: stakerTwo,
          hasStx: false,
          hasBtc: true,
          active: true,
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
          active: true,
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
      schemaVersion: 24,
      journalMode: "wal",
      synchronous: 2,
    });
  });

  it("upgrades a persisted migration 13 database through migration 23 once", async () => {
    const directory = await mkdtemp(join(tmpdir(), "signer-sidekick-v13-upgrade-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "sidekick.sqlite");
    const initial = await openSidekickStore(path, observedAt);
    initial.store.putRuntimeSettings({
      settings: { schemaVersion: 1, displayName: "Preserved through forward migrations" },
      apiKeySecret: null,
      changedFields: ["pool.displayName"],
      observedAt,
    });
    initial.store.close();

    const version13 = new DatabaseSync(path);
    revertMigration14(version13);
    version13.close();

    const upgraded = await openSidekickStore(path, later);
    openStores.push(upgraded.store);
    expect(upgraded.backupPath).not.toBeNull();
    expect(upgraded.store.databaseStatus().schemaVersion).toBe(24);
    expect(upgraded.store.getRuntimeSettings()?.settings).toMatchObject({
      displayName: "Preserved through forward migrations",
    });

    const inspection = new DatabaseSync(path, { readOnly: true });
    expect(
      inspection.prepare("SELECT name FROM schema_migrations WHERE version = 14").get(),
    ).toEqual({ name: "transaction_engine_persistence" });
    expect(
      inspection
        .prepare("SELECT count(*) AS count FROM schema_migrations WHERE version = 14")
        .get(),
    ).toEqual({ count: 1 });
    expect(
      inspection.prepare("SELECT name FROM schema_migrations WHERE version = 15").get(),
    ).toEqual({ name: "reusable_resolved_gas_payer_nonces" });
    expect(
      inspection.prepare("SELECT name FROM schema_migrations WHERE version = 16").get(),
    ).toEqual({ name: "browser_wallet_intents" });
    expect(
      inspection.prepare("SELECT name FROM schema_migrations WHERE version = 17").get(),
    ).toEqual({ name: "browser_wallet_manager_actions" });
    expect(
      inspection.prepare("SELECT name FROM schema_migrations WHERE version = 18").get(),
    ).toEqual({ name: "durable_signer_staker_api_rosters" });
    expect(
      inspection.prepare("SELECT name FROM sqlite_master WHERE name = 'transaction_jobs'").get(),
    ).toEqual({ name: "transaction_jobs" });
    expect(
      inspection
        .prepare("SELECT name FROM pragma_table_info('pool_cycle_snapshots') WHERE name = ?")
        .get("chain_anchor_json"),
    ).toEqual({ name: "chain_anchor_json" });
    inspection.close();
  });

  it("preserves an active V1 wallet intent and observation from migration 16", async () => {
    const directory = await mkdtemp(join(tmpdir(), "signer-sidekick-v16-wallet-upgrade-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "sidekick.sqlite");
    const version16 = createDatabaseThroughMigration(path, 16);
    const intentId = "10000000-0000-4000-8000-000000000016";
    const observationId = "20000000-0000-4000-8000-000000000016";
    const factsSha256 = "44".repeat(32);
    const manifest = {
      schemaVersion: 1,
      id: intentId,
      action: "deploy-manager" as const,
      network: "mainnet" as const,
      chainId: 1,
      requiredSender: stakerOne,
      createdAt: observedAt,
      expiresAt: "2026-07-14T13:00:00.000Z",
      transaction: {
        method: "stx_deployContract" as const,
        params: {
          name: "signer-manager",
          clarityCode: "(define-public (ping) (ok true))",
          clarityVersion: 6 as const,
          network: "mainnet" as const,
          address: stakerOne,
          sponsored: false as const,
          postConditionMode: "deny" as const,
          postConditions: [] as [],
        },
      },
      review: {
        title: "Deploy signer manager",
        summary: "Deploy the reviewed manager source.",
        expectedPostState: "The exact manager source is canonical.",
      },
      seal: { factsSha256 },
    };
    const manifestSha256 = canonicalJsonSha256(manifest);
    version16.walletIntents.create({
      id: intentId,
      action: "deploy-manager",
      scope: manager,
      factsSha256,
      manifestSha256,
      manifest,
      requiredSender: stakerOne,
      network: "mainnet",
      chainId: 1,
      createdAt: observedAt,
      expiresAt: manifest.expiresAt,
    });
    version16.walletIntents.submit({ id: intentId, txid: txId, submittedAt: later });
    const evidence = {
      schemaVersion: 1,
      verification: {
        outcome: "submitted",
        observedAt: later,
        canonical: null,
        blockHeight: null,
        indexBlockHash: null,
        detail: "Wallet transaction recorded",
      },
      decoded: null,
    };
    version16.walletIntents.appendObservation({
      id: observationId,
      intentId,
      outcome: "submitted",
      canonical: null,
      blockHeight: null,
      indexBlockHash: null,
      evidence,
      observedAt: later,
    });
    version16.close();

    const upgraded = await openSidekickStore(path, "2026-07-14T12:02:00.000Z");
    openStores.push(upgraded.store);
    expect(upgraded.backupPath).not.toBeNull();
    expect(upgraded.store.schemaVersion()).toBe(24);
    expect(upgraded.store.walletIntents.get(intentId)).toMatchObject({
      id: intentId,
      state: "submitted",
      txid: txId,
      manifestSha256,
      manifest,
    });
    expect(upgraded.store.walletIntents.listObservations(intentId)).toEqual([
      expect.objectContaining({ id: observationId, outcome: "submitted", evidence }),
    ]);
    expect(upgraded.store.inspectLegacyDeploymentEvidence()).toMatchObject({
      networks: ["mainnet"],
      networkIds: [1],
      managerPrincipals: [manager],
    });
  });

  it("upgrades migration 14 nonce history without losing attempts or foreign keys", async () => {
    const directory = await mkdtemp(join(tmpdir(), "signer-sidekick-v14-upgrade-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "sidekick.sqlite");
    const initial = await openSidekickStore(path, observedAt);
    initial.store.close();

    const version14 = new DatabaseSync(path);
    version14.exec(`
      PRAGMA foreign_keys = ON;
      INSERT INTO transaction_jobs (
        job_id, idempotency_key, operation_scope_key, adapter_id, adapter_revision,
        manager_principal, intent_sha256, policy_sha256, intent_json, policy_json,
        chain_anchor_json, attestation_issuer, attestation_revision,
        attestation_payload_sha256, state, state_version, block_reason,
        supersession_reason, superseded_by_job_id, created_at, updated_at
      ) VALUES (
        'migration-15-job', 'migration-15-idempotency', 'migration-15-scope',
        'manager-claim-staker-rewards', 1, 'migration-15-gas-payer',
        lower(hex(zeroblob(32))), lower(hex(zeroblob(32))), '{}', '{}', '{}',
        'stacks-labs', 1, lower(hex(zeroblob(32))), 'blocked', 4,
        'broadcast-rejected:test', NULL, NULL, '${observedAt}', '${later}'
      );
      INSERT INTO gas_payer_nonce_reservations (
        reservation_id, gas_payer_principal, job_id, nonce, observed_account_nonce,
        state, state_version, foreign_activity, created_at, updated_at, resolved_at
      ) VALUES (
        'migration-15-reservation', 'migration-15-gas-payer', 'migration-15-job',
        '7', '7', 'resolved', 1, 0, '${observedAt}', '${later}', '${later}'
      );
      INSERT INTO transaction_attempts (
        attempt_id, job_id, attempt_number, nonce_reservation_id, fee_ustx,
        fee_policy_revision, signed_transaction_ref, precomputed_txid,
        state, state_version, submission_result_json, inclusion_record_json,
        submitted_at, resolved_at, created_at, updated_at
      ) VALUES (
        'migration-15-attempt', 'migration-15-job', 1, 'migration-15-reservation',
        '1000', 1, 'migration-15-signed-reference',
        '0x' || lower(hex(zeroblob(32))), 'rejected', 1,
        '{"status":"deterministic-rejection"}', NULL, NULL, '${later}',
        '${observedAt}', '${later}'
      );
      CREATE UNIQUE INDEX gas_payer_nonce_historical_v14
        ON gas_payer_nonce_reservations (gas_payer_principal, nonce);
      DROP TABLE signer_staker_api_scan_items;
      DROP TABLE signer_staker_api_scans;
      DROP TABLE browser_wallet_intent_observations;
      DROP TABLE browser_wallet_intents;
      ALTER TABLE stakers DROP COLUMN bond_node_verified;
      ALTER TABLE stakers DROP COLUMN bond_index;
      ALTER TABLE stakers DROP COLUMN bond_amount_ustx;
      ALTER TABLE stakers DROP COLUMN bond_amount_sats;
      ALTER TABLE stakers DROP COLUMN bond_is_l1_lock;
      DROP TABLE observer_deliveries;
      DROP TABLE deployment_identity;
      DELETE FROM schema_migrations WHERE version >= 15;
      PRAGMA user_version = 14;
    `);
    version14.close();

    const upgraded = await openSidekickStore(path, later);
    openStores.push(upgraded.store);
    expect(upgraded.backupPath).not.toBeNull();
    expect(upgraded.store.databaseStatus().schemaVersion).toBe(24);

    const postUpgrade = new DatabaseSync(path);
    postUpgrade.exec(`
      PRAGMA foreign_keys = ON;
      INSERT INTO transaction_jobs (
        job_id, idempotency_key, operation_scope_key, adapter_id, adapter_revision,
        manager_principal, intent_sha256, policy_sha256, intent_json, policy_json,
        chain_anchor_json, attestation_issuer, attestation_revision,
        attestation_payload_sha256, state, state_version, block_reason,
        supersession_reason, superseded_by_job_id, created_at, updated_at
      )
      SELECT
        'migration-15-retry-job', 'migration-15-retry-idempotency',
        'migration-15-retry-scope', adapter_id, adapter_revision, manager_principal,
        intent_sha256, policy_sha256, intent_json, policy_json, chain_anchor_json,
        attestation_issuer, attestation_revision, attestation_payload_sha256,
        state, state_version, block_reason, supersession_reason, superseded_by_job_id,
        created_at, updated_at
      FROM transaction_jobs WHERE job_id = 'migration-15-job';
      INSERT INTO gas_payer_nonce_reservations (
        reservation_id, gas_payer_principal, job_id, nonce, observed_account_nonce,
        state, state_version, foreign_activity, created_at, updated_at, resolved_at
      ) VALUES (
        'migration-15-retry-reservation', 'migration-15-gas-payer',
        'migration-15-retry-job', '7', '7', 'resolved', 1, 0,
        '${later}', '${later}', '${later}'
      );
    `);
    postUpgrade.close();

    const inspection = new DatabaseSync(path, { readOnly: true });
    const reservationTable = inspection
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'gas_payer_nonce_reservations'",
      )
      .get() as { sql: string };
    expect(reservationTable.sql).not.toContain("UNIQUE (gas_payer_principal, nonce)");
    expect(
      inspection.prepare("PRAGMA index_list('gas_payer_nonce_reservations')").all(),
    ).toContainEqual(
      expect.objectContaining({ name: "gas_payer_nonce_one_unresolved", unique: 1, partial: 1 }),
    );
    expect(
      inspection
        .prepare(
          `SELECT a.state AS attempt_state, a.submission_result_json,
             a.signed_transaction_ref, a.precomputed_txid,
             r.state AS reservation_state, r.nonce
           FROM transaction_attempts a
           JOIN gas_payer_nonce_reservations r
             ON r.reservation_id = a.nonce_reservation_id
           WHERE a.attempt_id = 'migration-15-attempt'`,
        )
        .get(),
    ).toEqual({
      attempt_state: "rejected",
      submission_result_json: '{"status":"deterministic-rejection"}',
      signed_transaction_ref: "migration-15-signed-reference",
      precomputed_txid: `0x${"00".repeat(32)}`,
      reservation_state: "resolved",
      nonce: "7",
    });
    expect(
      inspection
        .prepare(
          `SELECT count(*) AS count FROM gas_payer_nonce_reservations
           WHERE gas_payer_principal = 'migration-15-gas-payer' AND nonce = '7'`,
        )
        .get(),
    ).toEqual({ count: 2 });
    expect(inspection.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(
      inspection.prepare("PRAGMA foreign_key_list('transaction_attempts')").all(),
    ).toContainEqual(
      expect.objectContaining({
        table: "gas_payer_nonce_reservations",
        from: "nonce_reservation_id",
        to: "reservation_id",
      }),
    );
    expect(
      inspection
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'trigger' AND name IN (
             'gas_payer_nonce_immutable_binding', 'transaction_attempts_immutable_binding'
           ) ORDER BY name`,
        )
        .all(),
    ).toEqual([
      { name: "gas_payer_nonce_immutable_binding" },
      { name: "transaction_attempts_immutable_binding" },
    ]);
    inspection.close();
  });

  it("upgrades a persisted migration 12 trust ledger without resetting it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "signer-sidekick-v11-upgrade-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "sidekick.sqlite");
    const initial = await openSidekickStore(path, observedAt);
    const principal = "ST3PF13W7Z0RRM42A8VZRVFQ75SV1K26RXEP8YGKJ.signer-manager";
    initial.store.recordManagerTrustState({
      managerPrincipal: principal,
      recognitionTier: "unrecognized",
      profileId: null,
      profileOrigin: null,
      sourceSha256: "a".repeat(64),
      canonicalSourceSha256: "b".repeat(64),
      automationEligible: false,
      eligibilityReason: "Not recognized — read-only",
      observedAt,
    });
    initial.store.recordManagerTrustState({
      managerPrincipal: principal,
      recognitionTier: "reference-render",
      profileId: "private-render",
      profileOrigin: "operator-installed",
      sourceSha256: "c".repeat(64),
      canonicalSourceSha256: "d".repeat(64),
      automationEligible: true,
      eligibilityReason: "Reference render verified",
      observedAt: later,
    });
    initial.store.close();

    const version12 = new DatabaseSync(path);
    revertMigration14(version12);
    version12.exec(`
      ALTER TABLE ingestion_runs DROP COLUMN authoritative;
      ALTER TABLE ingestion_runs DROP COLUMN reconciliation_complete;
      ALTER TABLE ingestion_runs DROP COLUMN anchor_stacks_block_height;
      ALTER TABLE ingestion_runs DROP COLUMN anchor_index_block_hash;
      ALTER TABLE ingestion_runs DROP COLUMN anchor_burn_block_height;
      ALTER TABLE ingestion_runs DROP COLUMN anchor_reward_cycle;
      ALTER TABLE ingestion_runs DROP COLUMN anchor_reward_cycle_length;
      ALTER TABLE ingestion_runs DROP COLUMN anchor_prepare_cycle_length;
      ALTER TABLE ingestion_runs DROP COLUMN anchor_cycle_position;
      ALTER TABLE ingestion_runs DROP COLUMN anchor_phase;
      ALTER TABLE ingestion_runs DROP COLUMN anchor_checkpoint;
      ALTER TABLE stake_positions DROP COLUMN observed_index_block_hash;
      ALTER TABLE cycle_memberships DROP COLUMN observed_index_block_hash;
      ALTER TABLE staker_position_observations DROP COLUMN observed_index_block_hash;
      DELETE FROM schema_migrations WHERE version >= 13;
      PRAGMA user_version = 12;
    `);
    version12.close();

    const upgraded = await openSidekickStore(path, later);
    openStores.push(upgraded.store);
    expect(upgraded.store.databaseStatus().schemaVersion).toBe(24);
    expect(upgraded.store.listManagerTrustAudit(principal)).toMatchObject([
      {
        transition: "gained",
        previousTier: "unrecognized",
        currentTier: "reference-render",
        reason: "Reference render verified",
      },
    ]);
  });

  it("creates and verifies an explicit online database backup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "signer-sidekick-backup-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "sidekick.sqlite");
    const destination = join(directory, "backups", "sidekick.sqlite");
    const { store } = await openSidekickStore(path, observedAt);
    openStores.push(store);
    registerSource(store);

    await expect(backupSidekickDatabase(path, destination)).resolves.toMatchObject({
      sourcePath: path,
      destinationPath: destination,
      quickCheck: "ok",
    });
    expect((await stat(destination)).size).toBeGreaterThan(0);
    await expect(backupSidekickDatabase(path, destination)).rejects.toThrow(
      "Backup destination already exists",
    );
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

  it("retires a revision 1 manager claim when the adapter revision moves to 2", async () => {
    const directory = await mkdtemp(join(tmpdir(), "signer-sidekick-claim-revision-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "sidekick.sqlite");
    const initial = await openSidekickStore(path, observedAt);
    initial.store.close();

    // Rewind past the supersession migration and plant the kind of job a revision 1 deployment
    // would be holding: an approved claim whose sealed plan carries an empty bond-periods argument
    // and a no-bond roster digest, neither of which revision 2 can reproduce.
    const rewound = new DatabaseSync(path);
    rewound.exec(`
      INSERT INTO transaction_jobs (
        job_id, idempotency_key, operation_scope_key, adapter_id, adapter_revision,
        manager_principal, intent_sha256, policy_sha256, intent_json, policy_json,
        chain_anchor_json, attestation_issuer, attestation_revision,
        attestation_payload_sha256, state, state_version, created_at, updated_at
      ) VALUES (
        'legacy-job', 'legacy-key', 'legacy-scope', 'reference-manager-claim-rewards', 1,
        'SP000000000000000000002Q6VF78.signer-manager', '${"aa".repeat(32)}', '${"bb".repeat(32)}',
        '{"noBondEvidenceSha256":"${"cc".repeat(32)}","bondPeriods":[]}', '{}',
        '{}', 'stacks-labs', 1, '${"dd".repeat(32)}',
        'awaiting_approval', 3, '${observedAt}', '${observedAt}'
      );
      ALTER TABLE stakers DROP COLUMN bond_node_verified;
      ALTER TABLE stakers DROP COLUMN bond_index;
      ALTER TABLE stakers DROP COLUMN bond_amount_ustx;
      ALTER TABLE stakers DROP COLUMN bond_amount_sats;
      ALTER TABLE stakers DROP COLUMN bond_is_l1_lock;
      DROP TABLE observer_deliveries;
      DROP TABLE deployment_identity;
      DELETE FROM schema_migrations WHERE version >= 19;
      PRAGMA user_version = 18;
    `);
    rewound.close();

    const upgraded = await openSidekickStore(path, later);
    openStores.push(upgraded.store);
    expect(upgraded.store.databaseStatus().schemaVersion).toBe(24);

    const inspection = new DatabaseSync(path, { readOnly: true });
    const job = inspection
      .prepare(
        "SELECT state, supersession_reason, state_version FROM transaction_jobs WHERE job_id = ?",
      )
      .get("legacy-job") as
      | { state: string; supersession_reason: string | null; state_version: number }
      | undefined;
    inspection.close();

    // It must be retired outright rather than left to fail deep inside a revalidation path.
    expect(job).toMatchObject({ state: "superseded", state_version: 4 });
    expect(job?.supersession_reason).toContain("revision 1");
  });

  it("leaves a settled revision 1 manager claim alone", async () => {
    const directory = await mkdtemp(join(tmpdir(), "signer-sidekick-claim-settled-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "sidekick.sqlite");
    const initial = await openSidekickStore(path, observedAt);
    initial.store.close();

    const rewound = new DatabaseSync(path);
    rewound.exec(`
      INSERT INTO transaction_jobs (
        job_id, idempotency_key, operation_scope_key, adapter_id, adapter_revision,
        manager_principal, intent_sha256, policy_sha256, intent_json, policy_json,
        chain_anchor_json, attestation_issuer, attestation_revision,
        attestation_payload_sha256, state, state_version, created_at, updated_at
      ) VALUES (
        'settled-job', 'settled-key', 'settled-scope', 'reference-manager-claim-rewards', 1,
        'SP000000000000000000002Q6VF78.signer-manager', '${"aa".repeat(32)}', '${"bb".repeat(32)}',
        '{}', '{}', '{}', 'stacks-labs', 1, '${"dd".repeat(32)}',
        'reconciled', 7, '${observedAt}', '${observedAt}'
      );
      ALTER TABLE stakers DROP COLUMN bond_node_verified;
      ALTER TABLE stakers DROP COLUMN bond_index;
      ALTER TABLE stakers DROP COLUMN bond_amount_ustx;
      ALTER TABLE stakers DROP COLUMN bond_amount_sats;
      ALTER TABLE stakers DROP COLUMN bond_is_l1_lock;
      DROP TABLE observer_deliveries;
      DROP TABLE deployment_identity;
      DELETE FROM schema_migrations WHERE version >= 19;
      PRAGMA user_version = 18;
    `);
    rewound.close();

    const upgraded = await openSidekickStore(path, later);
    openStores.push(upgraded.store);

    const inspection = new DatabaseSync(path, { readOnly: true });
    const job = inspection
      .prepare("SELECT state, state_version FROM transaction_jobs WHERE job_id = ?")
      .get("settled-job") as { state: string; state_version: number } | undefined;
    inspection.close();

    // A settled claim is history: nothing reads its sealed plan to act on it again.
    expect(job).toMatchObject({ state: "reconciled", state_version: 7 });
  });
});
