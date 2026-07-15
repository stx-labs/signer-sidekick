import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  backupSidekickDatabase,
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
const authoritativeProvenance = {
  classification: "authoritative" as const,
  contractSource: "pox5-read-only" as const,
  localRosterSource: "api-indexed-node-verified" as const,
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
      schemaVersion: 10,
      journalMode: "memory",
      foreignKeys: true,
    });
  });

  it("persists redacted runtime settings history and resumable onboarding state", async () => {
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

    store.putOnboardingState({
      path: "fresh",
      currentStep: "deploy-manager",
      status: "in-progress",
      state: { schemaVersion: 1, managerPrincipal: manager },
      updatedAt: later,
      auditAction: "fresh-prepared",
    });
    expect(store.getOnboardingState()).toEqual({
      path: "fresh",
      currentStep: "deploy-manager",
      status: "in-progress",
      state: { schemaVersion: 1, managerPrincipal: manager },
      updatedAt: later,
    });
    expect(store.listOnboardingAudit()).toEqual([
      {
        action: "fresh-prepared",
        path: "fresh",
        currentStep: "deploy-manager",
        status: "in-progress",
        changedAt: later,
      },
    ]);

    store.setOnboardingWizardDismissed(true, later);
    expect(store.getOnboardingWizardPreference()).toEqual({
      dismissedAt: later,
      updatedAt: later,
    });
    store.setOnboardingWizardDismissed(false, "2026-07-15T13:00:00.000Z");
    expect(store.getOnboardingWizardPreference()).toEqual({
      dismissedAt: null,
      updatedAt: "2026-07-15T13:00:00.000Z",
    });
    expect(store.listOnboardingWizardAudit()).toEqual([
      { action: "resumed", changedAt: "2026-07-15T13:00:00.000Z" },
      { action: "dismissed", changedAt: later },
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
      global: {
        lastRewardComputeBurnHeight: "960200",
        lastComputedRewardCycle: "140",
        rewardsPerToken: "42",
        signerEarnedBeforeManagerClaimSats: "0",
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
      schemaVersion: 10,
      journalMode: "wal",
    });
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
});
