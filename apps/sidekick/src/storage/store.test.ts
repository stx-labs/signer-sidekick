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

const observedAt = "2026-07-14T12:00:00.000Z";
const later = "2026-07-14T12:01:00.000Z";
const txId = `0x${"11".repeat(32)}`;
const blockHash = `0x${"22".repeat(32)}`;
const indexBlockHash = `0x${"33".repeat(32)}`;
const sourceId = createChainSourceId("mainnet", "https://api.mainnet.hiro.so");
const nodeSourceId = createNodeSourceId("mainnet", "http://127.0.0.1:20443");
const manager = "SP000000000000000000002Q6VF78.signer-manager";
const pox5 = "SP000000000000000000002Q6VF78.pox-5";
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
  store.chainState.upsertSource({
    sourceId: id,
    kind: "api",
    network: "mainnet",
    baseUrl: "https://api.mainnet.hiro.so",
    observedAt,
  });
}

function registerNodeSource(store: SidekickStore): void {
  store.chainState.upsertSource({
    sourceId: nodeSourceId,
    kind: "node",
    network: "mainnet",
    baseUrl: "http://127.0.0.1:20443",
    observedAt,
  });
}

function revertMigration14(database: DatabaseSync): void {
  database.exec(`
    DROP TABLE gas_wallet_sweeps;
    DROP TABLE gas_wallet_banners;
    DROP TABLE gas_wallet;
    DROP TABLE runtime_api_credentials;
    DROP TABLE current_member_history_recovery;
    ALTER TABLE chain_events DROP COLUMN occurred_at;
    ALTER TABLE chain_events DROP COLUMN evidence_level;
    ALTER TABLE reward_calculation_realizations DROP COLUMN evidence_level;
    DROP TABLE local_node_authority;
    DROP TABLE health_finding_episodes;
    DROP TABLE health_rollups;
    DROP TABLE health_observations;
    DROP TABLE reward_calculation_realizations;
    DROP TABLE reward_outlook_observations;
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
    expect(store.deploymentIdentity.get()).toBeNull();

    const bound = store.deploymentIdentity.bind({
      network: "mainnet",
      networkId: 1,
      parentNetworkId: 0,
      managerPrincipal: manager,
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
      boundAt: observedAt,
      lastVerifiedAt: observedAt,
    });

    expect(
      store.deploymentIdentity.recordVerification({
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
      store.deploymentIdentity.recordVerification({
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
      store.deploymentIdentity.bind({
        network: "mainnet",
        networkId: 1,
        parentNetworkId: 0,
        managerPrincipal: manager,
        verifiedAt: later,
        stacksTipHeight: 8_600_010,
        burnBlockHeight: 960_241,
        pox5ContractId: "SP000000000000000000002Q6VF78.pox-5",
      }),
    ).toThrow("already bound");
  });

  it("persists local-node authority independently for each manager", async () => {
    const store = await memoryStore();
    expect(store.deploymentIdentity.getLocalNodeAuthority(manager)).toBeNull();

    const authority = store.deploymentIdentity.putLocalNodeAuthority(manager, {
      schemaVersion: 1,
      status: "current",
      observedAt,
      stacksTipHeight: 8_600_000,
      highestProvenCurrentStacksTipHeight: 8_600_000,
      consecutiveCurrentObservations: 2,
      reason: "The local node is current.",
    });
    expect(authority).toEqual(store.deploymentIdentity.getLocalNodeAuthority(manager));

    expect(
      store.deploymentIdentity.putLocalNodeAuthority(manager, {
        ...authority,
        status: "catching-up",
        observedAt: later,
        stacksTipHeight: 8_599_000,
        consecutiveCurrentObservations: 0,
        reason: "The local node is catching up.",
      }),
    ).toMatchObject({
      status: "catching-up",
      highestProvenCurrentStacksTipHeight: 8_600_000,
      consecutiveCurrentObservations: 0,
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
    expect(store.managerTrust.record(base)).toBeNull();
    expect(
      store.managerTrust.record({ ...base, observedAt: "2026-07-16T12:01:00.000Z" }),
    ).toBeNull();
    expect(
      store.managerTrust.record({
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
      store.managerTrust.record({
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
      store.managerTrust.record({
        ...base,
        eligibilityReason: "Installed profile is unavailable",
        observedAt: "2026-07-16T12:04:00.000Z",
      }),
    ).toMatchObject({ transition: "lost", currentTier: "unrecognized" });
    expect(store.managerTrust.listAudit(base.managerPrincipal)).toMatchObject([
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
      store.managerTrust.record({
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
      store.managerTrust.record({
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
      store.managerTrust.record({
        ...base,
        managerPrincipal: unapprovedManager,
        eligibilityReason: "Installed profile was removed",
        observedAt: "2026-07-16T12:05:00.000Z",
      }),
    ).toMatchObject({ transition: "degraded", previousTier: "reference-render" });
    expect(store.managerTrust.listAudit(unapprovedManager)).toMatchObject([
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
      schemaVersion: 36,
      journalMode: "memory",
      synchronous: 1,
      foreignKeys: true,
    });
  });

  it("moves the legacy indexed API key into origin-bound source storage", async () => {
    const directory = await mkdtemp(join(tmpdir(), "signer-sidekick-v33-credentials-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "sidekick.sqlite");
    createDatabaseThroughMigration(path, 33).close();
    const legacy = new DatabaseSync(path);
    legacy
      .prepare(
        `INSERT INTO runtime_settings (
          singleton_id, settings_json, api_key_secret, revision, updated_at
        ) VALUES (1, ?, ?, 1, ?)`,
      )
      .run(
        JSON.stringify({
          schemaVersion: 1,
          dataSources: { apiUrl: "https://api.mainnet.hiro.so" },
        }),
        "legacy-secret",
        observedAt,
      );
    legacy.close();

    const upgraded = await openSidekickStore(path, later);
    openStores.push(upgraded.store);
    expect(upgraded.store.runtimeSettings.get()?.apiCredentials).toEqual({
      "indexed-api": {
        value: "legacy-secret",
        boundUrl: "https://api.mainnet.hiro.so",
      },
    });
    const inspection = new DatabaseSync(path, { readOnly: true });
    expect(
      inspection
        .prepare("SELECT api_key_secret FROM runtime_settings WHERE singleton_id = 1")
        .get(),
    ).toEqual({ api_key_secret: null });
    inspection.close();
  });

  it("persists redacted runtime settings history", async () => {
    const store = await memoryStore();
    store.runtimeSettings.put({
      settings: { schemaVersion: 1, displayName: "Test pool" },
      apiCredentials: {
        "indexed-api": {
          value: "must-not-appear-in-settings-json",
          boundUrl: "https://api.mainnet.hiro.so",
        },
      },
      changedFields: ["pool.displayName", "dataSources.apiKey"],
      observedAt,
    });
    const runtime = store.runtimeSettings.get();
    expect(runtime).toMatchObject({ revision: 1, settings: { displayName: "Test pool" } });
    expect(JSON.stringify(runtime?.settings)).not.toContain("must-not-appear");
    expect(runtime?.apiCredentials["indexed-api"]).toEqual({
      value: "must-not-appear-in-settings-json",
      boundUrl: "https://api.mainnet.hiro.so",
    });
    expect(store.runtimeSettings.listAudit()).toEqual([
      {
        revision: 1,
        changedFields: ["dataSources.apiKey", "pool.displayName"],
        changedAt: observedAt,
      },
    ]);
    expect(store.runtimeSettings.getAudit(1)).toEqual({
      revision: 1,
      changedFields: ["dataSources.apiKey", "pool.displayName"],
      changedAt: observedAt,
    });
    expect(store.runtimeSettings.getAudit(2)).toBeNull();
  });

  it("keeps durable cursors isolated by API source identity", async () => {
    const store = await memoryStore();
    const otherSource = createChainSourceId("mainnet", "https://stacks-api.example.com/");
    registerSource(store);
    store.chainState.upsertSource({
      sourceId: otherSource,
      kind: "api",
      network: "mainnet",
      baseUrl: "https://stacks-api.example.com",
      observedAt,
    });
    store.chainState.putCursor({
      sourceId,
      stream: `signer-stakers:${txId}`,
      cursor: "SP000000000000000000002Q6VF78",
      lastBlockHeight: 8_600_000,
      lastIndexBlockHash: indexBlockHash,
      updatedAt: observedAt,
    });

    expect(store.chainState.getCursor(sourceId, `signer-stakers:${txId}`)).toMatchObject({
      cursor: "SP000000000000000000002Q6VF78",
      lastBlockHeight: 8_600_000,
    });
    expect(store.chainState.getCursor(otherSource, `signer-stakers:${txId}`)).toBeNull();
    expect(createChainSourceId("mainnet", "https://api.mainnet.hiro.so/")).toBe(sourceId);
  });

  it("does not allow a source ID to be rebound to a different provider", async () => {
    const store = await memoryStore();
    registerSource(store);

    expect(() =>
      store.chainState.upsertSource({
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
    const occurredAt = "2026-07-14T11:58:00.000Z";
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
      occurredAt,
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
      occurredAt,
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
    const activityEvents = store.listManagerActivityChainEvents(1, manager);
    expect(activityEvents).toHaveLength(2);
    expect(activityEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ txId, decodedSchemaVersion: 1, canonical: true }),
      ]),
    );
    for (const event of activityEvents) {
      expect(event).not.toHaveProperty("rawPayload");
      expect(event).not.toHaveProperty("blockHash");
      expect(event).not.toHaveProperty("sourceId");
    }
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

  it("coalesces same-state outlook refreshes while preserving a same-block calculation boundary", async () => {
    const store = await memoryStore();
    const observation = (globalAccruedRewardsSats: string, observedAt: string) => ({
      managerPrincipal: manager,
      pox5ContractId: pox5,
      observedAt,
      chainAnchor,
      globalAccruedRewardsSats,
      calculationState: "completed" as const,
      lastRewardComputeBurnHeight: "959190",
      poolEstimate: null,
      poolEstimateUnavailableReason: "anchored-inputs-unavailable" as const,
      forecast: null,
      forecastUnavailableReason: "current-pool-estimate-unavailable" as const,
      nextCalculation: {
        state: "scheduled" as const,
        targetRewardCycle: 141,
        targetCheckpoint: "first-half" as const,
        calculationBurnHeight: 960_240,
        eligibleBurnHeight: 960_241,
        blocksRemaining: 1,
      },
    });
    store.putRewardOutlookObservation(observation("100", observedAt));
    store.putRewardOutlookObservation(observation("200", later));
    // A late refresh from the same burn block cannot replace newer anchored evidence.
    store.putRewardOutlookObservation(observation("50", observedAt));

    const nextAnchor = {
      ...chainAnchor,
      burnBlockHeight: chainAnchor.burnBlockHeight + 1,
      stacksBlockHeight: chainAnchor.stacksBlockHeight + 1,
      indexBlockHash: `0x${"44".repeat(32)}`,
      cyclePosition: chainAnchor.cyclePosition + 1,
      checkpoint: "second-half" as const,
    };
    store.putRewardOutlookObservation({
      ...observation("300", "2026-07-14T12:02:00.000Z"),
      chainAnchor: nextAnchor,
      calculationState: "pending",
      nextCalculation: {
        state: "due",
        targetRewardCycle: 141,
        targetCheckpoint: "first-half",
        calculationBurnHeight: 960_240,
        eligibleBurnHeight: 960_241,
        blocksRemaining: 0,
      },
    });
    store.putRewardOutlookObservation({
      ...observation("0", "2026-07-14T12:03:00.000Z"),
      chainAnchor: nextAnchor,
      lastRewardComputeBurnHeight: "960240",
      nextCalculation: {
        state: "scheduled",
        targetRewardCycle: 141,
        targetCheckpoint: "second-half",
        calculationBurnHeight: 961_290,
        eligibleBurnHeight: 961_291,
        blocksRemaining: 1_050,
      },
    });

    expect(store.listRewardOutlookObservations(manager, pox5)).toMatchObject({
      total: 3,
      items: [
        {
          chainAnchor: nextAnchor,
          globalAccruedRewardsSats: "0",
          calculationState: "completed",
          nextCalculation: { blocksRemaining: 1_050 },
        },
        {
          chainAnchor: nextAnchor,
          globalAccruedRewardsSats: "300",
          calculationState: "pending",
          nextCalculation: { state: "due", blocksRemaining: 0 },
        },
        {
          chainAnchor,
          globalAccruedRewardsSats: "200",
          observedAt: later,
        },
      ],
    });
    expect(
      store.listRewardOutlookObservations(manager, pox5, { direction: "asc", limit: 1 }),
    ).toMatchObject({
      total: 3,
      items: [{ globalAccruedRewardsSats: "200" }],
    });
    expect(
      store.listRewardForecastSamples(manager, pox5, {
        lastRewardComputeBurnHeight: "959190",
        targetRewardCycle: 141,
        targetCheckpoint: "first-half",
        calculationBurnHeight: 960_240,
        throughBurnBlockHeight: 960_240,
      }),
    ).toEqual([
      {
        observedBurnBlockHeight: 960_240,
        observedAt: later,
        globalAccruedRewardsSats: "200",
        lastRewardComputeBurnHeight: "959190",
        nextCalculation: {
          targetRewardCycle: 141,
          targetCheckpoint: "first-half",
          calculationBurnHeight: 960_240,
        },
      },
    ]);
  });

  it("persists the anchored current-share pool estimate with its accrual observation", async () => {
    const store = await memoryStore();
    store.putRewardOutlookObservation({
      managerPrincipal: manager,
      pox5ContractId: pox5,
      observedAt,
      chainAnchor,
      globalAccruedRewardsSats: "100",
      calculationState: "completed",
      lastRewardComputeBurnHeight: "959190",
      nextCalculation: {
        state: "scheduled",
        targetRewardCycle: 141,
        targetCheckpoint: "first-half",
        calculationBurnHeight: 960_240,
        eligibleBurnHeight: 960_241,
        blocksRemaining: 1,
      },
      poolEstimate: {
        kind: "if-calculated-now",
        targetRewardCycle: 141,
        targetCheckpoint: "first-half",
        calculationBurnHeight: 960_240,
        grossSats: "90",
        stxSats: "80",
        bondSats: "10",
        inputs: {
          globalStxSharesUstx: "100000000000",
          managerStxSharesUstx: "50000000000",
          activeBonds: [
            {
              bondIndex: "2",
              targetRateBips: "500",
              globalSharesSats: "100000",
              managerSharesSats: "50000",
            },
          ],
        },
        assumptions: [
          "current-global-accrual",
          "current-cycle-shares",
          "current-active-bond-set",
          "contract-integer-rounding",
        ],
      },
      poolEstimateUnavailableReason: null,
      forecast: {
        kind: "checkpoint-run-rate",
        targetRewardCycle: 141,
        targetCheckpoint: "first-half",
        calculationBurnHeight: 960_240,
        globalSats: { low: "100", point: "110", high: "120" },
        poolSats: { low: "90", point: "99", high: "108" },
        sample: {
          observations: 3,
          firstObservedBurnHeight: 960_230,
          lastObservedBurnHeight: 960_240,
          sampleBlocks: 10,
          elapsedBlocks: 1_050,
          remainingBlocks: 0,
        },
        confidence: "low",
        assumptions: [
          "zero-accrual-after-last-calculation",
          "linear-global-accrual-run-rate",
          "current-cycle-shares",
          "current-active-bond-set",
          "unchanged-reserve-before-calculation",
          "contract-integer-rounding",
        ],
      },
      forecastModelRevision: 1,
      forecastUnavailableReason: null,
    });

    expect(store.listRewardOutlookObservations(manager, pox5).items[0]).toMatchObject({
      globalAccruedRewardsSats: "100",
      poolEstimateUnavailableReason: null,
      poolEstimate: {
        grossSats: "90",
        inputs: { activeBonds: [{ bondIndex: "2" }] },
      },
      forecastUnavailableReason: null,
      forecastModelRevision: 1,
      forecast: {
        globalSats: { low: "100", point: "110", high: "120" },
        poolSats: { low: "90", point: "99", high: "108" },
      },
    });
  });

  it("persists a first-calculation forecast measured over its observed sample window", async () => {
    const store = await memoryStore();
    store.putRewardOutlookObservation({
      managerPrincipal: manager,
      pox5ContractId: pox5,
      observedAt,
      chainAnchor,
      globalAccruedRewardsSats: "100",
      calculationState: "completed",
      lastRewardComputeBurnHeight: "0",
      nextCalculation: {
        state: "scheduled",
        targetRewardCycle: 141,
        targetCheckpoint: "first-half",
        calculationBurnHeight: 960_300,
        eligibleBurnHeight: 960_301,
        blocksRemaining: 61,
      },
      poolEstimate: null,
      poolEstimateUnavailableReason: "anchored-inputs-unavailable",
      forecast: {
        kind: "checkpoint-run-rate",
        targetRewardCycle: 141,
        targetCheckpoint: "first-half",
        calculationBurnHeight: 960_300,
        globalSats: { low: "100", point: "110", high: "120" },
        poolSats: { low: "90", point: "99", high: "108" },
        sample: {
          observations: 3,
          firstObservedBurnHeight: 960_216,
          lastObservedBurnHeight: 960_240,
          sampleBlocks: 24,
          elapsedBlocks: 24,
          remainingBlocks: 60,
        },
        confidence: "low",
        assumptions: [
          "observed-accrual-sample-window",
          "linear-global-accrual-run-rate",
          "current-cycle-shares",
          "current-active-bond-set",
          "unchanged-reserve-before-calculation",
          "contract-integer-rounding",
        ],
      },
      forecastModelRevision: 1,
      forecastUnavailableReason: null,
    });

    expect(store.listRewardOutlookObservations(manager, pox5).items[0]).toMatchObject({
      lastRewardComputeBurnHeight: "0",
      forecast: {
        sample: { sampleBlocks: 24, elapsedBlocks: 24 },
        assumptions: expect.arrayContaining(["observed-accrual-sample-window"]),
      },
    });
  });

  it("persists canonical reward realizations with their fixed-horizon evaluation", async () => {
    const store = await memoryStore();
    registerSource(store);
    store.putRewardCalculationRealization({
      chainId: 1,
      txId,
      eventIndex: 4,
      sourceId,
      managerPrincipal: manager,
      pox5ContractId: pox5,
      canonical: true,
      evidenceLevel: "node-index-verified",
      blockHeight: 8_600_001,
      indexBlockHash,
      burnBlockHeight: 960_241,
      targetRewardCycle: 141,
      targetCheckpoint: "first-half",
      calculationBurnHeight: 960_240,
      event: {
        kind: "calculate-rewards",
        topic: "calculate-rewards",
        bondPeriods: [],
        calculationBurnHeight: "960240",
        grossAccruedRewardsSats: "100",
        totalBondRewardsSats: "0",
        reserveDepositSats: "5",
        reserveBalanceSats: "10",
        rewardCycle: "141",
        totalStxStakerRewardsSats: "95",
        cycleStakedUstx: "1000",
        accruedRewardsPerUstx: "95000000000000000",
        cumulativeRewardsPerUstx: "95000000000000000",
      },
      poolEstimate: {
        kind: "if-calculated-now",
        targetRewardCycle: 141,
        targetCheckpoint: "first-half",
        calculationBurnHeight: 960_240,
        grossSats: "90",
        stxSats: "90",
        bondSats: "0",
        inputs: {
          globalStxSharesUstx: "1000",
          managerStxSharesUstx: "950",
          activeBonds: [],
        },
        assumptions: [
          "current-global-accrual",
          "current-cycle-shares",
          "current-active-bond-set",
          "contract-integer-rounding",
        ],
      },
      poolEstimateUnavailableReason: null,
      modelRevision: 1,
      evaluation: {
        modelRevision: 1,
        forecastObservedBurnHeight: 960_096,
        calculationBurnHeight: 960_240,
        targetRewardCycle: 141,
        targetCheckpoint: "first-half",
        globalSats: { low: "90", point: "100", high: "110" },
        poolSats: { low: "80", point: "100", high: "110" },
        actualPoolSats: "90",
        leadBlocks: 144,
        pointErrorSats: "10",
        pointErrorBips: "1112",
        rangeContainsActual: true,
        rangeWidthBips: "3000",
      },
      observedAt,
    });

    expect(store.listRewardCalculationRealizations(manager, pox5)).toMatchObject([
      {
        canonical: true,
        targetRewardCycle: 141,
        poolEstimate: { grossSats: "90" },
        evaluation: { leadBlocks: 144, rangeContainsActual: true },
      },
    ]);
    expect(
      store.markRewardRealizationNoncanonical({
        chainId: 1,
        txId,
        eventIndex: 4,
        updatedAt: later,
      }),
    ).toBe(true);
    expect(store.listRewardCalculationRealizations(manager, pox5)).toEqual([]);
    expect(
      store.listRewardCalculationRealizations(manager, pox5, { canonicalOnly: false }),
    ).toMatchObject([{ canonical: false, updatedAt: later }]);
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

    expect(
      store.ensureCurrentMemberHistoryRecovery({
        sourceId,
        managerPrincipal: manager,
        pox5ContractId: pox5,
        stakerPrincipals: [stakerOne, stakerTwo, stakerOne],
        observedAt,
      }),
    ).toBe(2);
    expect(store.nextCurrentMemberHistoryRecovery(sourceId, manager, pox5)).toMatchObject({
      stakerPrincipal: stakerOne,
      status: "pending",
      pagesProcessed: 0,
    });
    expect(
      store.recordCurrentMemberHistoryRecoveryPage({
        sourceId,
        managerPrincipal: manager,
        pox5ContractId: pox5,
        stakerPrincipal: stakerOne,
        nextCursor: "8500000:2147483647:0",
        transactionsInspected: 50,
        relevantEvents: 2,
        observedAt: later,
      }),
    ).toMatchObject({
      status: "pending",
      cursor: "8500000:2147483647:0",
      pagesProcessed: 1,
      transactionsInspected: 50,
      relevantEvents: 2,
    });
    expect(store.nextCurrentMemberHistoryRecovery(sourceId, manager, pox5)).toMatchObject({
      stakerPrincipal: stakerTwo,
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
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(result.backupPath as string)).mode & 0o777).toBe(0o600);
    expect(result.store.databaseStatus()).toMatchObject({
      schemaVersion: 36,
      journalMode: "wal",
      synchronous: 2,
    });
  });

  it("upgrades a persisted migration 13 database through the latest migration once", async () => {
    const directory = await mkdtemp(join(tmpdir(), "signer-sidekick-v13-upgrade-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "sidekick.sqlite");
    const initial = await openSidekickStore(path, observedAt);
    initial.store.runtimeSettings.put({
      settings: { schemaVersion: 1, displayName: "Preserved through forward migrations" },
      apiCredentials: {},
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
    expect(upgraded.store.databaseStatus().schemaVersion).toBe(36);
    expect(upgraded.store.runtimeSettings.get()?.settings).toMatchObject({
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

  it("requeues bounded current-member history when occurrence times need enrichment", async () => {
    const directory = await mkdtemp(join(tmpdir(), "signer-sidekick-v32-occurrence-upgrade-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "sidekick.sqlite");
    createDatabaseThroughMigration(path, 32).close();
    const existing = new DatabaseSync(path);
    existing
      .prepare(
        `INSERT INTO chain_sources (
          source_id, kind, network, base_url, created_at, last_seen_at
        ) VALUES (?, 'api', 'mainnet', 'https://api.mainnet.hiro.so', ?, ?)`,
      )
      .run(sourceId, observedAt, observedAt);
    existing
      .prepare(
        `INSERT INTO chain_events (
          chain_id, tx_id, event_index, block_height, block_hash, index_block_hash,
          microblock_hash, microblock_sequence, canonical, microblock_canonical,
          contract_id, topic, raw_payload_json, decoded_schema_version,
          decoded_payload_json, source_id, first_seen_at, updated_at, evidence_level
        ) VALUES (1, ?, 0, 8600000, ?, ?, NULL, NULL, 1, 1, ?, 'stake', '{}', 1, ?, ?, ?, ?,
          'node-index-verified')`,
      )
      .run(
        txId,
        blockHash,
        indexBlockHash,
        pox5,
        JSON.stringify({ event: { kind: "stake", stakerPrincipal: stakerOne } }),
        sourceId,
        observedAt,
        observedAt,
      );
    existing
      .prepare(
        `INSERT INTO current_member_history_recovery (
          source_id, manager_principal, pox5_contract_id, staker_principal, status, cursor,
          pages_processed, transactions_inspected, relevant_events, discovered_at, updated_at,
          completed_at
        ) VALUES (?, ?, ?, ?, 'complete', NULL, 3, 120, 1, ?, ?, ?)`,
      )
      .run(sourceId, manager, pox5, stakerOne, observedAt, later, later);
    existing.close();

    const upgraded = await openSidekickStore(path, later);
    openStores.push(upgraded.store);
    expect(upgraded.store.schemaVersion()).toBe(36);
    const inspection = new DatabaseSync(path, { readOnly: true });
    expect(
      inspection
        .prepare("SELECT name FROM pragma_table_info('chain_events') WHERE name = ?")
        .get("occurred_at"),
    ).toEqual({ name: "occurred_at" });
    expect(
      inspection
        .prepare(
          `SELECT status, cursor, pages_processed, transactions_inspected, relevant_events,
             completed_at
           FROM current_member_history_recovery
           WHERE source_id = ? AND manager_principal = ? AND pox5_contract_id = ?
             AND staker_principal = ?`,
        )
        .get(sourceId, manager, pox5, stakerOne),
    ).toEqual({
      status: "pending",
      cursor: null,
      pages_processed: 0,
      transactions_inspected: 0,
      relevant_events: 0,
      completed_at: null,
    });
    inspection.close();
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
      DROP TABLE gas_wallet_sweeps;
      DROP TABLE gas_wallet_banners;
      DROP TABLE gas_wallet;
      DROP TABLE current_member_history_recovery;
      DROP TABLE runtime_api_credentials;
      ALTER TABLE chain_events DROP COLUMN occurred_at;
      ALTER TABLE chain_events DROP COLUMN evidence_level;
      ALTER TABLE reward_calculation_realizations DROP COLUMN evidence_level;
      DROP TABLE local_node_authority;
      DROP TABLE health_finding_episodes;
      DROP TABLE health_rollups;
      DROP TABLE health_observations;
      DROP TABLE reward_calculation_realizations;
      DROP TABLE reward_outlook_observations;
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
    expect(upgraded.store.databaseStatus().schemaVersion).toBe(36);

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
    initial.store.managerTrust.record({
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
    initial.store.managerTrust.record({
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
    expect(upgraded.store.databaseStatus().schemaVersion).toBe(36);
    expect(upgraded.store.managerTrust.listAudit(principal)).toMatchObject([
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
    expect((await stat(destination)).mode & 0o777).toBe(0o600);
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
      DROP TABLE gas_wallet_sweeps;
      DROP TABLE gas_wallet_banners;
      DROP TABLE gas_wallet;
      DROP TABLE current_member_history_recovery;
      DROP TABLE runtime_api_credentials;
      ALTER TABLE chain_events DROP COLUMN occurred_at;
      ALTER TABLE chain_events DROP COLUMN evidence_level;
      ALTER TABLE reward_calculation_realizations DROP COLUMN evidence_level;
      DROP TABLE local_node_authority;
      DROP TABLE health_finding_episodes;
      DROP TABLE health_rollups;
      DROP TABLE health_observations;
      DROP TABLE reward_calculation_realizations;
      DROP TABLE reward_outlook_observations;
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
    expect(upgraded.store.databaseStatus().schemaVersion).toBe(36);

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
      DROP TABLE gas_wallet_sweeps;
      DROP TABLE gas_wallet_banners;
      DROP TABLE gas_wallet;
      DROP TABLE current_member_history_recovery;
      DROP TABLE runtime_api_credentials;
      ALTER TABLE chain_events DROP COLUMN occurred_at;
      ALTER TABLE chain_events DROP COLUMN evidence_level;
      ALTER TABLE reward_calculation_realizations DROP COLUMN evidence_level;
      DROP TABLE local_node_authority;
      DROP TABLE health_finding_episodes;
      DROP TABLE health_rollups;
      DROP TABLE health_observations;
      DROP TABLE reward_calculation_realizations;
      DROP TABLE reward_outlook_observations;
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

  it("keeps the newest reward evidence when a read limit truncates, returned oldest first", async () => {
    const store = await memoryStore();
    registerSource(store);
    const staker = "SP2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKNRV9EJ7";
    const baseEvent = {
      chainId: 1,
      eventIndex: 0,
      blockHash,
      indexBlockHash,
      microblockHash: null,
      microblockSequence: null,
      canonical: true,
      microblockCanonical: true,
      rawPayload: {},
      decodedSchemaVersion: 1,
      sourceId,
      observedAt,
    } as const;
    for (const [index, blockHeight] of [30, 10, 20].entries()) {
      store.putChainEvent({
        ...baseEvent,
        txId: `0x${String(index + 1)
          .padStart(2, "0")
          .repeat(32)}`,
        blockHeight,
        contractId: pox5,
        topic: "print",
        decodedPayload: {
          transactionStatus: "success",
          event: {
            kind: "claim-staker-rewards-for-signer",
            signerManager: manager,
            stakerPrincipal: staker,
            rewardCycle: "140",
            bondIndex: null,
            rewardsClaimedSats: String(blockHeight),
          },
        },
      });
      store.putChainEvent({
        ...baseEvent,
        txId: `0x${String(index + 4)
          .padStart(2, "0")
          .repeat(32)}`,
        blockHeight,
        contractId: manager,
        topic: "claim-staker-rewards",
        decodedPayload: {
          transactionStatus: "success",
          event: {
            kind: "claim-staker-rewards",
            stakerPrincipal: staker,
            rewardCycle: "140",
            bondIndex: null,
            amountSats: String(blockHeight),
            l1Withdrawal: null,
          },
        },
      });
    }

    expect(store.listPox5RewardPrints(1, pox5, manager).map((row) => row.blockHeight)).toEqual([
      10, 20, 30,
    ]);
    expect(
      store.listPox5RewardPrints(1, pox5, manager, { limit: 2 }).map((row) => row.blockHeight),
    ).toEqual([20, 30]);
    expect(store.listManagerClaimRecords(1, manager).map((row) => row.blockHeight)).toEqual([
      10, 20, 30,
    ]);
    expect(store.listManagerClaimRecords(1, manager, 2).map((row) => row.blockHeight)).toEqual([
      20, 30,
    ]);
  });
});
